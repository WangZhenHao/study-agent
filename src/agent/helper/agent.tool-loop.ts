import { PlanDecision } from './agent.schema';

// 单条 tool 结果回填给 LLM 时的最大字符数，超出部分截断，避免上下文爆炸
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 4000;

// 最多允许的工具调用轮次，防止模型陷入死循环导致 messages 无限增长
export const MAX_TOOL_CALL_ROUNDS = 50;

export const MAX_AGENT_CALL_LIMIT = 1000
/** 截断过长的工具结果（原 runToolCallLoop 的循环逻辑已拆到图的 coding ⇄ tools 节点） */
export function truncateToolResult(
  content: string,
  maxLength: number = DEFAULT_MAX_TOOL_RESULT_LENGTH,
): string {
  if (content.length <= maxLength) return content;
  const omitted = content.length - maxLength;
  return `${content.slice(0, maxLength)}\n\n...[内容过长，已截断，省略 ${omitted} 字符。如需更多内容，请缩小范围重新调用工具]`;
}

/** 把用户决策格式化为 prompt 里的约束清单 */
export function formatDecisions(decisions: PlanDecision[]): string {
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
