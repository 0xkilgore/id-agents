import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import {
  appendArtifactComment,
  appendArtifactReceipt,
  authorArtifactDocument,
  type ArtifactDocumentReceiptKind,
} from "../../src/doc-model/artifact-document.js";
import { projectNowSurface } from "../../src/doc-model/artifact-surfaces.js";
import { reconcileFeedbackDispatchStatus } from "../../src/outputs/ops.js";
import type {
  ActedUponSummary,
  ArtifactCommentRouteStatus,
  DispatchStatusLite,
  FeedbackItem,
  FeedbackRouting,
} from "../../src/outputs/types.js";

interface ReceiptContractCase {
  id: string;
  source_link: string | null;
  route: {
    visible_state: ArtifactCommentRouteStatus["visible_state"];
    routed: boolean;
    retryable: boolean;
    notification_status: ArtifactCommentRouteStatus["notification_status"];
    next_retry_at: string | null;
  };
  routing: Pick<FeedbackRouting, "dispatch_phid" | "query_id" | "to_agent"> | null;
  dispatch: DispatchStatusLite | null;
  expected: {
    ui_state: string;
    route_state: string;
    retry_drain_status: string;
    retryable: boolean;
    stale_duplicate: boolean;
    proof_classification: string;
    work_success: boolean | null;
    work_success_blocker: string | null;
  };
  now: {
    receipt: { kind: ArtifactDocumentReceiptKind; actor: string; note: string } | null;
    receipt_position: "before_comment" | "after_comment" | null;
    included: boolean;
    receipt_state: "receipted" | "unreceipted" | null;
    source_link_state: "present" | "missing" | null;
  };
}

interface ReceiptContractFixture {
  schema_version: string;
  contract: {
    canonical_response_schema: string;
    retry_readiness_schema: string;
    evidence_schema: string;
    evidence_rollup_schema: string;
    now_surface_schema: string;
  };
  cases: ReceiptContractCase[];
}

const fixture = JSON.parse(
  fs.readFileSync("tests/fixtures/console/artifact-feedback-receipt-contracts.json", "utf8"),
) as ReceiptContractFixture;

function routeStatus(contract: ReceiptContractCase, opId: number): ArtifactCommentRouteStatus {
  const dispatch = contract.routing
    ? {
        dispatch_phid: contract.routing.dispatch_phid,
        query_id: contract.routing.query_id,
        to_agent: contract.routing.to_agent,
      }
    : null;
  return {
    visible_state: contract.route.visible_state,
    compat_status: contract.route.visible_state,
    feedback_status: contract.route.visible_state,
    route_kind: "substantive_follow_up",
    routed: contract.route.routed,
    retryable: contract.route.retryable,
    recorded_op_id: opId,
    target_agent: "regina",
    target_agent_raw: "regina",
    dispatch,
    skipped: contract.route.retryable ? "scheduler_unavailable" : null,
    error: null,
    deadline_at: "2026-08-04T15:05:00.000Z",
    timed_out_at: null,
    notification_status: contract.route.notification_status,
    next_retry_at: contract.route.next_retry_at,
    suppress_duplicate_key: `artifact-comment:${opId}:timeout`,
    updated_at: "2026-08-04T15:00:00.000Z",
  };
}

function feedbackItem(contract: ReceiptContractCase, opId: number): FeedbackItem {
  const sourceLink = contract.source_link?.trim() || null;
  const routing: FeedbackRouting | null = contract.routing
    ? { ...contract.routing, routed_at: "2026-08-04T15:00:01.000Z" }
    : null;
  return {
    comment_id: `acmt:art-feedback-${contract.id}:${opId}`,
    op_id: opId,
    actor: "human:chris",
    kind: "comment",
    reaction: null,
    body: `Fixture feedback: ${contract.id}`,
    anchor: null,
    ts: "2026-08-04T15:00:00.000Z",
    source_link: sourceLink,
    source_link_state: sourceLink ? "present" : "missing",
    source_link_reason: sourceLink ? null : "source_link_missing",
    routing,
    route_status: routeStatus(contract, opId),
  };
}

function feedbackProjection(item: FeedbackItem): { items: FeedbackItem[]; acted_upon: ActedUponSummary } {
  const routings = item.routing ? [item.routing] : [];
  return {
    items: [item],
    acted_upon: {
      state: routings.length ? "routed" : "captured",
      feedback_count: 1,
      reaction_count: 0,
      routed_count: routings.length,
      last_reaction: null,
      last_feedback_at: item.ts,
      routed_dispatches: routings,
    },
  };
}

