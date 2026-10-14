/**
 * pi-auto-continue：遇到指定上游 API 错误时自动继续
 *
 * 场景：上游模型服务偶发返回不可重试的请求错误（例如 commandcode 的
 * `invalid_request_error`），Pi 会结束本轮并把错误写进 assistant 消息的
 * `errorMessage`。手动敲一句「继续」即可恢复，但频繁发生时很打断节奏。
 *
 * 做法：在 `agent_end` 读取最后一条 assistant 消息的错误文本，命中匹配词就在
 * `agent_before_settle`（最终结算前的可动作边界）追加一条提示消息并返回
 * `continue: true`，请求一次新的模型调用。
 *
 * 安全阀：
 *   - 只匹配白名单错误文本，其他错误（鉴权失败、额度不足等）不自动续跑
 *   - 不设重试次数上限：持续失败就一直续跑，直到某轮正常完成或用户介入
 *   - 用户发新消息、或某轮正常完成 → 连击计数归零
 *   - 被用户中断（aborted）不续跑
 *   - 随时可用 /auto-continue off 关闭
 *
 * 环境变量：
 *   PI_AUTO_CONTINUE=0                关闭（默认开启）
 *   PI_AUTO_CONTINUE_MATCH=a,b        匹配词（逗号分隔，大小写不敏感）
 *   PI_AUTO_CONTINUE_DELAY_MS=1500    退避基数（第 n 次等待 n × 基数，上限 60s）
 *
 * 命令：
 *   /auto-continue [on|off|status]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 默认匹配词：覆盖 commandcode 400 invalid_request_error 的报文特征 */
const DEFAULT_MATCHERS = ["commandcode API error", "invalid_request_error"];
const DEFAULT_DELAY_MS = 1_500;
/** 退避等待上限：不设重试上限时，避免单次等待无限增长 */
const MAX_DELAY_MS = 60_000;
const STATUS_KEY = "auto-continue";
const MAX_ERROR_TEXT = 240;

interface AssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

function envNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function truncate(text: string, max = MAX_ERROR_TEXT): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function piAutoContinue(pi: ExtensionAPI): void {
  let disabled = process.env.PI_AUTO_CONTINUE === "0";
  const matchers = (process.env.PI_AUTO_CONTINUE_MATCH ?? DEFAULT_MATCHERS.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const baseDelayMs = envNumber(process.env.PI_AUTO_CONTINUE_DELAY_MS, DEFAULT_DELAY_MS);

  /** 本轮命中的错误文本；null 表示本轮不是需要自动续跑的上游错误 */
  let pendingError: string | null = null;
  /** 连续自动续跑连击数（正常完成或用户插话后归零），只用于显示与退避 */
  let streak = 0;

  const matches = (text: string | undefined): boolean => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return matchers.some((matcher) => lower.includes(matcher));
  };

  // 1) 记录本轮错误（agent_before_settle 拿不到消息列表，只有 agent_end 有）
  pi.on("agent_end", async (event) => {
    pendingError = null;
    for (let i = event.messages.length - 1; i >= 0; i -= 1) {
      const message = event.messages[i] as AssistantLike;
      if (message?.role !== "assistant") continue;
      // 只看最后一条 assistant 消息：更早的错误若已恢复就不是本轮的问题
      if (message.stopReason === "error" && matches(message.errorMessage)) {
        pendingError = message.errorMessage ?? "";
      }
      break;
    }
  });

  // 2) 最终结算前续跑一次（唯一的可动作边界）
  pi.on("agent_before_settle", async (event, ctx) => {
    if (disabled) return;
    if (event.outcome === "aborted") return; // 用户主动中断：不自动续跑

    if (event.outcome !== "error" || !pendingError) {
      if (event.outcome === "completed") {
        streak = 0;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }

    streak += 1;
    const retryNo = streak;
    const errorText = truncate(pendingError);
    pendingError = null;

    // 线性退避：连续失败时逐步拉长等待，给上游恢复时间（封顶 MAX_DELAY_MS）
    const waitMs = Math.min(baseDelayMs * retryNo, MAX_DELAY_MS);
    ctx.ui.setStatus(STATUS_KEY, `自动续跑 ${retryNo} 次`);
    ctx.ui.notify(`命中自动续跑错误，${waitMs}ms 后继续（第 ${retryNo} 次）：${errorText}`, "info");
    await sleep(waitMs);

    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "auto-continue",
          display: true,
          content:
            `（自动续跑第 ${retryNo} 次）上一次模型请求因上游错误中断：${errorText}\n` +
            "请从中断处继续未完成的工作，不要重做已完成的步骤，也不要重述已给出的结论。",
        },
      ],
    };
  });

  // 3) 用户发新消息视为新一轮：连击归零（避免旧连击吃掉新问题的额度）
  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") streak = 0;
  });

  pi.registerCommand("auto-continue", {
    description: "查看或切换上游错误自动续跑：/auto-continue [on|off|status]",
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase();
      if (action === "on") {
        disabled = false;
        streak = 0;
        ctx.ui.notify("已开启上游错误自动续跑", "info");
        return;
      }
      if (action === "off") {
        disabled = true;
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify("已关闭上游错误自动续跑", "info");
        return;
      }
      ctx.ui.notify(
        `自动续跑：${disabled ? "已关闭" : "已开启"}；匹配 ${matchers.join(" | ")}；` +
          `重试无上限（退避基数 ${baseDelayMs}ms，封顶 ${MAX_DELAY_MS}ms）；当前连击 ${streak}`,
        "info",
      );
    },
  });
}
