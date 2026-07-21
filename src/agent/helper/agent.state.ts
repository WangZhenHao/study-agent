import { Annotation } from '@langchain/langgraph';
import type { PlanningResult, AgentOutput, PlanDecision } from './agent.schema';

// SSE 流式事件：前端根据 type 增量渲染
export type AgentStreamEvent =
  // 流开始：告知 threadId（decide 时前端已有，run 时必须拿到它才能后续提交决策）
  | { type: 'start'; threadId: string }
  // 某个节点执行完毕（可用于渲染进度条/步骤条）
  | { type: 'node'; node: string; intent?: string; reason?: string }
  // LLM 增量 token（coding / chat 的正文逐字输出）
  | { type: 'token'; node: string; content: string }
  // 工具调用开始：LLM 决定调用某个工具（前端可显示"正在读取文件…/执行命令…"）
  | {
      type: 'tool_call';
      node: string;
      name: string;
      args: unknown;
      toolCallId?: string;
    }
  // 工具执行完成：带结果或错误
  | {
      type: 'tool_result';
      node: string;
      name: string;
      toolCallId?: string;
      result?: unknown;
      error?: string;
    }
  // planning 中断：把选择题抛给前端，等待 /agent/decide/stream
  | { type: 'plan'; output: AgentOutput }
  // 流结束：带最终输出（interrupt 暂停时 pending=true 且无 output）
  | { type: 'done'; pending: boolean; output?: AgentOutput }
  | { type: 'error'; message: string };

// 图的状态：贯穿整个流程的数据，每个节点读取它并返回要更新的部分
export const AgentState = Annotation.Root({
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

export type AgentStateType = typeof AgentState.State;