describe("artifact feedback receipt fixture contracts", () => {
  it("keeps the canonical feedback reader schemas and state vocabulary compatible", async () => {
    expect(fixture.schema_version).toBe("console.artifact_feedback_receipt_fixtures.v1");
    expect(fixture.contract).toEqual({
      canonical_response_schema: "artifact.feedback.v1",
      retry_readiness_schema: "feedback.retry_readiness.v1",
      evidence_schema: "feedback.evidence.v1",
      evidence_rollup_schema: "feedback.evidence_rollup.v1",
      now_surface_schema: "read-model.v1",
    });
    expect(fixture.cases.map((contract) => contract.id)).toEqual([
      "recorded-routed",
      "route-failed-retryable",
      "retry-pending",
      "terminal-success",
      "terminal-failure",
      "source-link-absent",
      "stale-receipt",
    ]);

    for (const [index, contract] of fixture.cases.entries()) {
      const item = feedbackItem(contract, index + 1);
      const out = await reconcileFeedbackDispatchStatus(
        feedbackProjection(item),
        async (dispatchPhid) => {
          expect(dispatchPhid).toBe(contract.routing?.dispatch_phid);
          return contract.dispatch;
        },
      );
      const projected = out.items[0];
      expect(projected.retry_readiness?.schema_version, contract.id)
        .toBe(fixture.contract.retry_readiness_schema);
      expect(projected.feedback_evidence?.schema_version, contract.id)
        .toBe(fixture.contract.evidence_schema);
      expect(out.acted_upon.feedback_evidence?.schema_version, contract.id)
        .toBe(fixture.contract.evidence_rollup_schema);
      expect(projected.feedback_evidence, contract.id).toMatchObject(contract.expected);
    }
  });

  it("requires explicit manager proof before a terminal receipt can claim work success", async () => {
    const byId = new Map(fixture.cases.map((contract) => [contract.id, contract]));
    const terminalSuccess = byId.get("terminal-success")!;
    const terminalFailure = byId.get("terminal-failure")!;
    const staleReceipt = byId.get("stale-receipt")!;

    for (const contract of [terminalSuccess, terminalFailure, staleReceipt]) {
      const out = await reconcileFeedbackDispatchStatus(
        feedbackProjection(feedbackItem(contract, 1)),
        async () => contract.dispatch,
      );
      const evidence = out.items[0].feedback_evidence!;
      expect(evidence.work_success, contract.id).toBe(contract.expected.work_success);
      expect(evidence.proof_classification, contract.id).toBe(contract.expected.proof_classification);
    }

    expect(terminalSuccess.dispatch?.work_success).toBe(true);
    expect(terminalSuccess.dispatch?.work_success_evidence).toBe("artifact_update_confirmed");
    expect(terminalFailure.dispatch?.work_success).toBe(false);
    expect(staleReceipt.dispatch?.work_success).toBeUndefined();
  });
});

describe("Now projection feedback receipt fixture contracts", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = new SqliteAdapter(":memory:");
    await migrateSqlite(adapter);
  });

  it("keeps open, terminal, missing-source, and stale receipts honest", async () => {
    for (const contract of fixture.cases) {
      const documentId = `doc:${contract.id}`;
      await authorArtifactDocument(adapter, {
        teamId: "default",
        documentId,
        ownerAgent: "regina",
        actor: "regina",
        title: `Feedback receipt fixture: ${contract.id}`,
        tag: "artifact-feedback-receipt",
        content: `# ${contract.id}`,
        sourceLink: contract.source_link,
        availability: "present",
        audience: "operator",
        kind: "document",
        project: "kapelle",
        now: "2026-08-04T14:58:00.000Z",
      });

      if (contract.now.receipt && contract.now.receipt_position === "before_comment") {
        await appendArtifactReceipt(adapter, {
          documentId,
          ...contract.now.receipt,
          now: "2026-08-04T14:59:00.000Z",
        });
      }
      await appendArtifactComment(adapter, {
        documentId,
        actor: "human:chris",
        body: `Fixture feedback: ${contract.id}`,
        now: "2026-08-04T15:00:00.000Z",
      });
      if (contract.now.receipt && contract.now.receipt_position === "after_comment") {
        await appendArtifactReceipt(adapter, {
          documentId,
          ...contract.now.receipt,
          now: "2026-08-04T15:01:00.000Z",
        });
      }
    }

    const now = await projectNowSurface(adapter, "default");
    expect(now.schema_version).toBe(fixture.contract.now_surface_schema);
    const byId = new Map(now.items.map((item) => [item.phid, item]));

    for (const contract of fixture.cases) {
      const item = byId.get(`doc:${contract.id}`);
      expect(Boolean(item), contract.id).toBe(contract.now.included);
      if (!contract.now.included) continue;
      expect(item?.now_state, contract.id).toMatchObject({
        blocker_kind: "feedback_blocker",
        route_state: "awaiting_response",
        receipt_state: contract.now.receipt_state,
        source_link_state: contract.now.source_link_state,
      });
    }

    const stale = byId.get("doc:stale-receipt")!;
    expect(stale.now_state.latest_receipt).toMatchObject({
      actor: "regina",
      kind: "approve",
      note: "older feedback was acknowledged",
      ts: "2026-08-04T14:59:00.000Z",
    });
    expect(stale.now_state.latest_comment).toMatchObject({
      actor: "human:chris",
      ts: "2026-08-04T15:00:00.000Z",
    });
  });
});
