/**
 * 远程停止服务（纯逻辑 + node:http，可测试）。
 * 场景：用户在厨房听到电脑响铃，掏出手机点 ntfy 推送上的「停止」按钮，
 * 手机直接向本机内网 IP 发一个 HTTP 请求 → 杀掉正在播放的音频（不退出离开模式）。
 *
 * 安全模型：
 * - 只绑内网可达地址（0.0.0.0），URL 携带每次会话随机生成的 token
 * - 仅暴露一个动作端点 /stop；token 不对返回 403
 * - 仅在离开模式期间运行，off/会话关闭即停服
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";

export interface RemoteStopHandle {
  /** 实际监听端口（0 = 由系统分配，启动后回读） */
  port: number;
  /** 完整动作 URL（含局域网 IP + token），直接放进 ntfy actions */
  url: string;
  /** 关闭服务（幂等） */
  close(): Promise<void>;
}

export interface RemoteStopOptions {
  /** 会话级随机 token，URL 参数校验用 */
  token: string;
  /** 校验通过后执行的动作（杀音频等），同步即可 */
  onStop: () => void;
}

/** 取本机第一个非内部 IPv4 局域网地址；取不到返回 null（调用方回退 localhost） */
export function lanAddress(): string | null {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const net of addrs ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

/** 构造动作 URL：局域网 IP 优先（手机可达），无内网地址时回退 localhost（仅本机可点） */
export function buildStopUrl(port: number, token: string): string {
  const host = lanAddress() ?? "localhost";
  return `http://${host}:${port}/stop?token=${encodeURIComponent(token)}`;
}

/**
 * 启动远程停止 HTTP 服务。
 * - 监听 0.0.0.0 随机端口（系统分配，避免冲突）
 * - GET/POST /stop?token=xxx → 校验通过执行 onStop 并返回 200；token 错误 403；其他路径 404
 * - 请求处理全程 try/catch，任何异常都不影响主流程（best effort）
 */
export function startRemoteStopServer(opts: RemoteStopOptions): Promise<RemoteStopHandle> {
  return new Promise((resolve, reject) => {
    let closed = false;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", "http://local");
        if (url.pathname !== "/stop") {
          res.writeHead(404).end();
          return;
        }
        if (url.searchParams.get("token") !== opts.token) {
          res.writeHead(403).end();
          return;
        }
        opts.onStop();
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("stopped");
      } catch {
        try { res.writeHead(500).end(); } catch { /* ignore */ }
      }
    });

    server.on("error", (err) => {
      if (!closed) reject(err);
    });

    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: buildStopUrl(port, opts.token),
        close: () =>
          new Promise<void>((done) => {
            closed = true;
            // close 在无活动连接时立即回调；有 keep-alive 连接也强制终结
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
