// Derived landed-evidence for transport/expiry casualties that never recorded
// an artifact_path or promotion — the recovery side of the hollow-done family.

import { describe, it, expect } from "vitest";
import {
  deriveExpectedArtifacts,
  deriveTrackTag,
  resolveDerivedLanded,
  resolveSupersession,
  type DerivedProbes,
  type RepoRef,
} from "../../src/dispatch-recovery/derived-evidence.js";

const HOME = "/Users/kilgore";
const WIN_START = "2026-06-17T10:00:00.000Z";
const startMs = Date.parse(WIN_START);

describe("deriveExpectedArtifacts", () => {
  it("extracts only DATED deliverable artifacts; excludes tool/log files + templates", () => {
    const got = deriveExpectedArtifacts(
      [
        "save report to ~/Dropbox/Obsidian/sentinel/2026-06-17-sentinel-report.md please",
        "and the svg at /Users/kilgore/Dropbox/Code/rams/output/2026-06-17-one-pager.svg",
        "this one is templated ~/Dropbox/x/report-{date}-{time}.md (skip)",
        "dup ~/Dropbox/Obsidian/sentinel/2026-06-17-sentinel-report.md",
        // persistent tool/log/data files that bodies merely reference — EXCLUDED:
        "process /Users/kilgore/Dropbox/Code/cane/taskview/inbox.md",
        "run /Users/kilgore/Code/cane/taskview/taskview.py",
        "append to /Users/kilgore/Dropbox/Code/agent-platform/output/kapelle-bug-squash-log.md",
      ],
      HOME,
    );
    expect(got).toContain("/Users/kilgore/Dropbox/Obsidian/sentinel/2026-06-17-sentinel-report.md");
    expect(got).toContain("/Users/kilgore/Dropbox/Code/rams/output/2026-06-17-one-pager.svg");
    expect(got.filter((p) => p.endsWith("2026-06-17-sentinel-report.md"))).toHaveLength(1); // dedup
    // none of the tool/log/template files leak in
    expect(got.some((p) => p.endsWith("inbox.md"))).toBe(false);
    expect(got.some((p) => p.endsWith("taskview.py"))).toBe(false);
    expect(got.some((p) => p.endsWith("kapelle-bug-squash-log.md"))).toBe(false);
    expect(got.some((p) => p.includes("{date}"))).toBe(false);
  });
});

describe("deriveTrackTag", () => {
  it("pulls the first track/bug/HC tag", () => {
    expect(deriveTrackTag("[project: kapelle][T-CKPT.0 Tier-0 polish]")).toBe("T-CKPT.0");
    expect(deriveTrackTag("[T15 — CONFIRM Liz isolation]")).toBe("T15");
    expect(deriveTrackTag("fix BUG-004 lookup")).toBe("BUG-004");
    expect(deriveTrackTag("no tag here")).toBeNull();
  });
});

function probes(over: Partial<DerivedProbes> = {}): DerivedProbes {
  return { fileMtimeMs: () => null, ...over };
}

const baseRow = {
  dispatch_phid: "phid:disp-x",
  to_agent: "rams",
  subject: "[project: kapelle / rams][one-pager VISUAL]",
  body_markdown: "save it to ~/Dropbox/Code/rams/output/2026-06-17-one-pager.svg",
  window_start: WIN_START,
};

describe("resolveDerivedLanded", () => {
  it("LANDED when a named artifact exists within the claim window", () => {
    const r = resolveDerivedLanded(baseRow, probes({ fileMtimeMs: () => startMs + 60_000 }), {});
    expect(r.landed).toBe(true);
    expect(r.kind).toBe("artifact_present");
    expect(r.evidence).toContain("2026-06-17-one-pager.svg");
  });

  it("NOT landed when the named artifact pre-dates the dispatch (not its output)", () => {
    const r = resolveDerivedLanded(baseRow, probes({ fileMtimeMs: () => startMs - 86_400_000 }), {});
    expect(r.landed).toBe(false);
  });

  it("NOT landed when the named artifact is missing", () => {
    const r = resolveDerivedLanded(baseRow, probes({ fileMtimeMs: () => null }), {});
    expect(r.landed).toBe(false);
    expect(r.kind).toBe("none");
  });

  it("LANDED via a commit on the owner agent's single-writer repo within the window", () => {
    const repos: Record<string, RepoRef> = { regina: { path: "/repo/kapelle-site", base: "main" } };
    const row = {
      dispatch_phid: "phid:disp-y",
      to_agent: "regina",
      subject: "[project: kapelle][T-CKPT.0 Tier-0 polish]",
      body_markdown: "do the polish",
      window_start: WIN_START,
    };
    const r = resolveDerivedLanded(
      row,
      probes({ commitInWindow: (_repo, since, until) => (startMs >= since && startMs <= until ? "4142063" : null) }),
      repos,
    );
    expect(r.landed).toBe(true);
    expect(r.kind).toBe("commit_on_base");
    expect(r.evidence).toBe("4142063");
  });

  it("does NOT use commit evidence for a non-code agent (no repo mapping)", () => {
    const row = {
      dispatch_phid: "phid:disp-q",
      to_agent: "sentinel",
      subject: "[T15 — verify]",
      body_markdown: "verify",
      window_start: WIN_START,
    };
    // commitInWindow would return a sha, but sentinel has no repo mapping → ignored.
    const r = resolveDerivedLanded(row, probes({ commitInWindow: () => "deadbeef" }), {});
    expect(r.landed).toBe(false);
  });

  it("NOT landed when there is neither a named artifact nor a tag commit", () => {
    const row = {
      dispatch_phid: "phid:disp-z",
      to_agent: "sentinel",
      subject: "[VERIFY — re-run smoke]",
      body_markdown: "re-run the smoke and confirm",
      window_start: WIN_START,
    };
    expect(resolveDerivedLanded(row, probes(), {}).landed).toBe(false);
  });
});

describe("resolveSupersession", () => {
  const reFire = {
    dispatch_phid: "phid:disp-old",
    to_agent: "regina",
    subject: "[project: kapelle][T15 — CONFIRM Liz isolation, RE-FIRE]",
    body_markdown: "re-run",
    window_start: WIN_START,
  };

  it("superseded when a later same-agent same-tag dispatch succeeded", () => {
    const r = resolveSupersession(reFire, {
      laterSuccessForTag: (agent, tag) => (agent === "regina" && tag === "T15" ? "phid:disp-new" : null),
    });
    expect(r.superseded).toBe(true);
    expect(r.by).toBe("phid:disp-new");
  });

  it("not superseded when no later success exists", () => {
    expect(resolveSupersession(reFire, { laterSuccessForTag: () => null }).superseded).toBe(false);
  });

  it("not superseded without a derivable track tag", () => {
    const noTag = { ...reFire, subject: "do a thing" };
    expect(resolveSupersession(noTag, { laterSuccessForTag: () => "phid:x" }).superseded).toBe(false);
  });
});
