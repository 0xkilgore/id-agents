// SPDX-License-Identifier: MIT

export type AlertDeliveryCredentialState = "present" | "missing";
export type TelegramAlertDeliveryState = "deliverable" | "not_configured";

export type TelegramAlertDeliveryHealth = {
  schema_version: "alert-delivery.telegram.v1";
  state: TelegramAlertDeliveryState;
  configured: boolean;
  deliverable: boolean;
  credentials: {
    bot_token: AlertDeliveryCredentialState;
    chat_id: AlertDeliveryCredentialState;
  };
  source: {
    kind: "process_env" | "env_file" | "unknown";
    env_files_loaded: string[];
    warnings: string[];
  };
};

function splitList(value: string | undefined, separator: string): string[] {
  return (value || "")
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getTelegramAlertDeliveryHealth(
  env: NodeJS.ProcessEnv = process.env,
): TelegramAlertDeliveryHealth {
  const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
  const hasChat = Boolean(env.TELEGRAM_CHAT_ID);
  const envFilesLoaded = splitList(env.MANAGER_ALERT_ENV_LOADED_FILES, ":");
  const warnings = splitList(env.MANAGER_ALERT_ENV_WARNINGS, "||");
  const configured = hasToken && hasChat;

  return {
    schema_version: "alert-delivery.telegram.v1",
    state: configured ? "deliverable" : "not_configured",
    configured,
    deliverable: configured,
    credentials: {
      bot_token: hasToken ? "present" : "missing",
      chat_id: hasChat ? "present" : "missing",
    },
    source: {
      kind: env.MANAGER_ALERT_ENV_SOURCE === "env_file"
        ? "env_file"
        : env.MANAGER_ALERT_ENV_SOURCE === "process_env"
          ? "process_env"
          : envFilesLoaded.length > 0
            ? "env_file"
            : "unknown",
      env_files_loaded: envFilesLoaded,
      warnings,
    },
  };
}
