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
import {
  IntentSchema,
  PlanningSchema,
  type PlanningResult,
  type AgentOutput,
  type PlanDecision,
} from './agent.schema';
import {
  CLASSIFY_PROMPT,
  PLANNING_PROMPT,
  CODING_PROMPT,
  CODING_DECISIONS_PROMPT,
  CHAT_PROMPT,
} from './agent.prompts';

export type { PlanningResult, AgentOutput, PlanDecision };

// SSE 流式事件：前端根据 type 增量渲染
export type AgentStreamEvent =
  // 流开始：告知 threadId（decide 时前端已有，run 时必须拿到它才能后续提交决策）
  | { type: 'start'; threadId: string }
  // 某个节点执行完毕（可用于渲染进度条/步骤条）
  | { type: 'node'; node: string; intent?: string; reason?: string }
  // LLM 增量 token（coding / chat 的正文逐字输出）
  | { type: 'token'; node: string; content: string }
  // planning 中断：把选择题抛给前端，等待 /agent/decide/stream
  | { type: 'plan'; output: AgentOutput }
  // 流结束：带最终输出（interrupt 暂停时 pending=true 且无 output）
  | { type: 'done'; pending: boolean; output?: AgentOutput }
  | { type: 'error'; message: string };

// 图的状态：贯穿整个流程的数据，每个节点读取它并返回要更新的部分
const AgentState = Annotation.Root({
  // 用户输入
  input: Annotation<string>(),
  // planning 生成的选择题（写入 state，askUser 节点从这里读取后 interrupt）
  plan: Annotation<PlanningResult | undefined>(),
  // 用户对 planning 决策点的选择（askUser 中断恢复后写入，供 coding 使用）
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
    const apiUrl = this.config.getOrThrow<string>('NEST_API_URL');
    const apiKey = this.config.getOrThrow<string>('NEST_API_KEY');

    this.model = new ChatOpenAI({
      model: 'deepseek-v4-flash',
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
   *        |       |      |
   *     askUser    |      |
   *  ⏸ interrupt：暂停，把选择题返回给前端
   *        |       |      |
   *        └─→ coding     |
   *                |      |
   *              final（统一收尾）
   *                |
   *               END
   *
   * planning 只负责 LLM 生成选择题并写入 state；askUser 只做 interrupt()。
   * 拆成两个节点是因为恢复时会从被中断节点的开头重跑：若 interrupt 和
   * LLM 调用在同一节点，/agent/decide 恢复时会白白重跑一次 LLM。
   * 前端提交决策后调用 /agent/decide，图从暂停处恢复，接着走 coding。
   */
  private buildGraph() {
    return new StateGraph(AgentState)
      .addNode('classify', (state) => this.classifyNode(state))
      .addNode('planning', (state) => this.planningNode(state))
      .addNode('askUser', (state) => this.askUserNode(state))
      .addNode('coding', (state) => this.codingNode(state))
      .addNode('chat', (state) => this.chatNode(state))
      .addNode('final', (state) => this.finalNode(state))
      .addEdge(START, 'classify')
      // 条件路由：根据意图判断结果，决定走哪个执行节点
      .addConditionalEdges('classify', (state) => state.intent, {
        planning: 'planning',
        coding: 'coding',
        chat: 'chat',
      })
      // planning 生成选择题后，交给 askUser 中断等待用户决策
      .addEdge('planning', 'askUser')
      // askUser 拿到用户决策（interrupt 恢复）后，接着走 coding
      .addEdge('askUser', 'coding')
      // coding / chat 执行完后，统一走 final 收尾
      .addEdge('coding', 'final')
      .addEdge('chat', 'final')
      .addEdge('final', END)
      // checkpointer：interrupt 暂停时保存现场，靠 thread_id 恢复
      .compile({ checkpointer: new MemorySaver() });
  }

  /** 开始一轮对话：意图判断 -> 意图执行；planning 会中断并返回选择题 */
  async run(input: string) {
    const threadId = randomUUID();
    const config = { configurable: { thread_id: threadId } };

    const result = await this.graph.invoke({ input }, config);
    // console.log(result)
    return this.buildResponse(threadId, result, config);
  }

  /** 流式开始一轮对话：SSE 逐事件推送（节点进度 + LLM token + 选择题/最终结果） */
  async *runStream(input: string): AsyncGenerator<AgentStreamEvent> {
    const threadId = randomUUID();
    yield { type: 'start', threadId };
    yield* this.streamGraph(threadId, { input });
  }

  /** 流式提交用户决策：从中断处恢复，SSE 推送 coding 的逐字输出 */
  async *decideStream(
    threadId: string,
    decisions: PlanDecision[],
  ): AsyncGenerator<AgentStreamEvent> {
    const config = { configurable: { thread_id: threadId } };
    const state = await this.graph.getState(config);
    if (!state.tasks.some((t) => t.interrupts.length > 0)) {
      throw new Error(`会话 ${threadId} 不存在或没有等待中的决策`);
    }

    yield { type: 'start', threadId };
    yield* this.streamGraph(threadId, new Command({ resume: decisions }));
  }

  /**
   * 执行图并把过程翻译成 SSE 事件。
   * 同时开两种流模式：
   * - updates：每个节点执行完推一次（节点进度、interrupt 选择题）
   * - messages：LLM 逐 token 推送（只透传 coding / chat 的正文，
   *   classify / planning 是结构化输出的中间 JSON，对用户无意义，不下发）
   */
  private async *streamGraph(
    threadId: string,
    graphInput: { input: string } | Command,
  ): AsyncGenerator<AgentStreamEvent> {
    const config = { configurable: { thread_id: threadId } };
    // 正文逐字下发的节点白名单
    const TOKEN_NODES = new Set(['coding', 'chat']);

    try {
      // Command 的泛型与图的节点名字面量不完全兼容，运行时行为一致，这里收窄给 TS
      const stream = await this.graph.stream(
        graphInput as { input: string },
        {
          ...config,
          streamMode: ['updates', 'messages'],
        },
      );

      let interrupted: AgentOutput | undefined;

      for await (const [mode, chunk] of stream) {
        if (mode === 'messages') {
          // chunk: [消息分片, 元数据]，元数据里带产生它的节点名
          const [message, meta] = chunk as unknown as [
            { content?: unknown },
            { langgraph_node?: string },
          ];
          const content = message.content;
          const node = meta?.langgraph_node ?? '';
          if (typeof content === 'string' && content && TOKEN_NODES.has(node)) {
            yield { type: 'token', node, content };
          }
        } else {
          // updates: { 节点名: 该节点返回的 state 更新 } 或 { __interrupt__: [...] }
          const update = chunk as Record<string, Partial<AgentStateType>> & {
            __interrupt__?: { value: AgentOutput }[];
          };
          if (update.__interrupt__) {
            interrupted = update.__interrupt__[0].value;
            yield { type: 'plan', output: interrupted };
            continue;
          }
          for (const [node, partial] of Object.entries(update) as [
            string,
            Partial<AgentStateType>,
          ][]) {
            yield {
              type: 'node',
              node,
              // classify 节点完成时顺带下发意图，前端可提示"正在写代码/规划中..."
              ...(node === 'classify'
                ? { intent: partial.intent, reason: partial.reason }
                : {}),
            };
          }
        }
      }

      if (interrupted) {
        // interrupt 暂停：等前端调 /agent/decide/stream
        yield { type: 'done', pending: true };
      } else {
        const snapshot = await this.graph.getState(config);
        yield { type: 'done', pending: false, output: snapshot.values.output };
      }
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
    }
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
   * 节点 2a：执行 planning 意图 —— 只负责 LLM 生成实现方式选择题并写入 state。
   * interrupt 放在独立的 askUser 节点里，避免恢复时重跑这次 LLM 调用。
   */
  private async planningNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    // 必须显式指定 functionCalling：deepseek 不是 gpt 系列，withStructuredOutput
    // 会默认走 jsonSchema（response_format: json_schema），但 deepseek 不支持该模式、
    // 会忽略约束返回 markdown 长文导致 JSON 解析失败。工具调用能可靠约束到 schema。
    const structuredModel = this.model.withStructuredOutput(PlanningSchema, {
      method: 'functionCalling',
      name: 'planning',
    });

    const result = await structuredModel.invoke([
      { role: 'system', content: PLANNING_PROMPT },
      { role: 'user', content: state.input },
    ]);

    return { plan: result };
  }

  /**
   * 节点 2a'：只做 interrupt() 暂停整张图，把选择题抛给前端。
   * /agent/decide 提交后从这里恢复（重跑本节点开销为零），
   * interrupt() 的返回值就是用户的决策，写入 state 传给 coding。
   */
  private askUserNode(state: AgentStateType): Partial<AgentStateType> {
    const decisions = interrupt<AgentOutput, PlanDecision[]>({
      type: 'plan',
      ...state.plan!,
    });

    return { decisions };
  }

  /** 节点 2b：执行 coding 意图（若带用户决策，则作为硬性约束拼进 prompt） */
  private async codingNode(
    state: AgentStateType,
  ): Promise<Partial<AgentStateType>> {
    const messages: { role: 'system' | 'user'; content: string }[] = [
      { role: 'system', content: CODING_PROMPT },
      { role: 'user', content: state.input },
    ];

    if (state.decisions?.length) {
      messages[0].content +=
        CODING_DECISIONS_PROMPT + this.formatDecisions(state.decisions);
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
      { role: 'system', content: CHAT_PROMPT },
      { role: 'user', content: state.input },
    ]);
    return { output: { type: 'text', content: response.content as string } };
  }

  /** 节点 3：统一收尾 —— coding / chat 执行完后都汇聚到这里做最终处理 */
  private finalNode(state: AgentStateType): Partial<AgentStateType> {
    // 目前只做透传；后续可在此统一加日志、格式化输出、内容审查等收尾逻辑
    return { output: state.output };
  }

  async classifyIntent(input: string) {
    // 同 planningNode：deepseek 需显式用工具调用，否则默认 jsonSchema 不被支持
    const structuredModel = this.model.withStructuredOutput(IntentSchema, {
      method: 'functionCalling',
      name: 'classify_intent',
    });

    const result = await structuredModel.invoke([
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: input },
    ]);

    return result;
  }
}
