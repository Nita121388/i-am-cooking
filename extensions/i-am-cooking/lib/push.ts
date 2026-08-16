/**
 * 手机推送通道（纯逻辑 + fetch，可测试）。
 * ntfy（免费开源）/ webhook（Bark、企业微信、Server酱…）双通道，按 pushProvider 分发。
 * 认证 token 支持 ${ENV_VAR} 引用。
 */
import type { Alert, Config } from "./config.ts";

/** 解析 token：支持 ${ENV_VAR} 或 $ENV_VAR 引用环境变量；其余原样返回 */
export function resolveValue(v: string): string {
  if (typeof v !== "string" || !v) return v ?? "";
  const m = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? v.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) return process.env[m[1]] ?? "";
  return v;
}

/**
 * ntfy 推送：POST {server}/{topic}，body 为 `[urgency] message`。
 * 私有 topic 携带 Authorization: Bearer <token>；失败只记日志不抛。
 * 返回是否发送成功。
 */
export async function pushPhone(cfg: Config, alert: Alert): Promise<boolean> {
  const topic = cfg.ntfyTopic?.trim();
  if (!topic) return false;
  const server = (cfg.ntfyServer?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  const priority = alert.urgency === "urgent" ? 5 : alert.urgency === "normal" ? 3 : 1;
  const headers: Record<string, string> = {
    Title: "[pi] alert!",
    Priority: String(priority),
    Tags: "potable_water",
  };
  const token = resolveValue(cfg.ntfyToken).trim();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body: `[${alert.urgency}] ${alert.message}`,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[i-am-cooking] ntfy push failed: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[i-am-cooking] ntfy push failed:", (e as Error).message);
    return false;
  }
}

/**
 * 通用 webhook 推送：POST JSON {title, message, urgency, category, time}。
 * 认证 token 放在指定 header（默认 Authorization: Bearer <token>）。
 * 失败只记日志不抛；返回是否发送成功。
 */
export async function pushWebhook(cfg: Config, alert: Alert): Promise<boolean> {
  const url = cfg.webhookUrl?.trim();
  if (!url) return false;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = resolveValue(cfg.webhookToken).trim();
  if (token) {
    const headerName = cfg.webhookTokenHeader?.trim() || "Authorization";
    const value = headerName.toLowerCase() === "authorization" && !/^Bearer\s/i.test(token)
      ? `Bearer ${token}`
      : token;
    headers[headerName] = value;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `🍳 ${cfg.shoutPhrase || "agent 需要你"}！`,
        message: alert.message,
        urgency: alert.urgency,
        category: alert.category,
        time: new Date(alert.time).toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[i-am-cooking] webhook push failed: HTTP ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[i-am-cooking] webhook push failed:", (e as Error).message);
    return false;
  }
}