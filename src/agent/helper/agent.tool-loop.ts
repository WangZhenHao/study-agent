import { ToolMessage, type BaseMessageLike } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatOpenAI } from '@langchain/openai';

type ModelWithTools = ReturnType<ChatOpenAI['bindTools']>;

/**
 * 执行工具调用循环：LLM 可能需要多轮工具调用才能给出最终答案。
 * 每轮工具调用都会通过 config.writer 推送 tool_call / tool_result 事件（用于 SSE）。
 * messages 会被原地追加 assistant / tool 消息，调用方无需手动维护。
 */
export async function runToolCallLoop(
  modelWithTools: ModelWithTools,
  tools: StructuredToolInterface[],
  messages: BaseMessageLike[],
  config: LangGraphRunnableConfig,
  node: string,
) {
  let response = await modelWithTools.invoke(messages);

  while (response.tool_calls && response.tool_calls.length > 0) {
    const toolCalls = response.tool_calls;

    // 完整回传 assistant 消息（含 tool_calls），否则后续 tool 消息无法对应
    messages.push(response);

    for (const toolCall of toolCalls) {
      config.writer?.({
        type: 'tool_call',
        node,
        name: toolCall.name,
        args: toolCall.args,
        toolCallId: toolCall.id,
      });

      const tool = tools.find((t) => t.name === toolCall.name);
      if (!tool) {
        const message = `Error: Tool ${toolCall.name} not found`;
        config.writer?.({
          type: 'tool_result',
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
          type: 'tool_result',
          node,
          name: toolCall.name,
          toolCallId: toolCall.id,
          result,
        });
        messages.push(
          new ToolMessage({
            content:
              typeof result === 'string' ? result : JSON.stringify(result),
            tool_call_id: toolCall.id!,
          }),
        );
      } catch (error) {
        const message = (error as Error).message;
        config.writer?.({
          type: 'tool_result',
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
