import { z } from 'zod';

export const IntentSchema = z.object({
  intent: z
    .enum(['planning', 'coding', 'chat'])
    .describe(
      'Intent type: planning (需要设计/规划), coding (直接写代码), chat (普通对话)',
    ),
  reason: z.string().describe('描述用户想做什么'),
});

// planning 意图的结构化输出：给前端渲染的「实现方式选择题」
export const PlanOptionSchema = z.object({
  label: z.string().describe('选项名称，简短'),
  description: z.string().describe('该实现方式的说明和权衡'),
});

export const PlanQuestionSchema = z.object({
  question: z.string().describe('需要用户决策的问题'),
  type: z
    .enum(['single', 'multiple'])
    .describe('single: 只能选一个（互斥方案）；multiple: 可以选多个'),
  options: z.array(PlanOptionSchema).min(2).describe('候选实现方式'),
  allowCustomInput: z
    .boolean()
    .describe('是否允许用户不选任何选项、手动输入自定义答案'),
});

export const PlanningSchema = z.object({
  summary: z.string().describe('对用户需求的简短理解'),
  questions: z
    .array(PlanQuestionSchema)
    .min(1)
    .max(5)
    .describe('实现该需求前需要用户确认的决策点'),
});

export type PlanningResult = z.infer<typeof PlanningSchema>;

// 输出的判别联合：前端根据 type 决定渲染纯文本还是选择表单
export type AgentOutput =
  | { type: 'text'; content: string }
  | ({ type: 'plan' } & PlanningResult);

// 前端提交回来的用户决策：每个问题选了什么 / 手动输入了什么
export interface PlanDecision {
  question: string;
  // 选中的选项 label（单选时只有一个元素；纯手动输入时可为空）
  selected: string[];
  // allowCustomInput 时用户手动输入的内容
  customInput?: string;
}
