import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { AIMessage, type BaseMessageLike } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  IntentSchema,
  PlanningSchema,
  type AgentOutput,
  type PlanDecision,
} from './agent.schema';
import {
  CLASSIFY_PROMPT,
  PLANNING_PROMPT,
  CODING_DECISIONS_PROMPT,
  CHAT_PROMPT,
  buildSystemPrompt,
} from '../helper/agent.prompts';
import { createTools } from '../tools';
import { Mode } from '../dto';
import type { AgentStateType } from './agent.state';
import { runToolCallLoop } from './agent.tool-loop';

/** 图节点的具体实现。所有节点共用同一个 model 实例和 ConfigService（读取 cwd/mode 等配置）。 */
export class AgentNodes {
  constructor(
    private readonly model: ChatOpenAI,
    private readonly config: ConfigService,
  ) {}

  /** 节点 1：意图判断 */
  async classifyNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const result = await this.classifyIntent(state.input);
    return { intent: result.intent, reason: result.reason };
  }

  async classifyIntent(input: string) {
    // deepseek 需显式用工具调用，否则默认 jsonSchema 不被支持
    const structuredModel = this.model.withStructuredOutput(
      IntentSchema,
      {
        method: 'functionCalling',
        name: 'classify_intent',
        includeRaw: true,
      },
    );

    const { raw, parsed: result } = await structuredModel.invoke([
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: input },
    ]);

    if (AIMessage.isInstance(raw)) {
      console.log('classify_intent', raw.usage_metadata);
    }

    return result;
  }

  /**
   * 节点 2a：执行 planning 意图 —— 只负责 LLM 生成实现方式选择题并写入 state。
   * interrupt 放在独立的 askUser 节点里，避免恢复时重跑这次 LLM 调用。
   */
  async planningNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    // 必须显式指定 functionCalling：deepseek 不是 gpt 系列，withStructuredOutput
    // 会默认走 jsonSchema（response_format: json_schema），但 deepseek 不支持该模式、
    // 会忽略约束返回 markdown 长文导致 JSON 解析失败。工具调用能可靠约束到 schema。
    const structuredModel = this.model.withStructuredOutput(
      PlanningSchema,
      {
        method: 'functionCalling',
        name: 'planning',
        includeRaw: true,
      },
    );

    const { raw, parsed: result } = await structuredModel.invoke([
      { role: 'system', content: PLANNING_PROMPT },
      { role: 'user', content: state.input },
    ]);

    if (AIMessage.isInstance(raw)) {
      console.log('planning', raw.usage_metadata);
    }

    return { plan: result };
  }

  /**
   * 节点 2a'：只做 interrupt() 暂停整张图，把选择题抛给前端。
   * /agent/decide 提交后从这里恢复（重跑本节点开销为零），
   * interrupt() 的返回值就是用户的决策，写入 state 传给 coding。
   */
  askUserNode(state: AgentStateType): Partial<AgentStateType> {
    const decisions = interrupt<AgentOutput, PlanDecision[]>({
      type: 'plan',
      ...state.plan!,
    });

    return { decisions };
  }

  /** 节点 2b：执行 coding 意图（若带用户决策，则作为硬性约束拼进 prompt） */
  async codingNode(
    state: AgentStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    // 获取工具（从环境变量或默认值读取 cwd 和 mode）
    const cwd = this.config.get<string>(
      'AGENT_CWD',
      '/Users/poet/Documents/mywork/study-agent/static/template',
    );
    const mode = this.config.get<string>('AGENT_MODE', Mode.build);
    // 标注为统一基类型 StructuredToolInterface[]：各工具 schema 不同，
    // 若保留 Object.values 推断出的联合类型，tool.invoke() 会因签名互不兼容而报 2349
    const tools: StructuredToolInterface[] = Object.values(
      createTools(cwd, mode as Mode),
    );

    // 绑定工具到模型
    const modelWithTools = this.model.bindTools(tools);

    // 用 LangChain 消息对象（而非纯 object 字面量）：assistant 消息必须带
    // tool_calls 字段，否则 OpenAI 兼容接口会拒绝紧随其后的 tool 消息，
    // 导致多轮工具调用失败。BaseMessageLike 允许下面混用两种写法。
    const messages: BaseMessageLike[] = [
      { role: 'system', content: buildSystemPrompt({ cwd, mode: Mode.build }) },
      { role: 'user', content: state.input },
    ];

    if (state.decisions?.length) {
      const systemMsg = messages[0] as { role: string; content: string };
      systemMsg.content +=
        CODING_DECISIONS_PROMPT + this.formatDecisions(state.decisions);
    }

    const response = await runToolCallLoop(
      modelWithTools,
      tools,
      messages,
      config,
      'coding',
    );
    console.log('工具调用')
    if(AIMessage.isInstance(response)) {
      
      console.log(response.usage_metadata)
    }

    // 最终返回 LLM 的文本内容
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
  async chatNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const response = await this.model.invoke([
      { role: 'system', content: CHAT_PROMPT },
      { role: 'user', content: state.input },
    ]);
    return { output: { type: 'text', content: response.content as string } };
  }

  /** 节点 3：统一收尾 —— coding / chat 执行完后都汇聚到这里做最终处理 */
  finalNode(state: AgentStateType): Partial<AgentStateType> {
    // 目前只做透传；后续可在此统一加日志、格式化输出、内容审查等收尾逻辑
    return { output: state.output };
  }
}
