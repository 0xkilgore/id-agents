import { describe, expect, it } from "vitest";
import {
  parseStaleDuplicateBacklogArgs,
  runStaleDuplicateBacklogCli,
} from "../../src/cli/stale-duplicate-backlog.js";

describe("stale-duplicate-backlog CLI", () => {
  it("passes a bounded limit to the dry-run report endpoint", async () => {
    const seenUrls: string[] = [];
    const chunks: string[] = [];

    const code = await runStaleDuplicateBacklogCli(["--manager-url", "http://manager", "--limit", "2"], {
      fetchImpl: (async (url: URL) => {
        seenUrls.push(url.toString());
        return new Response(
          JSON.stringify({
            ok: true,
            report: {
              schema_version: "orchestration.stale_duplicate_backlog_report.v1",
              dry_run: true,
              scanned: 5,
              limit: 2,
              matched: 3,
              truncated: true,
              count: 2,
              items: [
                {
                  item_id: "coitem_a",
                  title: "done duplicate",
                  readiness_state: "ready",
                  prior_dispatch_phid: "phid:disp-a",
                  prior_terminal_status: "done",
                  promotion_verified: false,
                  recommended_action: "mark_done",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      stdout: (s) => chunks.push(s),
    });

    expect(code).toBe(0);
    expect(seenUrls).toEqual(["http://manager/orchestration/backlog/stale-duplicates?limit=2"]);
    expect(chunks.join("")).toContain("stale duplicate backlog rows: 2 (matched 3, scanned 5, dry-run, 1 more matched)");
  });

  it("rejects invalid limits", () => {
    expect(() => parseStaleDuplicateBacklogArgs(["--limit", "0"])).toThrow(/positive number/);
  });
});
