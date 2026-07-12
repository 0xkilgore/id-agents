// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { getTelegramAlertDeliveryHealth } from "../../src/continuous-orchestration/alert-delivery-health.js";

describe("getTelegramAlertDeliveryHealth", () => {
  it("reports deliverable Telegram alerts without exposing credential values", () => {
    const health = getTelegramAlertDeliveryHealth({
      TELEGRAM_BOT_TOKEN: "secret-token",
      TELEGRAM_CHAT_ID: "secret-chat",
      MANAGER_ALERT_ENV_SOURCE: "env_file",
      MANAGER_ALERT_ENV_LOADED_FILES: "/secure/.env.cane",
    });

    expect(health).toMatchObject({
      schema_version: "alert-delivery.telegram.v1",
      state: "deliverable",
      configured: true,
      deliverable: true,
      credentials: {
        bot_token: "present",
        chat_id: "present",
      },
      source: {
        kind: "env_file",
        env_files_loaded: ["/secure/.env.cane"],
      },
    });
    expect(JSON.stringify(health)).not.toContain("secret-token");
    expect(JSON.stringify(health)).not.toContain("secret-chat");
  });

  it("reports a typed not_configured state when credentials are incomplete", () => {
    const health = getTelegramAlertDeliveryHealth({
      TELEGRAM_BOT_TOKEN: "secret-token",
      MANAGER_ALERT_ENV_WARNINGS: "permissions for /tmp/env are 644, expected no group/other access; skipped",
    });

    expect(health.state).toBe("not_configured");
    expect(health.configured).toBe(false);
    expect(health.deliverable).toBe(false);
    expect(health.credentials).toEqual({ bot_token: "present", chat_id: "missing" });
    expect(health.source.warnings).toEqual([
      "permissions for /tmp/env are 644, expected no group/other access; skipped",
    ]);
  });
});
