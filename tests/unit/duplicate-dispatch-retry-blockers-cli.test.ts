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
      staleClarifications: false,
      olderThanHours: 24,
      limit: 25,
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

  it("requests the bounded stale clarification report and prints supersede-after-review guidance", async () => {
    const chunks: string[] = [];
    const seenUrls: string[] = [];
    const exit = await runDuplicateDispatchRetryBlockersCli(
      ["--manager-url", "http://manager", "--stale-clarifications", "--older-than-hours", "36", "--limit", "5"],
      {
        stdout: (s) => chunks.push(s),
        fetchImpl: (async (input: URL | RequestInfo) => {
          seenUrls.push(String(input));
          return new Response(JSON.stringify({ ok: true, report: {
            dry_run: true, older_than_hours: 36, matched: 1, count: 1,
            guidance: "Review first; supersede if obsolete. Do not mark retry_safe.",
            items: [{ item_id: "coitem_1", prior_dispatch_id: "phid:old", prior_dispatch_age_hours: 48,
              operator_action: "review_then_supersede" }],
          } }), { status: 200 });
        }) as typeof fetch,
      },
    );

    expect(exit).toBe(0);
    expect(seenUrls).toEqual([
      "http://manager/orchestration/backlog/duplicate-dispatch-retry-blockers/stale-clarifications?older_than_hours=36&limit=5",
    ]);
    expect(chunks.join("")).toContain("action=review_then_supersede retry_safe=leave_false");
    expect(chunks.join("")).toContain("Do not mark retry_safe");
  });
});
