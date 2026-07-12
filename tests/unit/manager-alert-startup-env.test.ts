// SPDX-License-Identifier: MIT

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "../../scripts/start-id-agents-manager.sh");

function runStartupEnvProbe(envFile: string): Record<string, string> {
  const probe = [
    "set -euo pipefail",
    `source ${JSON.stringify(SCRIPT)}`,
    "load_manager_alert_env",
      "node -e \"console.log(JSON.stringify({token:process.env.TELEGRAM_BOT_TOKEN||null,chat:process.env.TELEGRAM_CHAT_ID||null,source:process.env.MANAGER_ALERT_ENV_SOURCE||null,loaded:process.env.MANAGER_ALERT_ENV_LOADED_FILES||null,warnings:process.env.MANAGER_ALERT_ENV_WARNINGS||null}))\"",
  ].join("\n");

  const out = execFileSync("bash", ["-c", probe], {
    env: {
      HOME: process.env.HOME || "",
      MANAGER_ALERT_ENV_FILES: envFile,
      NODE_BIN: "/usr/bin/false",
    },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split(/\r?\n/).at(-1) || "{}");
}

describe("start-id-agents-manager alert env loading", () => {
  it("loads canonical Cane Telegram credentials from a private env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "manager-alert-env-"));
    const envFile = join(dir, ".env.cane");
    writeFileSync(envFile, [
      "CANE_TELEGRAM_BOT_TOKEN='secret-token'",
      'CANE_TELEGRAM_CHAT_ID="secret-chat"',
      "UNRELATED_SECRET=must-not-load",
      "",
    ].join("\n"));
    chmodSync(envFile, 0o600);

    const result = runStartupEnvProbe(envFile);

    expect(result).toMatchObject({
      token: "secret-token",
      chat: "secret-chat",
      source: "env_file",
      loaded: envFile,
      warnings: null,
    });
  });

  it("refuses to load group/world-readable credential files", () => {
    const dir = mkdtempSync(join(tmpdir(), "manager-alert-env-"));
    const envFile = join(dir, ".env.cane");
    writeFileSync(envFile, [
      "CANE_TELEGRAM_BOT_TOKEN=secret-token",
      "CANE_TELEGRAM_CHAT_ID=secret-chat",
      "",
    ].join("\n"));
    chmodSync(envFile, 0o644);

    const result = runStartupEnvProbe(envFile);

    expect(result.token).toBeNull();
    expect(result.chat).toBeNull();
    expect(result.loaded).toBeNull();
    expect(result.warnings).toContain("expected no group/other access; skipped");
    expect(result.warnings).not.toContain("secret-token");
    expect(result.warnings).not.toContain("secret-chat");
  });
});
