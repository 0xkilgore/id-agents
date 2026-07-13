import { describe, expect, it } from "vitest";
import {
  parseDuplicateDispatchRetryBlockersArgs,
  runDuplicateDispatchRetryBlockersCli,
} from "../../src/cli/duplicate-dispatch-retry-blockers.js";

describe("duplicate-dispatch-retry-blockers CLI", () => {
  it("parses manager url and json flags", () => {
    expect(parseDuplicateDispatchRetryBlockersArgs(["--manager-url", "http://manager", "--json"], {})).toEqual({
      managerUrl: "http://manager",
      json: true,
    });
  });

  it("prints dry-run classifier items from the manager endpoint", async () => {
    const chunks: string[] = [];
    const seenUrls: string[] = [];
    const exit = await runDuplicateDispatchRetryBlockersCli(["--manager-url", "http://manager"], {
      stdout: (s) => chunks.push(s),
      fetchImpl: (async (input: URL | RequestInfo) => {
        seenUrls.push(String(input));
        return new Response(
          JSON.stringify({
            ok: true,
            report: {
              schema_version: "orchestration.duplicate_dispatch_retry_classification.v2",
              dry_run: true,
              scanned: 7,
              count: 1,
              items: [
                {
                  item_id: "coitem_1",
                  owner: "roger",
                  prior_dispatch_id: "phid:disp-1",
                  prior_dispatch_status: "failed",
                  retry_safe_recommendation: "set_true",
                  operator_disposition: "retry",
                  recommended_disposition: "mark-retry-safe",
                  reason: "prior dispatch failed with retryable transient evidence",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(exit).toBe(0);
    expect(seenUrls).toEqual(["http://manager/orchestration/backlog/duplicate-dispatch-retry-blockers"]);
    expect(chunks.join("")).toContain("duplicate dispatch retry blockers: 1 (scanned 7, dry-run)");
    expect(chunks.join("")).toContain(
      "coitem_1 owner=roger prior=phid:disp-1 status=failed retry_safe=set_true disposition=retry",
    );
  });
});
