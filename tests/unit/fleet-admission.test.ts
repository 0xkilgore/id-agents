import { describe, expect, it } from "vitest";

import { computeFleetAdmissionExclusions } from "../../src/dispatch-scheduler/manager-integration.js";
import type { AgentRow } from "../../src/db/types.js";

function agent(overrides: Partial<AgentRow>): AgentRow {
  return {
    team_id: "team",
    id: overrides.name ?? "agent-id",
    name: overrides.name ?? "agent",
    type: "persistent",
    model: "claude-sonnet",
    port: 1,
    endpoint: "http://127.0.0.1:1",
    working_directory: null,
    status: "running",
    created_at: 0,
    registry: null,
    metadata: null,
    deleted_at: null,
    runtime: "claude-code-cli",
    token_id: null,
    domain: null,
    api_key: null,
    customer_domain: null,
    public_endpoint_url: null,
    internal_endpoint_url: null,
    ssh_target: null,
    last_seen: null,
    last_probed_at: null,
    last_error: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

describe("computeFleetAdmissionExclusions", () => {
  it("excludes stopped legacy Claude builders when a live Codex/Cursor lane exists", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "stopped", runtime: "claude-code-cli" }),
        agent({ id: "agent_codex", name: "codex-builder", status: "running", runtime: "codex" }),
      ]),
    ).toEqual(["brunel", "agent_brunel"]);
  });

  it("does not exclude legacy Claude when no live Codex/Cursor builder exists", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "stopped", runtime: "claude-code-cli" }),
      ]),
    ).toEqual([]);
  });

  it("does not exclude online explicitly requested legacy Claude builders", () => {
    expect(
      computeFleetAdmissionExclusions([
        agent({ id: "agent_brunel", name: "brunel", status: "running", runtime: "claude-code-cli" }),
        agent({ id: "agent_cursor", name: "cursor-builder", status: "active", runtime: "cursor-cli" }),
      ]),
    ).toEqual([]);
  });
});
