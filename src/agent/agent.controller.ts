import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AgentService, type AgentStreamEvent } from './agent.service';
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

  // @Post('classify')
  // @ApiOperation({ summary: '分类用户意图' })
  // async classifyIntent(
  //   @Body() body: ClassifyIntentDto,
  // ): Promise<IntentResult> {
  //   return this.agentService.classifyIntent(body.input);
  // }

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

  @Post('run/stream')
  @ApiOperation({
    summary:
      'run 的 SSE 流式版：逐事件推送节点进度、LLM token、选择题、最终结果',
  })
  async runStream(@Body() body: RunAgentDto, @Res() res: Response) {
    await this.pipeSse(res, this.agentService.runStream(body.input));
  }

  @Post('decide/stream')
  @ApiOperation({
    summary: 'decide 的 SSE 流式版：从暂停处恢复，逐字推送生成的代码',
  })
  async decideStream(@Body() body: DecideDto, @Res() res: Response) {
    await this.pipeSse(
      res,
      this.agentService.decideStream(body.threadId, body.decisions),
    );
  }

  /**
   * 把 service 的事件流按 SSE 协议写回响应。
   * 每条事件格式：`event: <type>\ndata: <json>\n\n`；
   * 流结束后发送 `data: [DONE]\n\n` 并关闭连接。
   */
  private async pipeSse(
    res: Response,
    events: AsyncGenerator<AgentStreamEvent>,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // 客户端提前断开时停止消费，避免继续跑图/写已关闭的响应
    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
    });

    const write = (event: AgentStreamEvent | { type: string; message: string }) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of events) {
        if (clientGone) break;
        write(event);
      }
    } catch (err) {
      write({ type: 'error', message: (err as Error).message });
    } finally {
      if (!clientGone) {
        // res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }
}
