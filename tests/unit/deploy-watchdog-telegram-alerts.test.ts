// Regression coverage for the external deploy watchdog alert channel. The
// manager process cannot page when it is down, so these alerts must live here.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHDOG_SRC = readFileSync(
  join(__dirname, '../../scripts/deploy-freshness-watchdog.mjs'),
  'utf8',
);

describe('deploy-freshness-watchdog Telegram alerting', () => {
  it('loads the shared taskview Telegram credentials without overriding launchd env', () => {
    expect(WATCHDOG_SRC).toContain('DEPLOY_WATCHDOG_ENV_FILE');
    expect(WATCHDOG_SRC).toContain('Dropbox/Code/cane/taskview/.env');
    expect(WATCHDOG_SRC).toContain('Dropbox/Code/cane/taskview/.env.cane');
    expect(WATCHDOG_SRC).toContain('TELEGRAM_BOT_TOKEN');
    expect(WATCHDOG_SRC).toContain('TELEGRAM_CHAT_ID');
    expect(WATCHDOG_SRC).toContain('CANE_TELEGRAM_BOT_TOKEN');
    expect(WATCHDOG_SRC).toContain('CANE_TELEGRAM_CHAT_ID');
    expect(WATCHDOG_SRC).toContain('if (process.env[key] !== undefined) continue');
  });

  it('sends Telegram messages via the canonical bot sendMessage pattern', () => {
    expect(WATCHDOG_SRC).toContain('TELEGRAM_API_BASE');
    expect(WATCHDOG_SRC).toContain('/sendMessage');
    expect(WATCHDOG_SRC).toContain('chat_id: chat');
    expect(WATCHDOG_SRC).toContain('WARN Telegram not configured; alert dropped');
  });

  it('pages when manager health is unreachable', () => {
    expect(WATCHDOG_SRC).toContain("if (!health.ok) {");
    expect(WATCHDOG_SRC).toContain("title: 'manager health unreachable'");
  });

  it('pages when stale/behind evidence crosses the redeploy threshold', () => {
    expect(WATCHDOG_SRC).toContain("title: 'manager stale/behind threshold exceeded'");
    expect(WATCHDOG_SRC).toContain('Freshness: ${health.freshnessState');
    expect(WATCHDOG_SRC).toContain('origin_main_sha: ${health.originMainSha');
  });

  it('pages when the redeploy attempt fails', () => {
    expect(WATCHDOG_SRC).toContain("title: 'redeploy attempt FAILED'");
    expect(WATCHDOG_SRC).toContain('Watchdog reason: ${decision.reason}');
    expect(WATCHDOG_SRC).toContain('Escalation: ${escalation}');
  });
});
