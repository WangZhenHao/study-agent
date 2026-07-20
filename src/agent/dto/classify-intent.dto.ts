import { ApiProperty } from '@nestjs/swagger';

export class ClassifyIntentDto {
  @ApiProperty({ description: '用户输入内容', example: '帮我设计一个用户登录模块' })
  input: string;
}

export class PlanDecisionDto {
  @ApiProperty({ description: '决策的问题（planning 返回的 question）', example: '选择哪种会话方案？' })
  question: string;

  @ApiProperty({
    description: '选中的选项 label（单选时只有一个元素）',
    type: [String],
    example: ['JWT Token'],
  })
  selected: string[];

  @ApiProperty({
    description: '用户手动输入的自定义答案（allowCustomInput 时）',
    required: false,
    example: '要支持刷新 token',
  })
  customInput?: string;
}

export class RunAgentDto {
  @ApiProperty({ description: '用户输入内容', example: '写一个快速排序' })
  input: string;
}

export class DecideDto {
  @ApiProperty({
    description: '会话 ID（/agent/run 返回的 threadId）',
    example: 'b1f8f9a0-...',
  })
  threadId: string;

  @ApiProperty({
    description: '用户对 planning 决策点的选择结果',
    type: [PlanDecisionDto],
  })
  decisions: PlanDecisionDto[];
}

export class IntentResult {
  @ApiProperty({
    description: '意图类型',
    enum: ['planning', 'coding', 'chat'],
    example: 'planning',
  })
  intent: 'planning' | 'coding' | 'chat';

  @ApiProperty({ description: '判断原因', example: '用户请求设计模块，需要先规划架构' })
  reason: string;
}

export class PlanOptionDto {
  @ApiProperty({ description: '选项名称', example: 'JWT Token' })
  label: string;

  @ApiProperty({
    description: '该实现方式的说明和权衡',
    example: '无状态、易水平扩展，但注销需要额外处理',
  })
  description: string;
}

export class PlanQuestionDto {
  @ApiProperty({ description: '需要用户决策的问题', example: '选择哪种会话方案？' })
  question: string;

  @ApiProperty({
    description: '选择类型：single 单选（互斥方案），multiple 多选（可叠加）',
    enum: ['single', 'multiple'],
    example: 'single',
  })
  type: 'single' | 'multiple';

  @ApiProperty({ description: '候选实现方式', type: [PlanOptionDto] })
  options: PlanOptionDto[];

  @ApiProperty({ description: '是否允许用户手动输入自定义答案', example: true })
  allowCustomInput: boolean;
}

export class AgentOutputDto {
  @ApiProperty({
    description: '输出类型：text 纯文本（coding/chat），plan 实现方式选择表单（planning）',
    enum: ['text', 'plan'],
  })
  type: 'text' | 'plan';

  @ApiProperty({ description: '纯文本内容（type=text 时）', required: false })
  content?: string;

  @ApiProperty({ description: '对用户需求的简短理解（type=plan 时）', required: false })
  summary?: string;

  @ApiProperty({
    description: '需要用户确认的决策点（type=plan 时）',
    type: [PlanQuestionDto],
    required: false,
  })
  questions?: PlanQuestionDto[];
}

export class AgentRunResult extends IntentResult {
  @ApiProperty({ description: '会话 ID，提交决策时回传', example: 'b1f8f9a0-...' })
  threadId: string;

  @ApiProperty({
    description: '是否在等待用户提交决策（true 时前端渲染选择表单，提交到 /agent/decide）',
    example: false,
  })
  pending: boolean;

  @ApiProperty({ description: '意图执行后的最终输出', type: AgentOutputDto })
  output: AgentOutputDto;
}
