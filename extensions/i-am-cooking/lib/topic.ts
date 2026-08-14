/**
 * 可爱 Topic 名生成（纯逻辑，可测试）。
 * 编程/算法/LLM 风词池 + 6 位随机数字，保证全局唯一。
 */
import { randomUUID } from "node:crypto";

export const TOPIC_ADJ = [
  "递归的", "贪心的", "并发的", "异步的", "迭代的", "哈希的", "分治的", "回溯的",
  "动态的", "懒惰的", "原子的", "鲁棒的", "优雅的", "熵增的", "收敛的", "涌现的",
  "幻觉的", "对齐的", "蒸馏的", "微调的", "自举的", "深夜炼丹的",
];

export const TOPIC_NOUN = [
  "递归", "栈", "队列", "堆", "哈希", "梯度", "向量", "张量", "词元", "提示词",
  "注意力", "神经元", "权重", "参数", "嵌入", "协程", "信号量", "守护进程",
  "管道", "缓存", "缓冲区", "编译器", "字节", "剪枝",
];

export const TOPIC_COMBOS = TOPIC_ADJ.length * TOPIC_NOUN.length * 1_000_000;

const TOPIC_RE = /^i-am-cooking-[\u4e00-\u9fff]+-(\d{6})$/;

/** 从 uuid 里取 6 位纯数字（crypto 随机） */
function randomDigits(): string {
  const digits = randomUUID().replace(/\D/g, "");
  return (digits + "000000").slice(0, 6);
}

/** 生成可爱 topic 名：`i-am-cooking-形容词名词-6位数字` */
export function suggestTopic(): string {
  const adj = TOPIC_ADJ[Math.floor(Math.random() * TOPIC_ADJ.length)];
  const noun = TOPIC_NOUN[Math.floor(Math.random() * TOPIC_NOUN.length)];
  return `i-am-cooking-${adj}${noun}-${randomDigits()}`;
}

/** 校验 topic 名格式是否正确（测试用） */
export function isValidTopic(topic: string): boolean {
  return TOPIC_RE.test(topic);
}
