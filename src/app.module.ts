import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ChatModule } from './chat/chat.module';
import { AgentModule } from './agent/agent.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ChatModule, AgentModule, RedisModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
