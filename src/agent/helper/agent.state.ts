import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { PlanningResult, AgentOutput, PlanDecision } from './agent.schema';

// SSE 流式事件：前端根据 type 增量渲染
export type AgentStreamEvent =
  // 流开始：告知 threadId（decide 时前端已有，run 时必须拿到它才能后续提交决策）
  | { type: 'start'; threadId: string }
  | { type: 'text-classify'; node: string; content: string }
  // LLM 正文增量（coding / chat 的正文逐字输出）
  | { type: 'text-delta'; node: string; content: string }
  // LLM 推理过程增量（模型返回 reasoning_content 时逐字输出，非推理模型不会触发）
  | { type: 'reasoning-delta'; node: string; content: string }
  // 工具调用开始：LLM 决定调用某个工具（前端可显示"正在读取文件…/执行命令…"）
  | {
      type: 'tool-call';
      node: string;
      name: string;
      args: unknown;
      toolCallId?: string;
    }
  // 工具执行完成：带结果或错误
  | {
      type: 'tool-result';
      node: string;
      name: string;
      toolCallId?: string;
      result?: unknown;
      error?: string;
    }
  // planning 中断：把选择题抛给前端，等待 /agent/decide/stream
  | { type: 'plan-delta'; output: AgentOutput }
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
  // coding ⇄ tools 循环的对话消息（system/user/assistant/tool），reducer 自动追加
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 工具调用轮次计数：toolsNode 每执行一轮 +1，超过上限由条件边兜底跳出
  rounds: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export type AgentStateType = typeof AgentState.State;
