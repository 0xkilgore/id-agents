import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeCliHarness } from "../../src/harness/claude-code-cli.js";

let tmpDir: string;
let oldClaudePath: string | undefined;
let oldClaudeCliModel: string | undefined;
let oldVerbose: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-cli-model-"));
  oldClaudePath = process.env.CLAUDE_PATH;
  oldClaudeCliModel = process.env.CLAUDE_CLI_MODEL;
  oldVerbose = process.env.ID_AGENT_VERBOSE;
  process.env.ID_AGENT_VERBOSE = "false";
  const fakeClaude = join(tmpDir, "fake-claude.js");
  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.CLAUDE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
      "console.log(JSON.stringify({ result: 'ok', session_id: 'fake-session' }));",
      "",
    ].join("\n"),
  );
  chmodSync(fakeClaude, 0o755);
  process.env.CLAUDE_PATH = fakeClaude;
});

afterEach(() => {
  if (oldClaudePath === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = oldClaudePath;
  if (oldClaudeCliModel === undefined) delete process.env.CLAUDE_CLI_MODEL;
  else process.env.CLAUDE_CLI_MODEL = oldClaudeCliModel;
  if (oldVerbose === undefined) delete process.env.ID_AGENT_VERBOSE;
  else process.env.ID_AGENT_VERBOSE = oldVerbose;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runAndReadArgs(options: { model?: string } = {}): Promise<string[]> {
  const argsOut = join(tmpDir, `args-${Math.random().toString(36).slice(2)}.json`);
  process.env.CLAUDE_ARGS_OUT = argsOut;
  const harness = new ClaudeCodeCliHarness();
  for await (const _ of harness.run("hello", { workingDirectory: tmpDir, ...options })) {
    // drain generator
  }
  return JSON.parse(readFileSync(argsOut, "utf8")) as string[];
}

describe("ClaudeCodeCliHarness model selection", () => {
  it("passes the manager/agent model through to Claude CLI", async () => {
    delete process.env.CLAUDE_CLI_MODEL;

    const args = await runAndReadArgs({ model: "claude-sonnet-5" });

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  it("lets CLAUDE_CLI_MODEL override the agent model", async () => {
    process.env.CLAUDE_CLI_MODEL = "claude-opus-override";

    const args = await runAndReadArgs({ model: "claude-sonnet-5" });

    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-override");
  });
});
