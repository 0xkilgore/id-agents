import { describe, expect, it } from "vitest";
import {
  commentRouteStatusFromDispatchResult,
  projectArtifactReviewOperations,
  reduceArtifactReviewOperation,
  type ArtifactReviewDocumentOperation,
} from "../../src/outputs/review-document.js";

const ART = "art-review-doc-1";

function op(
  id: string,
  type: ArtifactReviewDocumentOperation["type"],
  payload: Record<string, unknown> = {},
  over: Partial<ArtifactReviewDocumentOperation> = {},
): ArtifactReviewDocumentOperation {
  return {
    id,
    artifact_id: ART,
    type,
    actor_ref: "user:chris",
    created_at: `2026-07-08T10:0${id.replace(/\D/g, "").slice(-1) || "0"}:00.000Z`,
    payload,
    ...over,
  };
}

describe("ArtifactReview document-operation v0", () => {
  it("replays reviewer, comment, reaction, decision, task link, followup, read ops into review state", () => {
    const routeStatus = commentRouteStatusFromDispatchResult(
      "substantive_follow_up",
      {
        routed: true,
        dispatch: {
          query_id: "query_1",
          dispatch_phid: "phid:disp-1",
          to_agent: "regina",
          to_agent_raw: "regina",
        },
      },
      12,
      "2026-07-08T10:02:30.000Z",
    );
    const state = projectArtifactReviewOperations(ART, [
      op("op-1", "assign_reviewer", { reviewer_ref: "user:liz" }),
      op("op-2", "mark_read", {}, { actor_ref: "user:liz" }),
      op("op-3", "comment", { body: "Please tighten this.", anchor: "intro", route_status: routeStatus }),
      op("op-4", "react", { reaction: "ship_it", note: "after copy pass" }),
      op("op-5", "link_task", { task_ref: "task_123", note: "tracks revision" }),
      op("op-6", "create_followup", { task_ref: "task_456", dispatch_ref: "phid:disp-2", title: "Revise artifact" }),
      op("op-7", "request_changes", {}, { actor_ref: "user:liz" }),
    ]);

    expect(state.reviewer_ref).toBe("user:liz");
    expect(state.read_by["user:liz"]).toBe("2026-07-08T10:02:00.000Z");
    expect(state.comments[0]).toMatchObject({
      operation_id: "op-3",
      body: "Please tighten this.",
      anchor: "intro",
      route_status: { visible_state: "recorded+routed", routed: true },
    });
    expect(state.reactions[0]).toMatchObject({ reaction: "ship_it", note: "after copy pass" });
    expect(state.linked_tasks[0].task_ref).toBe("task_123");
    expect(state.followups[0]).toMatchObject({ task_ref: "task_456", dispatch_ref: "phid:disp-2" });
    expect(state.status).toBe("changes_requested");
    expect(state.request_changes_by).toBe("user:liz");
    expect(state.operation_ids).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5", "op-6", "op-7"]);
    expect(state.projection_cursor).toEqual({
      last_operation_id: "op-7",
      last_created_at: "2026-07-08T10:07:00.000Z",
      applied_count: 7,
    });
  });

  it("ignores duplicate idempotency keys and duplicate operation ids", () => {
    const first = op("op-1", "approve", {}, { idempotency_key: "decision-1" });
    const duplicateKey = op("op-2", "reject", {}, { idempotency_key: "decision-1", actor_ref: "user:liz" });
    const duplicateId = op("op-1", "comment", { body: "should not land" });

    const state = projectArtifactReviewOperations(ART, [first, duplicateKey, duplicateId]);

    expect(state.status).toBe("approved");
    expect(state.approved_by).toBe("user:chris");
    expect(state.rejected_by).toBeNull();
    expect(state.comments).toHaveLength(0);
    expect(state.operation_ids).toEqual(["op-1"]);
    expect(state.idempotency_keys).toEqual(["decision-1"]);
    expect(state.projection_cursor.applied_count).toBe(1);
  });

  it("keeps rejected and failed route results visible instead of green local-only success", () => {
    const failed = commentRouteStatusFromDispatchResult(
      "substantive_follow_up",
      {
        routed: false,
        target_agent: "regina",
        target_agent_raw: "regina",
        error: { message: "scheduler boom" },
      },
      42,
      "2026-07-08T11:00:00.000Z",
    );
    const rejected = commentRouteStatusFromDispatchResult(
      "substantive_follow_up",
      {
        routed: false,
        target_agent: "regina",
        target_agent_raw: "regina",
        skipped: "scheduler_unavailable",
      },
      43,
      "2026-07-08T11:01:00.000Z",
    );

    expect(failed).toMatchObject({
      visible_state: "recorded-but-route-failed-with-retry",
      routed: false,
      retryable: true,
      target_agent: "regina",
      error: { message: "scheduler boom" },
    });
    expect(rejected).toMatchObject({
      visible_state: "recorded-but-route-failed-with-retry",
      routed: false,
      retryable: true,
      skipped: "scheduler_unavailable",
    });

    const state = reduceArtifactReviewOperation(
      projectArtifactReviewOperations(ART, [op("op-1", "comment", { body: "route failed", route_status: failed })]),
      op("op-2", "comment", { body: "route rejected", route_status: rejected }),
    );
    expect(state.comments.map((comment) => comment.route_status?.visible_state)).toEqual([
      "recorded-but-route-failed-with-retry",
      "recorded-but-route-failed-with-retry",
    ]);
  });
});
