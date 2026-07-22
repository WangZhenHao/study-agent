import { ToolMessage, type BaseMessageLike } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatOpenAI } from '@langchain/openai';

type ModelWithTools = ReturnType<ChatOpenAI['bindTools']>;

// 单条 tool 结果回填给 LLM 时的最大字符数，超出部分截断，避免上下文爆炸
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 4000;
// 最多允许的工具调用轮次，防止模型陷入死循环导致 messages 无限增长
const DEFAULT_MAX_TOOL_CALL_ROUNDS = 50;

interface RunToolCallLoopOptions {
  maxToolResultLength?: number;
  maxRounds?: number;
}

function truncateToolResult(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  const omitted = content.length - maxLength;
  return `${content.slice(0, maxLength)}\n\n...[内容过长，已截断，省略 ${omitted} 字符。如需更多内容，请缩小范围重新调用工具]`;
}

/**
 * 执行工具调用循环：LLM 可能需要多轮工具调用才能给出最终答案。
 * 每轮工具调用都会通过 config.writer 推送 tool-call / tool-result 事件（用于 SSE）。
 * messages 会被原地追加 assistant / tool 消息，调用方无需手动维护。
 */
export async function runToolCallLoop(
  modelWithTools: ModelWithTools,
  tools: StructuredToolInterface[],
  messages: BaseMessageLike[],
  config: LangGraphRunnableConfig,
  node: string,
  options: RunToolCallLoopOptions = {},
) {
  const maxToolResultLength =
    options.maxToolResultLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_TOOL_CALL_ROUNDS;

  let response = await modelWithTools.invoke(messages);
  let round = 0;

  while (response.tool_calls && response.tool_calls.length > 0) {
    round += 1;
    if (round > maxRounds) {
      messages.push(response);
      messages.push({
        role: 'user',
        content: `已达到最大工具调用轮次（${maxRounds}），请基于目前已获得的信息直接给出最终答案，不要再调用工具。`,
      });
      response = await modelWithTools.invoke(messages);
      break;
    }

    const toolCalls = response.tool_calls;

    // 完整回传 assistant 消息（含 tool_calls），否则后续 tool 消息无法对应
    messages.push(response);

    for (const toolCall of toolCalls) {
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
        messages.push(
          new ToolMessage({ content: message, tool_call_id: toolCall.id! }),
        );
        continue;
      }

      try {
        const result = await tool.invoke(toolCall.args);
        config.writer?.({
          type: 'tool-result',
          node,
          name: toolCall.name,
          toolCallId: toolCall.id,
          result,
        });
        const rawContent =
          typeof result === 'string' ? result : JSON.stringify(result);
        messages.push(
          new ToolMessage({
            content: truncateToolResult(rawContent, maxToolResultLength),
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
        messages.push(
          new ToolMessage({
            content: `Error: ${message}`,
            tool_call_id: toolCall.id!,
          }),
        );
      }
    }

    // 继续对话
    response = await modelWithTools.invoke(messages);
  }

  return response;
}
