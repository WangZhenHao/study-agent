import { ApiProperty } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty({ description: '消息内容', example: '你好' })
  content: string;

  @ApiProperty({ description: '发送者', example: 'user1' })
  sender: string;
}
