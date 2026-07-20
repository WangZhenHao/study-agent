import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  StateGraph,
  Annotation,
  START,
  END,
  MemorySaver,
  interrupt,
  Command,
} from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const IntentSchema = z.object({
  intent: z
    .enum(['planning', 'coding', 'chat'])
    .describe(
      'Intent type: planning (需要设计/规划), coding (直接写代码), chat (普通对话)',
    ),
  reason: z.string().describe('判断原因的简短说明'),
});

// planning 意图的结构化输出：给前端渲染的「实现方式选择题」
const PlanOptionSchema = z.object({
  label: z.string().describe('选项名称，简短'),
  description: z.string().describe('该实现方式的说明和权衡'),
});

const PlanQuestionSchema = z.object({
  question: z.string().describe('需要用户决策的问题'),
  type: z
    .enum(['single', 'multiple'])
    .describe('single: 只能选一个（互斥方案）；multiple: 可以选多个'),
  options: z.array(PlanOptionSchema).min(2).describe('候选实现方式'),
  allowCustomInput: z
    .boolean()
    .describe('是否允许用户不选任何选项、手动输入自定义答案'),
});

const PlanningSchema = z.object({
  summary: z.string().describe('对用户需求的简短理解'),
  questions: z
    .array(PlanQuestionSchema)
    .min(1)
    .max(5)
    .describe('实现该需求前需要用户确认的决策点'),
});

export type PlanningResult = z.infer<typeof PlanningSchema>;

// 输出的判别联合：前端根据 type 决定渲染纯文本还是选择表单
export type AgentOutput =
  | { type: 'text'; content: string }
  | ({ type: 'plan' } & PlanningResult);

// 前端提交回来的用户决策：每个问题选了什么 / 手动输入了什么
export interface PlanDecision {
  question: string;
  // 选中的选项 label（单选时只有一个元素；纯手动输入时可为空）
  selected: string[];
  // allowCustomInput 时用户手动输入的内容
  customInput?: string;
}

// 图的状态：贯穿整个流程的数据，每个节点读取它并返回要更新的部分
const AgentState = Annotation.Root({
  // 用户输入
  input: Annotation<string>(),
  // 用户对 planning 决策点的选择（planning 中断恢复后写入，供 coding 使用）
  decisions: Annotation<PlanDecision[] | undefined>(),
  // 意图判断结果
  intent: Annotation<'planning' | 'coding' | 'chat'>(),
  reason: Annotation<string>(),
  // 意图执行后的最终输出
  output: Annotation<AgentOutput>(),
});

type AgentStateType = typeof AgentState.State;

@Injectable()
export class AgentService {
  private model: ChatOpenAI;
  private graph: ReturnType<AgentService['buildGraph']>;

  constructor(private readonly config: ConfigService) {
    const apiUrl = this.config.getOrThrow<string>('API_URL');
    const apiKey = this.config.getOrThrow<string>('API_KEY');

    this.model = new ChatOpenAI({
      model: 'deepseek-chat',
      apiKey: apiKey,
      configuration: {
        baseURL: apiUrl,
      },
      temperature: 0,
    });

    // 编译一次，后续每个请求复用
    this.graph = this.buildGraph();
  }

  /**
   * 组装流程图：用户输入 -> 意图判断 -> 意图执行 -> 输出
   *
   *              START
   *                |
   *             classify（意图判断）
   *           /    |     \
   *    planning  coding  chat（意图执行）
   *        |       |      /
   *        |  ⏸ interrupt：暂停，把选择题返回给前端
   *        |       |
   *        └─→ coding（恢复后，带用户决策继续本轮对话）
   *                |
   *               END
   *
   * planning 节点里用 interrupt() 暂停整张图，checkpointer 保存现场；
   * 前端提交决策后调用 /agent/decide，图从暂停处恢复，接着走 coding。
   */
  private buildGraph() {
    return new StateGraph(AgentState)
      .addNode('classify', (state) => this.classifyNode(state))
      .addNode('planning', (state) => this.planningNode(state))
      .addNode('coding', (state) => this.codingNode(state))
      .addNode('chat', (state) => this.chatNode(state))
      .addEdge(START, 'classify')
      // 条件路由：根据意图判断结果，决定走哪个执行节点
      .addConditionalEdges('classify', (state) => state.intent, {
        planning: 'planning',
        coding: 'coding',
        chat: 'chat',
      })
      // planning 拿到用户决策（interrupt 恢复）后，接着走 coding
      .addEdge('planning', 'coding')
      .addEdge('coding', END)
      .addEdge('chat', END)
      // checkpointer：interrupt 暂停时保存现场，靠 thread_id 恢复
      .compile({ checkpointer: new MemorySaver() });
  }

  /** 开始一轮对话：意图判断 -> 意图执行；planning 会中断并返回选择题 */
  async run(input: string) {
    const threadId = randomUUID();
    const config = { configurable: { thread_id: threadId } };

    const result = await this.graph.invoke({ input }, config);
    return this.buildResponse(threadId, result, config);
  }

