import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/**
 * 沙箱连接注册表：一个 id 下允许挂多条连接（多标签页/多客户端同时调试），
 * 只做登记与统计，不持有业务状态。
 */
@Injectable()
export class WsService {
  private readonly sandboxes = new Map<string, Set<WebSocket>>();

  add(id: string, socket: WebSocket) {
    let sockets = this.sandboxes.get(id);
    if (!sockets) {
      sockets = new Set();
      this.sandboxes.set(id, sockets);
    }
    sockets.add(socket);
  }

  remove(id: string, socket: WebSocket) {
    const sockets = this.sandboxes.get(id);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.sandboxes.delete(id);
  }

  /**
   * 向该沙箱下的所有连接广播一帧；沙箱不存在或全部连接已断时返回 0。
   * 广播失败不应影响调用方（HTTP 主通道），所以只跳过、不抛错。
   */
  broadcast(id: string, payload: unknown): number {
    const sockets = this.sandboxes.get(id);
    if (!sockets) return 0;

    const frame = JSON.stringify(payload);
    let sent = 0;
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      socket.send(frame);
      sent += 1;
    }
    return sent;
  }

  /** 当前所有连接（关停时逐个关闭用） */
  all(): { id: string; socket: WebSocket }[] {
    const list: { id: string; socket: WebSocket }[] = [];
    for (const [id, sockets] of this.sandboxes) {
      for (const socket of sockets) list.push({ id, socket });
    }
    return list;
  }

  stats() {
    let connections = 0;
    for (const sockets of this.sandboxes.values()) connections += sockets.size;
    return { connections, sandboxes: [...this.sandboxes.keys()] };
  }
}
