import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyClaudeAuthPreflight,
  detectClaudeAuthPreflightHandoffVars,
  runClaudeWorkerAuthPreflight,
  sanitizeClaudeCliEnv,
} from "../../src/harness/claude-worker-auth-preflight.js";

let tmpDir: string;
let oldAnthropicKey: string | undefined;
let oldOauthToken: string | undefined;
let oldEntrypoint: string | undefined;
let oldClaudeCode: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-auth-preflight-"));
  oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  oldOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  oldEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  oldClaudeCode = process.env.CLAUDECODE;
});

afterEach(() => {
  if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
  if (oldOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldOauthToken;
  if (oldEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = oldEntrypoint;
  if (oldClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = oldClaudeCode;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("classifyClaudeAuthPreflight", () => {
  it("emits CLAUDE AUTH OK when the bounded ping succeeds", () => {
    const result = classifyClaudeAuthPreflight({
      exitCode: 0,
      stdout: JSON.stringify({ result: "AUTH_OK" }),
      stderr: "",
    });

    expect(result.status).toBe("ok");
    expect(result.signal).toBe("CLAUDE AUTH OK");
  });

  it("classifies provider 5xx as PROVIDER_TRANSIENT", () => {
    const result = classifyClaudeAuthPreflight({
      exitCode: 1,
      stderr: "provider returned HTTP 503 service unavailable",
    });

    expect(result.status).toBe("provider_transient");
    expect(result.signal).toBe("CLAUDE AUTH PROVIDER_TRANSIENT");
  });

  it("classifies login and plan failures as CLAUDE AUTH FAIL and redacts secrets", () => {
    const result = classifyClaudeAuthPreflight({
      exitCode: 1,
      stderr: "401 Unauthorized: invalid api key sk-ant-api03-secretvalue",
    });

    expect(result.status).toBe("fail");
    expect(result.signal).toBe("CLAUDE AUTH FAIL");
    expect(result.reason).toBe("auth_or_plan_failure");
    expect(result.redactedMessage).not.toContain("secretvalue");
    expect(result.redactedMessage).toContain("[REDACTED]");
  });
});

describe("runClaudeWorkerAuthPreflight", () => {
  it("uses Claude CLI auth without adding API-key auth or parent session handoff vars", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "parent-oauth-token";
    process.env.CLAUDE_CODE_ENTRYPOINT = "parent-entrypoint";
    process.env.CLAUDECODE = "1";

    const envOut = join(tmpDir, "env.json");
    const fakeClaude = join(tmpDir, "fake-claude.js");
    writeFileSync(
      fakeClaude,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.PREFLIGHT_ENV_OUT, JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  anthropic: process.env.ANTHROPIC_API_KEY || null,",
        "  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN || null,",
        "  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,",
        "  claudeCode: process.env.CLAUDECODE || null",
        "}));",
        "console.log(JSON.stringify({ result: 'AUTH_OK' }));",
        "",
      ].join("\n"),
    );
    chmodSync(fakeClaude, 0o755);

    const result = await runClaudeWorkerAuthPreflight({
      workingDirectory: tmpDir,
      model: "claude-sonnet-5",
      timeoutMs: 5_000,
      claudePath: fakeClaude,
      env: { ...process.env, PREFLIGHT_ENV_OUT: envOut },
    });

    const observed = JSON.parse(readFileSync(envOut, "utf8")) as {
      args: string[];
      anthropic: string | null;
      oauth: string | null;
      entrypoint: string | null;
      claudeCode: string | null;
    };
    expect(result.status).toBe("ok");
    expect(observed.args).toContain("--model");
    expect(observed.args[observed.args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
    expect(observed.anthropic).toBeNull();
    expect(observed.oauth).toBeNull();
    expect(observed.entrypoint).toBeNull();
    expect(observed.claudeCode).toBeNull();
  });

  it("detects and sanitizes parent Claude session handoff variables", () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: "token",
      CLAUDE_CODE_ENTRYPOINT: "entry",
      CLAUDECODE: "1",
      CLAUDE_MODEL: "claude-sonnet-5",
    } as NodeJS.ProcessEnv;

    expect(detectClaudeAuthPreflightHandoffVars(env)).toEqual([
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(sanitizeClaudeCliEnv(env)).toEqual({ CLAUDE_MODEL: "claude-sonnet-5" });
  });
});