  /** 提交用户决策，从 planning 的中断处恢复，接着本轮对话继续走 coding */
  async decide(threadId: string, decisions: PlanDecision[]) {
    const config = { configurable: { thread_id: threadId } };

    const state = await this.graph.getState(config);
    if (!state.tasks.some((t) => t.interrupts.length > 0)) {
      throw new Error(`会话 ${threadId} 不存在或没有等待中的决策`);
    }

    const result = await this.graph.invoke(
      new Command({ resume: decisions }),
      config,
    );
    return this.buildResponse(threadId, result, config);
  }

  /** 统一组装响应：若图被 interrupt 暂停，则把中断携带的选择题作为输出 */
  private async buildResponse(
    threadId: string,
    result: AgentStateType & { __interrupt__?: { value: AgentOutput }[] },
    config: { configurable: { thread_id: string } },
  ) {
    const interrupted = result.__interrupt__?.[0];
    // interrupt 时 result 里只有 __interrupt__，意图等字段从 checkpoint 里取
    const snapshot = interrupted
      ? (await this.graph.getState(config)).values
      : result;

    return {
      threadId,
      // 是否在等待用户提交决策（前端据此决定是否展示表单并调用 /agent/decide）
      pending: Boolean(interrupted),
      intent: snapshot.intent,
      reason: snapshot.reason,
      output: interrupted ? interrupted.value : result.output,
    };
  }

  /** 节点 1：意图判断 */
  private async classifyNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    const result = await this.classifyIntent(state.input);
    return { intent: result.intent, reason: result.reason };
  }

  /**
   * 节点 2a：执行 planning 意图 —— 产出实现方式选择题，然后 interrupt 暂停整张图。
   * 前端提交决策、图恢复后，interrupt() 的返回值就是用户的决策，写入 state 传给 coding。
   */
  private async planningNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    const structuredModel = this.model.withStructuredOutput(PlanningSchema);

    const result = await structuredModel.invoke([
      {
        role: 'system',
        content: `你是一个架构规划助手。针对用户的需求，梳理出实现前需要用户确认的关键决策点，每个决策点给出候选实现方式，供前端渲染为选择表单。

规则：
1. 每个问题给出 2-4 个候选选项，说明各自的权衡
2. 互斥的方案（如"选哪种数据库"）用 single；可叠加的能力（如"需要哪些登录方式"）用 multiple
3. 开放性较强、选项无法穷举的问题，把 allowCustomInput 设为 true，允许用户手动输入
4. 只列真正需要用户决策的点，不超过 5 个`,
      },
      { role: 'user', content: state.input },
    ]);

    // 暂停：把选择题抛给前端；/agent/decide 提交后从这里继续，拿到用户决策
    const decisions = interrupt<AgentOutput, PlanDecision[]>({
      type: 'plan',
      ...result,
    });

    return { decisions };
  }

  /** 节点 2b：执行 coding 意图（若带用户决策，则作为硬性约束拼进 prompt） */
  private async codingNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    const messages: { role: 'system' | 'user'; content: string }[] = [
      {
        role: 'system',
        content:
          '你是一个编程助手。直接给出满足用户需求的代码实现，并附上简短的使用说明。',
      },
      { role: 'user', content: state.input },
    ];

    if (state.decisions?.length) {
      messages[0].content += `

用户已经对实现方式做出了以下决策，这些是硬性约束，必须严格遵循，不要提出替代方案：

${this.formatDecisions(state.decisions)}`;
    }

    const response = await this.model.invoke(messages);
    return { output: { type: 'text', content: response.content as string } };
  }

  /** 把用户决策格式化为 prompt 里的约束清单 */
  private formatDecisions(decisions: PlanDecision[]): string {
    return decisions
      .map((d, i) => {
        const parts: string[] = [];
        if (d.selected.length) {
          parts.push(`选择：${d.selected.join('、')}`);
        }
        if (d.customInput?.trim()) {
          parts.push(`补充说明：${d.customInput.trim()}`);
        }
        const answer = parts.length ? parts.join('；') : '（未选择）';
        return `${i + 1}. ${d.question}\n   ${answer}`;
      })
      .join('\n');
  }

  /** 节点 2c：执行 chat 意图 */
  private async chatNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    const response = await this.model.invoke([
      {
        role: 'system',
        content: '你是一个友好的聊天助手，用简洁自然的语气回复用户。',
      },
      { role: 'user', content: state.input },
    ]);
    return { output: { type: 'text', content: response.content as string } };
  }

  async classifyIntent(input: string) {
    const structuredModel = this.model.withStructuredOutput(IntentSchema);

    const systemPrompt = `你是一个意图分类助手。根据用户输入，判断用户的意图属于以下哪一类：

1. **planning（规划）**: 用户需要设计方案、架构规划、多步骤计划
   - 关键词：设计、规划、如何实现、方案、架构
   - 例子："帮我设计一个用户登录模块"、"如何实现分布式缓存"

2. **coding（写代码）**: 用户直接要求写代码、实现具体功能
   - 关键词：写、实现、创建、添加（具体功能）
   - 例子："写一个排序算法"、"实现一个按钮组件"

3. **chat（聊天）**: 普通对话、问候、闲聊、非技术问题
   - 关键词：你好、谢谢、天气、怎么样
   - 例子："你好"、"今天天气怎么样"

请根据用户输入，返回最合适的意图类型和判断原因。`;

    const result = await structuredModel.invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ]);

    return result;
  }
}
