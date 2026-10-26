import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WsService } from './ws.service';

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 1024 * 1024;

/** `/wx/sandbox/{id}`，可带一个结尾斜杠，query 在匹配前已剥掉 */
const SANDBOX_PATH = /^\/wx\/sandbox\/([A-Za-z0-9_-]{1,64})\/?$/;

type SocketState = { id: string; alive: boolean; timer: NodeJS.Timeout };

/** 文本帧的负载可能是 Buffer / ArrayBuffer / Buffer[]，统一转成 utf8 字符串 */
function toUtf8(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * 沙箱 WebSocket 服务端（占位实现：收到什么回什么）。
 *
 * 为什么不用 @WebSocketGateway：@nestjs/platform-ws 的适配器按 path 精确匹配，
 * 匹配不了带动态段 `{id}` 的路径。这里用 ws 的 noServer 模式挂到 Nest 同一个
 * HTTP server 的 upgrade 事件上，自己按正则解析 id，路径规则完全可控。
 */
@Injectable()
export class WsGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WsGateway.name);
  private readonly states = new WeakMap<WebSocket, SocketState>();
  private server?: WebSocketServer;
  private onUpgrade?: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  private httpServer?: HttpServer;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: WsService,
  ) {}

  onApplicationBootstrap() {
    this.httpServer =
      this.adapterHost.httpAdapter.getHttpServer() as HttpServer;

    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD,
    });
    this.server.on(
      'connection',
      (socket: WebSocket, _req: IncomingMessage, id: string) => {
        this.handleConnection(socket, id);
      },
    );
    this.server.on('error', (err) => this.logger.error(err.message));

    this.onUpgrade = (req, socket, head) =>
      this.handleUpgrade(req, socket, head);
    this.httpServer.on('upgrade', this.onUpgrade);

    this.logger.log('WebSocket 已就绪：ws://<host>/wx/sandbox/{id}');
  }

  onApplicationShutdown() {
    if (this.httpServer && this.onUpgrade) {
      this.httpServer.off('upgrade', this.onUpgrade);
    }
    // 先逐个断开业务连接，再关服务端，避免 close 回调一直等不到客户端
    for (const { socket } of this.registry.all()) {
      socket.close(1001, 'server shutting down');
    }
    this.server?.close();
    this.server = undefined;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const match = SANDBOX_PATH.exec(pathname);

    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const id = match[1];
    this.server!.handleUpgrade(req, socket, head, (ws) => {
      this.server!.emit('connection', ws, req, id);
    });
  }

  private handleConnection(socket: WebSocket, id: string) {
    this.registry.add(id, socket);
    this.logger.log(`sandbox "${id}" 已连接`);

    const state: SocketState = {
      id,
      alive: true,
      timer: setInterval(() => this.heartbeat(socket), HEARTBEAT_MS),
    };
    this.states.set(socket, state);
    state.timer.unref?.();

    socket.on('pong', () => {
      state.alive = true;
    });
    socket.on('message', (data, isBinary) =>
      this.handleMessage(socket, id, data, isBinary),
    );
    socket.on('close', () => {
      clearInterval(state.timer);
      this.registry.remove(id, socket);
      this.logger.log(`sandbox "${id}" 已断开`);
    });
    socket.on('error', (err) =>
      this.logger.warn(`sandbox "${id}" 错误：${err.message}`),
    );

    this.send(socket, { type: 'connected', id, ts: Date.now() });
  }

  /** 被 ping 过的连接如果这一轮没回 pong，说明已死，直接终止 */
  private heartbeat(socket: WebSocket) {
    const state = this.states.get(socket);
    if (!state) return;
    if (!state.alive) {
      clearInterval(state.timer);
      socket.terminate();
      return;
    }
    state.alive = false;
    socket.ping();
  }

  private handleMessage(
    socket: WebSocket,
    id: string,
    data: RawData,
    isBinary: boolean,
  ) {
    if (isBinary) {
      this.send(socket, {
        type: 'error',
        message: 'only text frames are supported',
      });
      return;
    }

    const text = toUtf8(data);
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // 非 JSON 原样当字符串回
    }

    const command =
      payload && typeof payload === 'object' && 'type' in payload
        ? (payload as { type?: unknown }).type
        : undefined;

    if (command === 'ping') {
      this.send(socket, { type: 'pong', ts: Date.now() });
      return;
    }
    if (command === 'close') {
      this.send(socket, { type: 'closed', id, ts: Date.now() });
      socket.close(1000, 'client requested close');
      return;
    }

    // 占位沙箱语义：原样回声，后续接 Agent 时把这里换成 runStream
    this.send(socket, { id, ts: Date.now(), echo: payload });
  }

  private send(socket: WebSocket, payload: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }
}
