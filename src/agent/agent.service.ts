import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { Command } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import type { PlanningResult, AgentOutput, PlanDecision } from './helper/agent.schema';
import { AgentNodes } from './helper/agent.nodes';
import { buildAgentGraph, type AgentGraph } from './helper/agent.graph';
import { streamAgentGraph } from './helper/agent.stream';
import type { AgentStateType, AgentStreamEvent } from './helper/agent.state';

export type { PlanningResult, AgentOutput, PlanDecision };
export type { AgentStreamEvent } from './helper/agent.state';

@Injectable()
export class AgentService {
  private model: ChatOpenAI;
  private nodes: AgentNodes;
  private graph: AgentGraph;

  constructor(private readonly config: ConfigService) {
    const apiUrl = this.config.getOrThrow<string>('NEST_API_URL');
    const apiKey = this.config.getOrThrow<string>('NEST_API_KEY');

    this.model = new ChatOpenAI({
      model: 'deepseek-v4-flash',
      apiKey: apiKey,
      configuration: {
        baseURL: apiUrl,
      },
      modelKwargs:{
        thinking:{
          type:"disabled"
        }
      }
    });

    this.nodes = new AgentNodes(this.model, this.config);
    // 编译一次，后续每个请求复用
    this.graph = buildAgentGraph(this.nodes);
  }

  /** 开始一轮对话：意图判断 -> 意图执行；planning 会中断并返回选择题 */
  async run(input: string) {
    const threadId = randomUUID();
    const config = { configurable: { thread_id: threadId } };

    const result = await this.graph.invoke({ input }, config);
    return this.buildResponse(threadId, result, config);
  }

  /** 流式开始一轮对话：SSE 逐事件推送（节点进度 + LLM token + 选择题/最终结果） */
  async *runStream(input: string): AsyncGenerator<AgentStreamEvent> {
    const threadId = randomUUID();
    yield { type: 'start', threadId };
    yield* streamAgentGraph(this.graph, threadId, { input });
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
    yield* streamAgentGraph(
      this.graph,
      threadId,
      new Command({ resume: decisions }),
    );
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

  async classifyIntent(input: string) {
    return this.nodes.classifyIntent(input);
  }
}
