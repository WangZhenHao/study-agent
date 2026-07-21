import { Command } from '@langchain/langgraph';
import type { AgentGraph } from './agent.graph';
import type { AgentStateType, AgentStreamEvent } from './agent.state';
import type { AgentOutput } from './agent.schema';

// 正文逐字下发的节点白名单
const TOKEN_NODES = new Set(['coding', 'chat']);

/**
 * 执行图并把过程翻译成 SSE 事件。
 * 同时开两种流模式：
 * - updates：每个节点执行完推一次（节点进度、interrupt 选择题）
 * - messages：LLM 逐 token 推送（只透传 coding / chat 的正文，
 *   classify / planning 是结构化输出的中间 JSON，对用户无意义，不下发）
 */
export async function* streamAgentGraph(
  graph: AgentGraph,
  threadId: string,
  graphInput: { input: string } | Command,
): AsyncGenerator<AgentStreamEvent> {
  const config = { configurable: { thread_id: threadId } };

  try {
    // Command 的泛型与图的节点名字面量不完全兼容，运行时行为一致，这里收窄给 TS
    const stream = await graph.stream(graphInput as { input: string }, {
      ...config,
      streamMode: ['updates', 'messages', 'custom'],
    });

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
      } else if (mode === 'custom') {
        // custom: 节点内通过 config.writer 主动推送的事件（工具调用/结果）
        yield chunk as AgentStreamEvent;
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
      const snapshot = await graph.getState(config);
      yield { type: 'done', pending: false, output: snapshot.values.output };
    }
  } catch (err) {
    yield { type: 'error', message: (err as Error).message };
  }
}
