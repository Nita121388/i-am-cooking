// 一次性测试脚本（不进发布流程）：模拟完整远程停止链路
// ① 本机循环响铃 ② 发 ntfy 推送（带停止按钮）③ 手机点按钮 → 响铃立即停
import { spawn } from "node:child_process";
import { readConfig } from "../extensions/i-am-cooking/lib/config.ts";
import { startRemoteStopServer } from "../extensions/i-am-cooking/lib/remote-stop.ts";
import { pushPhone } from "../extensions/i-am-cooking/lib/push.ts";
import { randomUUID } from "node:crypto";

const cfg = await readConfig();
const token = randomUUID();

let ringers: ReturnType<typeof spawn>[] = [];
let stopped = false;

function ring(): void {
  if (stopped) return;
  // 循环播放系统提示音，模拟呼喊响铃（每次约 1 秒）
  const p = spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore" });
  ringers.push(p);
  p.on("exit", () => {
    ringers = ringers.filter((x) => x !== p);
    if (!stopped) setTimeout(ring, 400);
  });
}

const srv = await startRemoteStopServer({
  token,
  onStop: () => {
    stopped = true;
    for (const p of ringers) { try { p.kill(); } catch {} }
    console.log("\n🔕 收到手机停止请求！响铃已停。测试成功 ✅");
    setTimeout(() => process.exit(0), 500);
  },
});

console.log(`停止端点已启动：${srv.url}`);
console.log(`本机局域网地址可达性由手机决定；等待发送推送…\n`);

ring();
const alert = {
  id: randomUUID(),
  time: Date.now(),
  message: "【测试】这是远程停止按钮的测试推送。听到电脑在响了吗？点下面的「停止响铃」试试。",
  urgency: "normal" as const,
  category: "decision",
  repeatCount: 0,
  acked: false,
};
const ok = await pushPhone(cfg, alert, srv.url);
console.log(ok ? "推送已发出 📱 请查看手机（ntfy App），点「🔕 停止响铃」。" : "推送失败！检查 ntfy 配置。");

// 2 分钟无操作自动收尾
setTimeout(() => {
  stopped = true;
  for (const p of ringers) { try { p.kill(); } catch {} }
  console.log("\n⏱ 超时未收到点击，自动退出（可能手机不在同一 Wi-Fi，或 ntfy App 版本不支持 http 动作）。");
  void srv.close().then(() => process.exit(0));
}, 120_000);
