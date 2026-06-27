import { describe, expect, it } from "vitest";

import {
  buildDispatchDetailResponse,
  deriveWriteScope,
  DISPATCH_DETAIL_SCHEMA_VERSION,
  type DispatchDetailSourceRow,
} from "../../src/dispatch-detail/build.js";
import type { DispatchReadRow } from "../../src/dispatch-scheduler/read-model.js";

function sampleSummary(overrides: Partial<DispatchReadRow> = {}): DispatchReadRow {
  return {
    id: "phid:disp-detail-1",
    dispatch_id: "phid:disp-detail-1",
    dispatch_phid: "phid:disp-detail-1",
    query_id: "query_detail_1",
    agent_query_id: "agent_query_detail_1",
    target_agent: "substrate-api-codex",
    agent_id: "substrate-api-codex",
    status: "in_flight",
    title: "Enrich dispatch detail payload",
    subject: "Enrich dispatch detail payload",
    task_name: "dispatch-detail-enrich",
    queued_at: "2026-06-26T10:00:00.000Z",
    in_flight_at: "2026-06-26T10:05:00.000Z",
    done_at: null,
    completed_at: null,
    updated_at: "2026-06-26T10:05:00.000Z",
    failure_kind: null,
    failure_detail: null,
    needs_input: {
      clarification_id: null,
      active: null,
      history: [],
      resume_delivery_status: "none",
    },
    promotion: {
      promote: true,
      strategy: "auto",
      required_reason: null,
      input: {
        repo: "/Users/kilgore/Dropbox/Code/cane/id-agents",
        branch: "feat/dispatch-detail-enrich",
        base: "main",
        remote: "origin",
      },
      result: null,
    },
    recovery: {
      status: "none",
      attempts: 0,
      reason: null,
      side_effect: "none",
      allow_auto_retry: false,
    },
    evidence: {
      artifact_path: null,
      promotion_result: null,
    },
    recovery_classification: null,
    effective_state: "in_flight",
    needs_operator: false,
    sort_group: 1,
    supersede_link: null,
    source_metadata: {
      source: "dispatch_scheduler_queue",
      team_id: "team-1",
      from_actor: "manager",
      channel: "talk",
      provider: "openai",
      runtime: "codex",
      priority: 5,
      attempt_count: 1,
      bounce_count: 0,
      not_before_at: "2026-06-26T10:00:00.000Z",
    },
    source: "manager-http",
    ...overrides,
  };
}

function sampleSource(overrides: Partial<DispatchDetailSourceRow> = {}): DispatchDetailSourceRow {
  return {
    dispatch_phid: "phid:disp-detail-1",
    body_markdown: "[project:kapelle][T-CKPT][BUILD] substrate-api-codex: enrich dispatch detail.\n\nVerify with npm test.",
    bounce_history_json: JSON.stringify([
      { ts: "2026-06-26T10:02:00.000Z", kind: "transport", message: "agent /talk returned 503", attempt: 1 },
    ]),
    result_json: JSON.stringify({
      artifact_path: "/Users/kilgore/Dropbox/Code/cane/id-agents/output/detail-closeout.md",
      tl_dr: "dispatch detail shipped",
    }),
    artifact_path: null,
    promotion_input_json: JSON.stringify({
      repo: "/Users/kilgore/Dropbox/Code/cane/id-agents",
      branch: "feat/dispatch-detail-enrich",
      base: "main",
      remote: "origin",
    }),
    ...overrides,
  };
}

describe("dispatch-detail read model", () => {
  it("buildDispatchDetailResponse exposes dispatch-detail.v1 enriched fields", () => {
    const response = buildDispatchDetailResponse(
      sampleSummary(),
      sampleSource(),
      "2026-06-26T10:10:00.000Z",
    );

    expect(response.ok).toBe(true);
    expect(response.schema_version).toBe(DISPATCH_DETAIL_SCHEMA_VERSION);
    expect(response.generated_at).toBe("2026-06-26T10:10:00.000Z");
    expect(response.dispatch.dispatch_id).toBe("phid:disp-detail-1");
    expect(response.dispatch.message_excerpt).toMatch(/enrich dispatch detail/i);
    expect(response.dispatch.body_excerpt).toMatch(/enrich dispatch detail/i);
    expect(response.dispatch.args_excerpt).toMatch(/enrich dispatch detail/i);
    expect(response.dispatch.body_excerpt).not.toMatch(/\/Users\/kilgore/);
    expect(response.dispatch.write_scope).toEqual([
      "/Users/kilgore/Dropbox/Code/cane/id-agents",
      "/Users/kilgore/Dropbox/Code/cane/id-agents@feat/dispatch-detail-enrich",
    ]);
    expect(response.dispatch.status_timeline.map((event) => event.label)).toEqual([
      "Queued",
      "Bounced",
      "In flight",
    ]);
    expect(response.dispatch.last_error).toBeNull();
    expect(response.dispatch.linked_artifact).toMatchObject({
      id: "dispatch:phid:disp-detail-1",
      basename: "detail-closeout.md",
      status: "available",
      source: "result_json",
    });
    expect(response.dispatch.linked_artifact?.path_redacted).toBe("[local-path]/output/detail-closeout.md");
  });

  it("deriveWriteScope returns repo and repo@branch lanes for build dispatches", () => {
    expect(
      deriveWriteScope({
        repo: "/repo/kapelle-site",
        branch: "feat/x",
        base: "main",
        remote: "origin",
      }),
    ).toEqual(["/repo/kapelle-site", "/repo/kapelle-site@feat/x"]);
    expect(deriveWriteScope(null)).toEqual([]);
  });

  it("surfaces last_error and terminal timeline detail for failed dispatches", () => {
    const response = buildDispatchDetailResponse(
      sampleSummary({
        status: "failed",
        effective_state: "failed_needs_operator",
        completed_at: "2026-06-26T11:00:00.000Z",
        failure_kind: "agent_error",
        failure_detail: "agent /talk returned 422",
      }),
      sampleSource({ bounce_history_json: "[]" }),
    );

    expect(response.dispatch.last_error).toEqual({
      kind: "agent_error",
      detail: "agent /talk returned 422",
    });
    expect(response.dispatch.status_timeline.at(-1)).toMatchObject({
      label: "Failed",
      detail: "agent /talk returned 422",
    });
  });
});
