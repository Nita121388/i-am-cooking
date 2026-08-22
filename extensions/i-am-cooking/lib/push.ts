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
 * ntfy 标题：HTTP header 只允许 Latin-1（0-255），emoji/中文都会让 fetch 抛异常。
 * 所以标题用纯 ASCII 精简表达，分类信息改用 body 前缀 emoji（body 是 UTF-8 安全）。
 */
export function ntfyTitle(category: string): string {
  if (category === "completion") return "task done";
  if (category === "progress" || category === "milestone") return "progress";
  return "pi alert!";
}

/** ntfy body：分类前缀（emoji，UTF-8 安全）+ `[urgency] message` */
export function ntfyBody(category: string, urgency: string, message: string): string {
  const prefix =
    category === "completion" ? "✅ " :
    category === "progress" || category === "milestone" ? "📈 " : "";
  return `${prefix}[${urgency}] ${message}`;
}

/**
 * ntfy 推送：默认 header 方式 POST {server}/{topic}；带 actionUrl 时改用 JSON 发布
 * （actions 字段只在 JSON body 里支持，且 UTF-8 安全——按钮文案可用中文/emoji）。
 * 私有 topic 携带 Authorization: Bearer <token>；失败只记日志不抛。
 * 返回是否发送成功。
 */
export async function pushPhone(cfg: Config, alert: Alert, actionUrl?: string): Promise<boolean> {
  const topic = cfg.ntfyTopic?.trim();
  if (!topic) return false;
  const server = (cfg.ntfyServer?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  const priority = alert.urgency === "urgent" ? 5 : alert.urgency === "normal" ? 3 : 1;
  // 标题必须纯 ASCII（header 限制）；分类用 body 前缀 emoji 表达，锁屏一看便知是哪类
  const headers: Record<string, string> = {
    Title: ntfyTitle(alert.category),
    Priority: String(priority),
    Tags: "potable_water",
  };
  const token = resolveValue(cfg.ntfyToken).trim();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    let body: string = ntfyBody(alert.category, alert.urgency, alert.message);
    if (actionUrl) {
      // JSON 发布：actions 放 body（UTF-8 安全）；clear=true 点按后自动清除通知
      // http 动作由手机 App 点击时直接向该 URL 发请求 → 局域网内可达本机停止端点
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        topic,
        message: body,
        title: headers.Title,
        priority,
        tags: ["potable_water"],
        actions: [
          { action: "http", label: "🔕 停止响铃", url: actionUrl, method: "POST", clear: true },
        ],
      });
      delete headers.Title; // JSON 发布时 title/message 走 body，header 版字段不再需要
      delete headers.Priority;
      delete headers.Tags;
    }
    const res = await fetch(actionUrl ? server : `${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      body,
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
        title:
          alert.category === "completion" ? "✅ 任务完成"
          : alert.category === "progress" || alert.category === "milestone" ? "📈 进度"
          : `🍳 ${cfg.shoutPhrase || "agent 需要你"}！`,
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