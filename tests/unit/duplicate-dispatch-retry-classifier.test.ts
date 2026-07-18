import { describe, expect, it } from "vitest";

import {
  classifyDuplicateDispatchFailure,
  classifyDuplicateDispatchRetryDisposition,
} from "../../src/continuous-orchestration/duplicate-dispatch-retry-classifier.js";
import type { DispatchOutcome } from "../../src/continuous-orchestration/storage.js";

function outcome(overrides: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    dispatch_phid: "phid:disp-gaudi-404",
    status: "failed",
    recovery_status: "none",
    failure_kind: "agent_error",
    failure_detail: 'dispatch routing failed: HTTP 404 from /talk for agent "gaudi"',
    recovery_attempts: 0,
    promote: true,
    promotion_required_reason: "build dispatch",
    promotion_result_json: null,
    ...overrides,
  };
}

describe("duplicate dispatch retry classifier", () => {
  it("classifies Gaudi verification HTTP 404 route failures as reroute/supersede, not retry-safe", () => {
    const failed = outcome();

    expect(classifyDuplicateDispatchFailure(failed)).toBe("dispatch_route_not_found");
    expect(classifyDuplicateDispatchRetryDisposition(failed)).toEqual({
      recommended_disposition: "supersede",
      operator_disposition: "reroute",
      retry_safe_recommendation: "leave_false",
      reason:
        "prior dispatch phid:disp-gaudi-404 failed because the target route returned HTTP 404; " +
        "reroute to a healthy compatible owner or supersede the stale target pin before retry",
    });
  });

  it("treats failed rows with superseded reliability evidence as stale duplicates, not retry candidates", () => {
    const failed = outcome({
      dispatch_phid: "phid:disp-superseded-evidence",
      failure_kind: "linked_query_terminated",
      failure_detail: "linked query terminated expired",
      reliability_classification: "superseded",
      reliability_classification_reason: "later dedup_key sibling completed successfully",
    });

    expect(classifyDuplicateDispatchFailure(failed)).toBe("stale_duplicate");
    expect(classifyDuplicateDispatchRetryDisposition(failed)).toEqual({
      recommended_disposition: "supersede",
      operator_disposition: "close",
      retry_safe_recommendation: "leave_false",
      reason: "prior dispatch phid:disp-superseded-evidence is terminal superseded; supersede the stale duplicate ready row",
    });
  });
});
