import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private static instance: Redis;
  private client: Redis;
  private readonly logger = new Logger('http');
  constructor(config: ConfigService) {
    if (!RedisService.instance) {
      RedisService.instance = new Redis({
        host: config.get('REDIS_HOST'),
        port: parseInt(config.get('REDIS_PORT') || '6379', 10),
        password: config.get('REDIS_PASSWORD') || undefined,
      });

      RedisService.instance.on('connect', () => {
        console.log('✅ Redis connected (singleton)');
      });

      RedisService.instance.on('error', (err) => {
        console.error('❌ Redis error', err);
        this.logger.error(err);
      });
    }

    this.client = RedisService.instance;
    // this.client = new Redis({
    //   host: '127.0.0.1',
    //   port: 6379,
    //   // password: 'xxx',  // 如果有密码
    //   // db: 0,
    // });

    // this.client.on('connect', () => {
    //   console.log('✅ Redis connected');
    // });

    // this.client.on('error', (err) => {
    //   console.error('❌ Redis error', err);
    //   this.logger.error(err)

    // });
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
