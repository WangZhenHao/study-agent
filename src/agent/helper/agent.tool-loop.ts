// 单条 tool 结果回填给 LLM 时的最大字符数，超出部分截断，避免上下文爆炸
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 4000;

/** 截断过长的工具结果（原 runToolCallLoop 的循环逻辑已拆到图的 coding ⇄ tools 节点） */
export function truncateToolResult(
  content: string,
  maxLength: number = DEFAULT_MAX_TOOL_RESULT_LENGTH,
): string {
  if (content.length <= maxLength) return content;
  const omitted = content.length - maxLength;
  return `${content.slice(0, maxLength)}\n\n...[内容过长，已截断，省略 ${omitted} 字符。如需更多内容，请缩小范围重新调用工具]`;
}
