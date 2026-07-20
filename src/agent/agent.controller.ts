import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import {
  ClassifyIntentDto,
  IntentResult,
  RunAgentDto,
  DecideDto,
  AgentRunResult,
} from './dto/classify-intent.dto';

@ApiTags('agent')
@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('classify')
  @ApiOperation({ summary: '分类用户意图' })
  async classifyIntent(
    @Body() body: ClassifyIntentDto,
  ): Promise<IntentResult> {
    return this.agentService.classifyIntent(body.input);
  }

  @Post('run')
  @ApiOperation({
    summary:
      '开始一轮对话：意图判断 -> 意图执行 -> 输出；planning 时暂停并返回选择题（pending=true）',
  })
  async run(@Body() body: RunAgentDto): Promise<AgentRunResult> {
    return this.agentService.run(body.input);
  }

  @Post('decide')
  @ApiOperation({
    summary: '提交用户决策，从暂停处恢复本轮对话，按决策约束生成代码',
  })
  async decide(@Body() body: DecideDto): Promise<AgentRunResult> {
    return this.agentService.decide(body.threadId, body.decisions);
  }
}
