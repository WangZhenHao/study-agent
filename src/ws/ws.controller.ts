import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiOkResponse,
} from '@nestjs/swagger';
import { WsService } from './ws.service';
import { renderSandboxTestPage } from './static/sandbox-test.html';
import {
  SANDBOX_ID_PATTERN,
  SandboxConnectResult,
  SandboxStatsResult,
} from './dto/ws.dto';

const WS_PATH_PREFIX = '/wx/sandbox';

/**
 * Swagger 里"调用" WebSocket 的入口。
 *
 * Swagger UI 发不了 WebSocket 帧，所以文档里暴露三个同名 HTTP 接口：
 * - POST  {id}      获取该沙箱的 ws:// 地址
 * - GET   {id}/test 浏览器测试页（真实收发帧）
 * - GET   ''        当前在线连接概况
 */
@ApiTags('ws')
@Controller(WS_PATH_PREFIX.slice(1))
export class WsController {
  constructor(private readonly registry: WsService) {}

  @Post(':id')
  @ApiOperation({
    summary: '获取沙箱的 WebSocket 连接地址',
    description:
      '返回 ws:// 地址；用任意 WebSocket 客户端连上后，发送的文本帧会被原样回声（占位沙箱）。' +
      '发送 {"type":"ping"} 回 pong，发送 {"type":"close"} 由服务端断开。',
  })
  @ApiParam({
    name: 'id',
    description: '沙箱 id：1~64 位字母、数字、下划线或短横线',
    example: 'demo',
  })
  @ApiOkResponse({ type: SandboxConnectResult })
  connect(@Param('id') id: string, @Req() req: Request): SandboxConnectResult {
    this.assertId(id);
    const wsProto = this.isSecure(req) ? 'wss' : 'ws';
    const httpProto = this.isSecure(req) ? 'https' : 'http';
    const host = req.get('host') ?? 'localhost:3000';
    const wsPath = `${WS_PATH_PREFIX}/${id}`;
    return {
      id,
      url: `${wsProto}://${host}${wsPath}`,
      wsPath,
      testPage: `${httpProto}://${host}${wsPath}/test`,
      issuedAt: new Date().toISOString(),
    };
  }

  @Get()
  @ApiOperation({ summary: '当前沙箱连接概况（确认客户端是否连上）' })
  @ApiOkResponse({ type: SandboxStatsResult })
  stats(): SandboxStatsResult {
    return this.registry.stats();
  }

  @Get(':id/test')
  @ApiOperation({
    summary: '沙箱测试页：在浏览器打开即可连接并收发帧',
    description:
      '返回一个 HTML 页面，页面内用原生 WebSocket 连到 /wx/sandbox/{id}，' +
      '可直接输入内容发送并查看回包。',
  })
  @ApiParam({ name: 'id', description: '沙箱 id', example: 'demo' })
  @ApiProduces('text/html')
  testPage(@Param('id') id: string, @Res() res: Response) {
    this.assertId(id);
    res
      .type('html')
      .setHeader('Cache-Control', 'no-store')
      .send(renderSandboxTestPage(id));
  }

  private assertId(id: string) {
    if (!SANDBOX_ID_PATTERN.test(id)) {
      throw new BadRequestException(
        `沙箱 id 不合法：${id}（只允许 1~64 位字母、数字、下划线或短横线）`,
      );
    }
  }

  private isSecure(req: Request) {
    const forwarded = req.get('x-forwarded-proto')?.split(',')[0].trim();
    return forwarded ? forwarded === 'https' : req.secure;
  }
}
