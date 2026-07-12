// Continuous Orchestration — loud alert channel.
//
// Minimal Telegram sender for the unattended failure modes: ceiling-hit
// auto-pause and the overnight-drain STALL alert. No-ops cleanly when the bot
// is not configured (so tests + un-provisioned envs never throw).

import { getTelegramAlertDeliveryHealth } from "./alert-delivery-health.js";

export type AlertSender = (message: string) => Promise<void>;

/** Send a Telegram message via the Cane bot. Best-effort; never throws. */
export async function sendTelegramAlert(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const health = getTelegramAlertDeliveryHealth(env);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!health.deliverable || !token || !chatId) {
    console.warn(`[orchestration] Telegram not configured; alert dropped: ${message}`);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
  } catch (err) {
    console.error("[orchestration] Telegram send failed:", err);
  }
}
