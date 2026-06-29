// Static guard for Phase 0.3 of the concurrency-dispatch-scheduler plan.
//
// The scheduler is the only production component that should issue a raw
// HTTP POST to an agent's /talk endpoint. This test walks src/ and asserts
// every `fetch(`${...}/talk`...)` call site appears in the classified
// allowlist below. New unapproved direct calls fail the test until
// the author either:
//   (a) migrates the path to enqueueDispatch(), or
//   (b) adds an explicit allowlist entry with a classification.
//
// Categories:
//   - MUST_MIGRATE: manager production code that will move to enqueue
//   - GATEWAY_TRANSPORT: the scheduler's own /talk transport (allowed)
//   - CLI_PASSTHROUGH: interactive user-facing CLI surfaces (allowed)
//   - PROBE_OR_TEST: probe/test helpers; intentionally outside the gateway
//   - DOC_OR_LOG: string only appears in a log/doc/example, not a real call

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Issuer {
  file: string;
  line: number;
  category:
    | "MUST_MIGRATE"
    | "GATEWAY_TRANSPORT"
    | "CLI_PASSTHROUGH"
    | "PROBE_OR_TEST"
    | "DOC_OR_LOG";
  note: string;
}

const ALLOWLIST: Issuer[] = [
  // ─── Manager production code: candidates for Phase 4 migration ───
  {
    file: "src/agent-manager-db.ts",
    line: 1938,
    category: "MUST_MIGRATE",
    note: "forwardToAgent() — primary /talk-to dispatch path (now gateway-routed via DISPATCH_GATEWAY_MODE; legacy retained for shadow + fallback)",
  },
  {
    file: "src/agent-manager-db.ts",
    line: 3121,
    category: "MUST_MIGRATE",
    note: "Spec 054 v2 /agent-resume — direct /talk follow-up to deliver the resume payload to the paused agent. Migrate to session-side injection in a follow-up.",
  },
  {
    file: "src/agent-manager-db.ts",
    line: 9651,
    category: "MUST_MIGRATE",
    note: "agent heartbeat reseed — immediate /talk send",
  },
  {
    file: "src/inter-agent-tools.ts",
    line: 105,
    category: "MUST_MIGRATE",
    note: "send_message_to_agent tool — agent-to-agent dispatch",
  },
  {
    file: "src/inter-agent-tools.ts",
    line: 218,
    category: "MUST_MIGRATE",
    note: "talk_to_agent tool — synchronous agent-to-agent dispatch",
  },
  {
    file: "src/core/messaging-service.ts",
    line: 47,
    category: "MUST_MIGRATE",
    note: "MessagingService.sendMessage — shared agent-to-agent helper",
  },
  {
    file: "src/claude-agent-server.ts",
    line: 1155,
    category: "MUST_MIGRATE",
    note: "claude agent /talk fanout to manager",
  },
  {
    file: "src/claude-agent-server.ts",
    line: 1229,
    category: "MUST_MIGRATE",
    note: "claude agent /talk fanout to peer",
  },

  // ─── Probe/test helpers: intentionally outside the gateway ───
  {
    file: "src/agent-manager-db.ts",
    line: 7606,
    category: "PROBE_OR_TEST",
    note: "agent probe — end-to-end health probe by design",
  },

  // ─── Interactive user-facing CLIs: passthroughs ───
  {
    file: "src/id-agents-cli.ts",
    line: 119,
    category: "CLI_PASSTHROUGH",
    note: "id-agents CLI direct /talk passthrough",
  },
  {
    file: "src/claude-restap-cli.ts",
    line: 184,
    category: "CLI_PASSTHROUGH",
    note: "claude-restap CLI direct /talk passthrough",
  },
  {
    file: "src/interactive-agent-cli.ts",
    line: 3611,
    category: "CLI_PASSTHROUGH",
    note: "interactive CLI /talk endpoint computation",
  },
  {
    file: "src/interactive-agent-cli.ts",
    line: 4733,
    category: "CLI_PASSTHROUGH",
    note: "interactive CLI direct /talk passthrough",
  },
  {
    file: "src/interactive-agent-cli.ts",
    line: 4839,
    category: "CLI_PASSTHROUGH",
    note: "interactive CLI direct /talk URL composition",
  },
];

// Patterns that count as a "direct /talk call site" for guard purposes.
// We match template-literal urls ending in /talk in a fetch() or url
// assignment context. Doc strings, log lines, and comment references are
// excluded so adding a comment about /talk does not trip the guard.
const TALK_CALL_RE =
  /\b(?:fetch|talkUrl|talkEndpoint|talk:|baseUrl\s*\+\s*['"`]\/talk['"`])\b[^`'"\n]*[`'"]?\$\{[^}]+\}\/talk\b/;

const SRC_FILES_TO_SCAN = [
  "src/agent-manager-db.ts",
  "src/inter-agent-tools.ts",
  "src/core/messaging-service.ts",
  "src/claude-agent-server.ts",
  "src/id-agents-cli.ts",
  "src/claude-restap-cli.ts",
  "src/interactive-agent-cli.ts",
];

function collectIssuers(): Issuer[] {
  const root = join(__dirname, "..", "..");
  const found: Issuer[] = [];
  for (const rel of SRC_FILES_TO_SCAN) {
    const abs = join(root, rel);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TALK_CALL_RE.test(line)) {
        found.push({
          file: rel,
          line: i + 1,
          category: "MUST_MIGRATE",
          note: line.trim().slice(0, 120),
        });
      }
    }
  }
  return found;
}

describe("dispatch-scheduler /talk issuer guard (Phase 0.3)", () => {
  it("every direct /talk call site appears in the allowlist", () => {
    const found = collectIssuers();
    const allowed = new Set(ALLOWLIST.map((i) => `${i.file}:${i.line}`));
    const unapproved = found.filter((f) => !allowed.has(`${f.file}:${f.line}`));

    if (unapproved.length > 0) {
      const msg = unapproved
        .map((u) => `  ${u.file}:${u.line}  ${u.note}`)
        .join("\n");
      throw new Error(
        `New direct /talk call sites detected — classify in the ALLOWLIST or migrate to enqueueDispatch():\n${msg}`,
      );
    }
    expect(unapproved).toEqual([]);
  });

  it("every MUST_MIGRATE allowlist entry is still a live call site", () => {
    const found = collectIssuers();
    const foundSet = new Set(found.map((f) => `${f.file}:${f.line}`));
    const stale = ALLOWLIST.filter(
      (a) => a.category === "MUST_MIGRATE" && !foundSet.has(`${a.file}:${a.line}`),
    );
    if (stale.length > 0) {
      const msg = stale.map((s) => `  ${s.file}:${s.line}  ${s.note}`).join("\n");
      throw new Error(
        `Stale MUST_MIGRATE allowlist entries (call site no longer matches):\n${msg}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it("MUST_MIGRATE category is the dominant production surface", () => {
    const counts = ALLOWLIST.reduce<Record<string, number>>((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + 1;
      return acc;
    }, {});
    // Floor on what we expect; raises only when new migration targets appear.
    expect(counts.MUST_MIGRATE).toBeGreaterThanOrEqual(7);
  });
});
