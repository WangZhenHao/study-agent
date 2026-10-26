import { ApiProperty } from '@nestjs/swagger';

/** 沙箱 id 的合法形态：1~64 位字母、数字、下划线或短横线 */
export const SANDBOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** POST /wx/sandbox/{id} 的返回值：告诉调用方该往哪连 */
export class SandboxConnectResult {
  @ApiProperty({ description: '沙箱 id', example: 'demo' })
  id: string;

  @ApiProperty({
    description: 'WebSocket 连接地址（直接用 ws 客户端连它）',
    example: 'ws://localhost:3000/wx/sandbox/demo',
  })
  url: string;

  @ApiProperty({
    description: 'WebSocket 路径部分',
    example: '/wx/sandbox/demo',
  })
  wsPath: string;

  @ApiProperty({
    description: '浏览器测试页：打开即可收发帧',
    example: 'http://localhost:3000/wx/sandbox/demo/test',
  })
  testPage: string;

  @ApiProperty({ description: '生成本地址的时间（ISO 字符串）' })
  issuedAt: string;
}

/** GET /wx/sandbox 的返回值：当前在线连接概况 */
export class SandboxStatsResult {
  @ApiProperty({ description: '当前连接总数', example: 1 })
  connections: number;

  @ApiProperty({
    description: '当前有连接的沙箱 id',
    example: ['demo'],
    type: [String],
  })
  sandboxes: string[];
}
