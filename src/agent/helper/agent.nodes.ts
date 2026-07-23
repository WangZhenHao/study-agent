import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph';
import {
  AIMessage,
  ToolMessage,
  SystemMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
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
import { formatDecisions, truncateToolResult } from './agent.tool-loop';

// 最多允许的工具调用轮次，防止模型陷入死循环导致 messages 无限增长
export const MAX_TOOL_CALL_ROUNDS = 50;

/** 图节点的具体实现。所有节点共用同一个 model 实例和 ConfigService（读取 cwd/mode 等配置）。 */
export class AgentNodes {
  constructor(
    private readonly model: ChatOpenAI,
    private readonly config: ConfigService,
  ) {}

  /** 节点 1：意图判断 */
  async classifyNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    const result = await this.classifyIntent(state.input, config?.signal);
    return { intent: result.intent, reason: result.reason };
  }

  async classifyIntent(input: string, signal?: AbortSignal) {
    // deepseek 需显式用工具调用，否则默认 jsonSchema 不被支持
    const structuredModel = this.model.withStructuredOutput(IntentSchema, {
      method: 'functionCalling',
      name: 'classify_intent',
      includeRaw: true,
    });

    const { raw, parsed: result } = await structuredModel.invoke(
      [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: input },
      ],
      { signal },
    );

    if (AIMessage.isInstance(raw)) {
      console.log('classify_intent', raw.usage_metadata);
    }

    return result;
  }

  /**
   * 节点 2a：执行 planning 意图 —— 只负责 LLM 生成实现方式选择题并写入 state。
   * interrupt 放在独立的 askUser 节点里，避免恢复时重跑这次 LLM 调用。
   */
  async planningNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    // 必须显式指定 functionCalling：deepseek 不是 gpt 系列，withStructuredOutput
    // 会默认走 jsonSchema（response_format: json_schema），但 deepseek 不支持该模式、
    // 会忽略约束返回 markdown 长文导致 JSON 解析失败。工具调用能可靠约束到 schema。
    const structuredModel = this.model.withStructuredOutput(PlanningSchema, {
      method: 'functionCalling',
      name: 'planning',
      includeRaw: true,
    });

    const { raw, parsed: result } = await structuredModel.invoke(
      [
        { role: 'system', content: PLANNING_PROMPT },
        { role: 'user', content: state.input },
      ],
      { signal: config?.signal },
    );

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

  /** 每次调用时动态创建工具：cwd/mode 来自配置，coding 与 tools 节点共用同一套 */
  private getTools(): { cwd: string; tools: StructuredToolInterface[] } {
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
    return { cwd, tools };
  }

  /**
   * 节点 2b：执行 coding 意图（若带用户决策，则作为硬性约束拼进 prompt）。
   * 只调一次 LLM：首轮初始化 system+user 消息，后续轮直接续 state.messages。
   * 工具执行在独立的 tools 节点里，coding ⇄ tools 由图上的条件边循环。
   */
  async codingNode(
    state: AgentStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    const { cwd, tools } = this.getTools();

    // 绑定工具到模型
    const modelWithTools = this.model.bindTools(tools);

    // 首轮：初始化 system + user（decisions 只在这里拼一次，循环轮不会重复追加）
    let initMessages: BaseMessage[] | undefined;
    let messages: BaseMessage[];
    if (state.messages.length === 0) {
      let systemContent = buildSystemPrompt({ cwd, mode: Mode.build });
      if (state.decisions?.length) {
        systemContent +=
          CODING_DECISIONS_PROMPT + formatDecisions(state.decisions);
      }
      initMessages = [
        new SystemMessage(systemContent),
        new HumanMessage(state.input),
      ];
      messages = initMessages;
    } else {
      messages = state.messages;
      // 超过最大轮次：注入提示，要求模型直接收尾、不再调用工具
      if (state.rounds > MAX_TOOL_CALL_ROUNDS) {
        messages = [
          ...messages,
          new HumanMessage(
            `已达到最大工具调用轮次（${MAX_TOOL_CALL_ROUNDS}），请基于目前已获得的信息直接给出最终答案，不要再调用工具。`,
          ),
        ];
      }
    }

    const response = await modelWithTools.invoke(messages, {
      signal: config.signal,
    });

    if (AIMessage.isInstance(response)) {
      console.log('coding', response.usage_metadata);
    }

    const update: Partial<AgentStateType> = {
      // reducer 追加：首轮把初始化消息一并写入 state
      messages: initMessages ? [...initMessages, response] : [response],
    };

    // 没有工具调用 → 这是最终答案，写入 output（条件边随后路由到 final）
    if (!response.tool_calls?.length) {
      update.output = { type: 'text', content: response.content as string };
    }

    return update;
  }

  /**
   * tools 节点：执行上一条 AIMessage 里的所有 tool_calls，
   * 通过 config.writer 推送 tool-call / tool-result 事件（SSE 协议与原 runToolCallLoop 一致），
   * 结果以 ToolMessage 追加进 messages，然后回到 coding 让 LLM 继续。
   */
  async toolsNode(
    state: AgentStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    const { tools } = this.getTools();
    const node = 'coding'; // 事件里标记来源节点，保持前端协议不变

    const last = state.messages.at(-1);
    if (!last || !AIMessage.isInstance(last) || !last.tool_calls?.length) {
      return {};
    }

    const results: ToolMessage[] = [];

    for (const toolCall of last.tool_calls) {
      config.writer?.({
        type: 'tool-call',
        node,
        name: toolCall.name,
        args: toolCall.args,
        toolCallId: toolCall.id,
      });

      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) {
        const message = `Error: Tool ${toolCall.name} not found`;
        config.writer?.({
          type: 'tool-result',
          node,
          name: toolCall.name,
          toolCallId: toolCall.id,
          error: message,
        });
        results.push(
          new ToolMessage({ content: message, tool_call_id: toolCall.id! }),
        );
        continue;
      }

      try {
        const result: unknown = await tool.invoke(toolCall.args, {
          signal: config.signal,
        });
        config.writer?.({
          type: 'tool-result',
          node,
          name: toolCall.name,
          toolCallId: toolCall.id,
          result,
        });
        const rawContent =
          typeof result === 'string' ? result : JSON.stringify(result);
        results.push(
          new ToolMessage({
            content: truncateToolResult(rawContent),
            tool_call_id: toolCall.id!,
          }),
        );
      } catch (error) {
        const message = (error as Error).message;
        config.writer?.({
          type: 'tool-result',
          node,
          name: toolCall.name,
          toolCallId: toolCall.id,
          error: message,
        });
        results.push(
          new ToolMessage({
            content: `Error: ${message}`,
            tool_call_id: toolCall.id!,
          }),
        );
      }
    }

    return { messages: results, rounds: state.rounds + 1 };
  }


  /** 节点 2c：执行 chat 意图 */
  async chatNode(
    state: AgentStateType,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentStateType>> {
    const response = await this.model.invoke(
      [
        { role: 'system', content: CHAT_PROMPT },
        { role: 'user', content: state.input },
      ],
      { signal: config?.signal },
    );
    console.log('chat', response.usage_metadata);
    return { output: { type: 'text', content: response.content as string } };
  }

  /** 节点 3：统一收尾 —— coding / chat 执行完后都汇聚到这里做最终处理 */
  finalNode(state: AgentStateType): Partial<AgentStateType> {
    // 目前只做透传；后续可在此统一加日志、格式化输出、内容审查等收尾逻辑
    return { output: state.output };
  }
}
