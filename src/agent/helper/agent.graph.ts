import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { AgentState } from './agent.state';
import type { AgentNodes } from './agent.nodes';

/**
 * 组装流程图：用户输入 -> 意图判断 -> 意图执行 -> 输出
 *
 *              START
 *                |
 *             classify（意图判断）
 *           /    |     \
 *    planning  coding  chat（意图执行）
 *        |       |      |
 *     askUser    |      |
 *  ⏸ interrupt：暂停，把选择题返回给前端
 *        |       |      |
 *        └─→ coding     |
 *                |      |
 *              final（统一收尾）
 *                |
 *               END
 *
 * planning 只负责 LLM 生成选择题并写入 state；askUser 只做 interrupt()。
 * 拆成两个节点是因为恢复时会从被中断节点的开头重跑：若 interrupt 和
 * LLM 调用在同一节点，/agent/decide 恢复时会白白重跑一次 LLM。
 * 前端提交决策后调用 /agent/decide，图从暂停处恢复，接着走 coding。
 */
export function buildAgentGraph(nodes: AgentNodes) {
  return (
    new StateGraph(AgentState)
      .addNode('classify', (state) => nodes.classifyNode(state))
      .addNode('planning', (state) => nodes.planningNode(state))
      .addNode('askUser', (state) => nodes.askUserNode(state))
      .addNode('coding', (state, config) => nodes.codingNode(state, config))
      .addNode('chat', (state) => nodes.chatNode(state))
      .addNode('final', (state) => nodes.finalNode(state))
      .addEdge(START, 'classify')
      // 条件路由：根据意图判断结果，决定走哪个执行节点
      .addConditionalEdges('classify', (state) => state.intent, {
        planning: 'planning',
        coding: 'coding',
        chat: 'chat',
      })
      // planning 生成选择题后，交给 askUser 中断等待用户决策
      .addEdge('planning', 'askUser')
      // askUser 拿到用户决策（interrupt 恢复）后，接着走 coding
      .addEdge('askUser', 'coding')
      // coding / chat 执行完后，统一走 final 收尾
      .addEdge('coding', 'final')
      .addEdge('chat', 'final')
      .addEdge('final', END)
      // checkpointer：interrupt 暂停时保存现场，靠 thread_id 恢复
      .compile({ checkpointer: new MemorySaver() })
  );
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
