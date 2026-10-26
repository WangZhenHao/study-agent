import { Module } from '@nestjs/common';
import { WsController } from './ws.controller';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';

@Module({
  controllers: [WsController],
  providers: [WsGateway, WsService],
  exports: [WsService],
})
export class WsModule {}
