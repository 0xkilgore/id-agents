import { describe, expect, it } from "vitest";

import {
  buildReleaseProofReadiness,
  readReleaseProofReadiness,
  type ReleaseProofReadinessInput,
} from "../../src/continuous-orchestration/release-proof-readiness.js";
import {
  insertBacklogItem,
  reconcileStaleAlreadyDispatchedReadyRows,
  recordTickOutcome,
  setMode,
} from "../../src/continuous-orchestration/storage.js";
import { migrateSqlite } from "../../src/db/migrations/sqlite.js";
import { SqliteAdapter } from "../../src/db/sqlite-adapter.js";
import { migrateOutputsTables } from "../../src/outputs/storage.js";

const NOW = "2026-07-13T12:00:00.000Z";

function base(overrides: Partial<ReleaseProofReadinessInput> = {}): ReleaseProofReadinessInput {
  return {
    generated_at: NOW,
    project: "kapelle",
    feedback_evidence: [
      {
        id: "op:1",
        kind: "comment_recorded",
        observed_at: "2026-07-13T11:30:00.000Z",
        source_link: "https://manager.local/artifacts/art-kapelle/comments#op-1",
        artifact_id: "art-kapelle",
        summary: "Chris approved the release proof evidence.",
      },
    ],
    infra_warnings: [],
    source_links: [
      {
        label: "kapelle-feedback-register",
        href: "https://github.com/example/kapelle-feedback-register.md",
        source: "backlog",
      },
    ],
    generated_artifacts: [
      {
        artifact_id: "art-kapelle",
        path: "/tmp/output/kapelle-release-proof.md",
        title: "Kapelle release proof",
        produced_at: "2026-07-13T11:20:00.000Z",
        source_link: "delivery-log",
        availability: "present",
      },
    ],
    stale_after_ms: 60 * 60 * 1000,
    ...overrides,
  };
}

describe("buildReleaseProofReadiness", () => {
  it("reports release ready when feedback, sources, artifacts, and infra state are clean", () => {
    const view = buildReleaseProofReadiness(base());

    expect(view).toMatchObject({
      schema_version: "release_proof.readiness.v1",
      project: "kapelle",
      release_readiness: "ready",
      chris_readable_release_ready: "READY",
      feedback_freshness: { state: "present", stale: false, reason: null },
      infra_warning: { state: "clear", count: 0, requires_operator_review: false },
      source_link_state: { state: "present", safe_count: 1, unsafe_count: 0, total_count: 1 },
      next_owner: { lane: "none", action: null, reason: null, candidates: [] },
      feedback_evidence: { state: "present", count: 1 },
      infra_warnings: { state: "clear", count: 0, source: "none", action: null },
      sources: { state: "present" },
      generated_artifacts: { state: "present", count: 1 },
    });
    expect(view.sources.counts).toEqual({ safe: 1, unsafe: 0, total: 1 });
    expect(view.stale_reasons).toEqual([]);
    expect(view.error_reasons).toEqual([]);
    expect(view.missing_reasons).toEqual([]);
  });

  it("reports empty evidence as not ready with generated artifact and source gaps", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [],
      source_links: [],
      generated_artifacts: [],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.chris_readable_release_ready).toBe("NOT READY");
    expect(view.feedback_evidence.state).toBe("empty");
    expect(view.generated_artifacts.state).toBe("missing");
    expect(view.sources.state).toBe("missing");
    expect(view.missing_reasons).toEqual([
      "no feedback evidence has been recorded for this release proof",
      "no generated release proof artifacts are registered",
      "no source links are attached to the release proof",
    ]);
  });

  it("reports stale feedback evidence as not ready", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:old",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: "https://manager.local/artifacts/art-kapelle/comments#op-old",
          artifact_id: "art-kapelle",
          summary: "Old feedback.",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_evidence.state).toBe("stale");
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 1h"]);
    expect(view.summary).toContain("older than 1h");
  });

  it("reports load errors as not ready without pretending empty data is clean", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [],
      infra_warnings: [],
      source_links: [],
      generated_artifacts: [],
      load_error: "artifact_operations table unavailable",
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_evidence.state).toBe("error");
    expect(view.infra_warnings).toMatchObject({
      state: "error",
      count: 0,
      source: "readiness_loader",
      action: "restore release-proof data sources and retry readiness",
    });
    expect(view.error_reasons).toEqual(["artifact_operations table unavailable"]);
    expect(view.summary).toBe("Release proof is not ready: artifact_operations table unavailable.");
  });

  it("reports source-missing evidence and artifact pointers as not ready", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:source-missing",
          kind: "comment_recorded",
          observed_at: "2026-07-13T11:30:00.000Z",
          source_link: null,
          artifact_id: "art-kapelle",
          summary: "Feedback without durable source.",
        },
      ],
      source_links: [],
      generated_artifacts: [
        {
          artifact_id: "art-source-missing",
          path: null,
          title: "Kapelle release proof",
          produced_at: "2026-07-13T11:20:00.000Z",
          source_link: null,
          availability: "present",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_evidence.state).toBe("present");
    expect(view.generated_artifacts.state).toBe("missing");
    expect(view.sources.state).toBe("missing");
    expect(view.missing_reasons).toEqual([
      "one or more generated artifacts are missing safe source links",
      "no source links are attached to the release proof",
      "one or more feedback evidence items are missing safe source links",
    ]);
  });

  it("does not treat a local generated body as a source link when artifact source is missing", () => {
    const view = buildReleaseProofReadiness(base({
      generated_artifacts: [
        {
          artifact_id: "art-local-body-only",
          path: "/tmp/output/kapelle-release-proof.md",
          title: "Kapelle release proof",
          produced_at: "2026-07-13T11:45:00.000Z",
          source_link: null,
          availability: "present",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.generated_artifacts.state).toBe("missing");
    expect(view.missing_reasons).toEqual(["one or more generated artifacts are missing safe source links"]);
    expect(view.sources.links).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ href: "/tmp/output/kapelle-release-proof.md" })]),
    );
  });

  it("blocks redacted feedback sources and does not expose the redacted href", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:redacted-source",
          kind: "comment_recorded",
          observed_at: "2026-07-13T11:30:00.000Z",
          source_link: "[redacted]",
          artifact_id: "art-kapelle",
          summary: "Feedback with redacted source.",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items are missing safe source links"]);
    expect(view.sources.links).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ href: "[redacted]" })]),
    );
  });

  it("blocks unsupported source hrefs and omits them from exposed sources", () => {
    const view = buildReleaseProofReadiness(base({
      source_links: [
        {
          label: "unsafe-local-file",
          href: "file:///Users/kilgore/Dropbox/Code/roger/output/kapelle-release-proof.md",
          source: "backlog",
        },
        {
          label: "unsafe-js",
          href: "javascript:alert(1)",
          source: "feedback",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.sources).toEqual({
      state: "missing",
      counts: { safe: 0, unsafe: 2, total: 2 },
      links: [],
    });
    expect(view.missing_reasons).toEqual([
      "one or more source links are redacted or unsupported",
      "no source links are attached to the release proof",
    ]);
  });

  it("blocks stale generated artifacts without reporting false release success", () => {
    const view = buildReleaseProofReadiness(base({
      generated_artifacts: [
        {
          artifact_id: "art-stale-generated",
          path: "/tmp/output/kapelle-release-proof.md",
          title: "Kapelle release proof",
          produced_at: "2026-07-13T09:00:00.000Z",
          source_link: "delivery-log",
          availability: "present",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.generated_artifacts.state).toBe("present");
    expect(view.stale_reasons).toEqual(["one or more generated artifacts are older than 1h"]);
    expect(view.summary).toContain("one or more generated artifacts are older than 1h");
  });

  it("blocks missing generated proof artifacts even when feedback source links and infra are clean", () => {
    const view = buildReleaseProofReadiness(base({
      generated_artifacts: [
        {
          artifact_id: "art-missing-generated",
          path: "/tmp/output/kapelle-release-proof.md",
          title: "Kapelle release proof",
          produced_at: "2026-07-13T11:45:00.000Z",
          source_link: "manager:/artifacts/art-missing-generated",
          availability: "missing",
        },
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.chris_readable_release_ready).toBe("NOT READY");
    expect(view.feedback_evidence).toMatchObject({ state: "present", count: 1 });
    expect(view.infra_warnings).toMatchObject({ state: "clear", count: 0, source: "none", action: null });
    expect(view.sources.state).toBe("present");
    expect(view.generated_artifacts).toMatchObject({ state: "missing", count: 1 });
    expect(view.stale_reasons).toEqual([]);
    expect(view.missing_reasons).toEqual(["one or more generated proof artifacts are not present"]);
    expect(view.summary).toBe("Release proof is not ready: one or more generated proof artifacts are not present.");
    expect(view.summary).not.toContain("feedback evidence items are missing safe source links");
    expect(view.summary).not.toContain("infra warnings");
  });

  it("keeps stale missing-source feedback as the blocker even when infra is clear", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:stale-missing-source",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: null,
          artifact_id: "art-kapelle",
          summary: "Old feedback without durable source.",
        },
      ],
      stale_after_ms: 24 * 60 * 60 * 1000,
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.chris_readable_release_ready).toBe("NOT READY");
    expect(view.feedback_evidence).toMatchObject({
      state: "stale",
      count: 1,
      stale_after_ms: 24 * 60 * 60 * 1000,
    });
    expect(view.infra_warnings).toMatchObject({
      state: "clear",
      count: 0,
      source: "none",
      action: null,
      items: [],
    });
    expect(view.sources.state).toBe("present");
    expect(view.generated_artifacts.state).toBe("present");
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 24h"]);
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items are missing safe source links"]);
    expect(view.summary).toContain("latest feedback evidence is older than 24h");
  });

  it("keeps stale and missing reasons separate when stale feedback has unsafe source evidence", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:redacted-stale",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: "[redacted]",
          artifact_id: "art-kapelle",
          summary: "Old feedback with redacted source.",
        },
        {
          id: "op:unsupported-stale",
          kind: "comment_recorded",
          observed_at: "2026-07-12T09:00:00.000Z",
          source_link: "file:///Users/kilgore/Dropbox/Code/roger/output/kapelle-release-proof.md",
          artifact_id: "art-kapelle",
          summary: "Old feedback with local source.",
        },
        {
          id: "op:missing-stale",
          kind: "comment_recorded",
          observed_at: "2026-07-12T08:00:00.000Z",
          source_link: null,
          artifact_id: "art-kapelle",
          summary: "Old feedback without source.",
        },
      ],
      source_links: [
        {
          label: "redacted-backlog-ref",
          href: "[redacted]",
          source: "backlog",
        },
        {
          label: "unsupported-local-ref",
          href: "file:///Users/kilgore/Dropbox/Code/roger/output/kapelle-release-proof.md",
          source: "backlog",
        },
      ],
      stale_after_ms: 24 * 60 * 60 * 1000,
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_evidence.state).toBe("stale");
    expect(view.infra_warnings).toMatchObject({ state: "clear", count: 0, source: "none", action: null });
    expect(view.sources).toEqual({
      state: "missing",
      counts: { safe: 0, unsafe: 2, total: 2 },
      links: [],
    });
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 24h"]);
    expect(view.missing_reasons).toEqual([
      "one or more source links are redacted or unsupported",
      "no source links are attached to the release proof",
      "one or more feedback evidence items are missing safe source links",
    ]);
    expect(view.summary).toBe("Release proof is not ready: latest feedback evidence is older than 24h.");
  });

  it("keeps missing-source feedback as a deterministic blocker when artifact and backlog sources exist", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateSqlite(adapter);
      await migrateOutputsTables(adapter);
      await setMode(adapter, "default", "running");
      await adapter.query(
        `INSERT INTO artifacts
           (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability,
            project_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-proof",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof evidence",
          "2026-07-13T11:20:00.000Z",
          "manager:/artifacts/art-kapelle-proof",
          "present",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES
           (?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-proof",
          "comment_recorded",
          "chris",
          "2026-07-13T11:30:00.000Z",
          JSON.stringify({ body: "Looks good; source is in the artifact/backlog context, not this free text." }),
          null,
          "comment-missing-source",
          "art-kapelle-proof",
          "approve",
          "chris",
          "2026-07-13T11:31:00.000Z",
          JSON.stringify({ note: "Approved after reading the release proof." }),
          null,
          "approval-missing-source",
        ],
      );
      await adapter.query(
        `INSERT INTO orchestration_backlog_item
           (item_id, team_id, title, track, to_agent, dispatch_body, readiness_state, risk_class,
            source_refs_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "backlog-kapelle-proof",
          "default",
          "Kapelle release proof source context",
          "kapelle",
          "roger",
          "Release-proof readiness follow-up",
          "done",
          "build",
          JSON.stringify(["manager:/backlog/backlog-kapelle-proof"]),
          "2026-07-13T11:00:00.000Z",
          "2026-07-13T11:00:00.000Z",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.release_readiness).toBe("not_ready");
      expect(view.feedback_evidence).toMatchObject({
        state: "present",
        count: 2,
      });
      expect(view.generated_artifacts.state).toBe("present");
      expect(view.sources).toMatchObject({
        state: "present",
        counts: { safe: 2, unsafe: 0, total: 2 },
        links: expect.arrayContaining([
          expect.objectContaining({ source: "artifact", href: "manager:/artifacts/art-kapelle-proof" }),
          expect.objectContaining({ source: "backlog", href: "manager:/backlog/backlog-kapelle-proof" }),
        ]),
      });
      expect(view.missing_reasons).toEqual(["one or more feedback evidence items are missing safe source links"]);
      expect(view.summary).toBe(
        "Release proof is not ready: one or more feedback evidence items are missing safe source links.",
      );
    } finally {
      await adapter.close();
    }
  });

  it("maps present filesystem proof artifacts to stable source links with availability", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateSqlite(adapter);
      await migrateOutputsTables(adapter);
      await setMode(adapter, "default", "running");
      await adapter.query(
        `INSERT INTO artifacts
           (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability,
            project_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-filesystem-proof",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof evidence",
          "2026-07-13T11:20:00.000Z",
          "filesystem",
          "present",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-filesystem-proof",
          "comment_recorded",
          "chris",
          "2026-07-13T11:30:00.000Z",
          JSON.stringify({ body: "Filesystem proof artifact is present and readable." }),
          "manager:/artifacts/art-kapelle-filesystem-proof/comments#op-1",
          "comment-filesystem-proof",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.release_readiness).toBe("ready");
      expect(view.chris_readable_release_ready).toBe("READY");
      expect(view.generated_artifacts).toMatchObject({
        state: "present",
        count: 1,
        items: [
          expect.objectContaining({
            artifact_id: "art-kapelle-filesystem-proof",
            source_link: "manager:/artifacts/art-kapelle-filesystem-proof",
            availability: "present",
          }),
        ],
      });
      expect(view.sources.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "artifact",
            href: "manager:/artifacts/art-kapelle-filesystem-proof",
          }),
        ]),
      );
      expect(view.missing_reasons).toEqual([]);
      expect(view.stale_reasons).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("can cite stale duplicate closeout receipts as release-proof backlog sources", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateSqlite(adapter);
      await migrateOutputsTables(adapter);
      await setMode(adapter, "default", "running");
      await adapter.query(
        `INSERT INTO artifacts
           (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability,
            project_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-receipt-proof",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof",
          "2026-07-13T11:20:00.000Z",
          "manager:/artifacts/art-kapelle-receipt-proof",
          "present",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-receipt-proof",
          "comment_recorded",
          "chris",
          "2026-07-13T11:30:00.000Z",
          JSON.stringify({ body: "Receipt-backed stale duplicate closeout is visible." }),
          "manager:/artifacts/art-kapelle-receipt-proof/comments#op-1",
          "comment-receipt-source",
        ],
      );
      await adapter.query(
        `INSERT INTO orchestration_backlog_item
           (item_id, team_id, title, track, to_agent, dispatch_body, readiness_state, risk_class,
            source_refs_json, last_dispatch_phid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "backlog-kapelle-stale-duplicate",
          "default",
          "Kapelle stale duplicate closeout receipt source",
          "T-ORCH",
          "roger",
          "Already completed duplicate work.",
          "ready",
          "build",
          JSON.stringify(["manager:/backlog/original-kapelle-source"]),
          "phid:disp-kapelle-stale-duplicate",
          "2026-07-13T11:00:00.000Z",
          "2026-07-13T11:00:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO dispatch_scheduler_queue
           (dispatch_phid, team_id, query_id, to_agent, from_actor, channel, subject, body_markdown,
            provider, runtime, status, not_before_at, completed_at, updated_at, artifact_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "phid:disp-kapelle-stale-duplicate",
          "default",
          "query_kapelle_stale_duplicate",
          "roger",
          "manager",
          "talk",
          "Kapelle stale duplicate closeout",
          "Done.",
          "openai",
          "codex",
          "done",
          "2026-07-13T11:00:00.000Z",
          "2026-07-13T11:10:00.000Z",
          "2026-07-13T11:10:00.000Z",
          "/repo/output/kapelle-stale-duplicate-closeout.md",
        ],
      );

      const closed = await reconcileStaleAlreadyDispatchedReadyRows(adapter, {
        team_id: "default",
        actor: "roger",
      });
      expect(closed.closed).toBe(1);

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.sources.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "backlog",
            href: "manager:/orchestration/backlog/backlog-kapelle-stale-duplicate#stale-duplicate-closeout-receipt",
          }),
        ]),
      );
    } finally {
      await adapter.close();
    }
  });

  it("keeps infra warnings visible and blocks readiness", () => {
    const view = buildReleaseProofReadiness(base({
      infra_warnings: ["promotion blocker phid:disp-1: remote tip not verified"],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.infra_warnings).toMatchObject({
      state: "warning",
      count: 1,
      source: "orchestration_health_projection",
      action: "review orchestration health and resolve infra warnings before release proof sign-off",
      items: ["promotion blocker phid:disp-1: remote tip not verified"],
    });
    expect(view.summary).toContain("infra warnings");
  });

  it("exposes warning source and action while keeping stale feedback separate", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:stale-missing-source",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: null,
          artifact_id: "art-kapelle",
          summary: "Old feedback without durable source.",
        },
      ],
      infra_warnings: ["orchestration loop critical: 3 consecutive zero-admit ticks with no structured admission explanation"],
      stale_after_ms: 24 * 60 * 60 * 1000,
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_evidence.state).toBe("stale");
    expect(view.infra_warnings).toMatchObject({
      state: "warning",
      count: 1,
      source: "orchestration_health_projection",
      action: "review orchestration health and resolve infra warnings before release proof sign-off",
      items: [
        "orchestration loop critical: 3 consecutive zero-admit ticks with no structured admission explanation",
      ],
    });
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 24h"]);
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items are missing safe source links"]);
    expect(view.summary).toBe("Release proof is not ready: infra warnings require operator review.");
  });

  it("exposes separate machine fields when feedback is older than 24h and infra needs operator review", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:older-than-24h",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: "https://manager.local/artifacts/art-kapelle/comments#op-old",
          artifact_id: "art-kapelle",
          summary: "Old feedback with a durable source.",
        },
      ],
      infra_warnings: ["promotion blocker phid:disp-1: remote tip not verified"],
      stale_after_ms: 24 * 60 * 60 * 1000,
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.chris_readable_release_ready).toBe("NOT READY");
    expect(view.feedback_freshness).toEqual({
      state: "stale",
      latest_at: "2026-07-12T10:00:00.000Z",
      stale_after_ms: 24 * 60 * 60 * 1000,
      stale: true,
      reason: "latest feedback evidence is older than 24h",
    });
    expect(view.infra_warning).toEqual({
      state: "warning",
      count: 1,
      requires_operator_review: true,
      source: "orchestration_health_projection",
      action: "review orchestration health and resolve infra warnings before release proof sign-off",
    });
    expect(view.source_link_state).toEqual({
      state: "present",
      safe_count: 1,
      unsafe_count: 0,
      total_count: 1,
    });
    expect(view.next_owner).toEqual({
      lane: "operator",
      action: "review orchestration health and resolve infra warnings before release proof sign-off",
      reason: "infra_warning",
      candidates: [
        {
          lane: "operator",
          reason: "infra_warning",
          action: "review orchestration health and resolve infra warnings before release proof sign-off",
        },
        {
          lane: "chris",
          reason: "feedback_freshness",
          action: "latest feedback evidence is older than 24h",
        },
      ],
    });
    expect(view.feedback_evidence.state).toBe("stale");
    expect(view.infra_warnings.state).toBe("warning");
    expect(view.sources.state).toBe("present");
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 24h"]);
    expect(view.summary).toBe("Release proof is not ready: infra warnings require operator review.");
  });

  it("does not report clear infra state as the blocker when stale feedback is the issue", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:old",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: "https://manager.local/artifacts/art-kapelle/comments#op-old",
          artifact_id: "art-kapelle",
          summary: "Old feedback.",
        },
      ],
      infra_warnings: [],
    }));

    expect(view.infra_warnings).toMatchObject({ state: "clear", count: 0, source: "none", action: null });
    expect(view.summary).toBe("Release proof is not ready: latest feedback evidence is older than 1h.");
    expect(view.summary).not.toContain("infra warnings");
  });

  it("maps degraded orchestration status to infra warnings without hiding missing safe source links", async () => {
    const adapter = new SqliteAdapter(":memory:");
    try {
      await migrateSqlite(adapter);
      await migrateOutputsTables(adapter);
      await setMode(adapter, "default", "running");
      await recordTickOutcome(adapter, "default", { zero_ticks: 3, fired: false });
      await insertBacklogItem(adapter, {
        title: "Kapelle release proof runtime mismatch one",
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "Repair release-proof runtime lane one.",
        provider: "openai",
        runtime: "claude-code-cli",
      });
      await insertBacklogItem(adapter, {
        title: "Kapelle release proof runtime mismatch two",
        readiness_state: "ready",
        risk_class: "build",
        to_agent: "roger",
        dispatch_body: "Repair release-proof runtime lane two.",
        provider: "openai",
        runtime: "claude-code-cli",
      });
      await adapter.query(
        `INSERT INTO artifacts
           (artifact_id, basename, agent, tag, abs_path, title, produced_at, source, availability,
            project_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-proof",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof evidence",
          "2026-07-13T11:20:00.000Z",
          "manager:/artifacts/art-kapelle-proof",
          "present",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "art-kapelle-proof",
          "comment_recorded",
          "chris",
          "2026-07-13T10:30:00.000Z",
          JSON.stringify({ body: "Approved, but this comment lacks a durable source." }),
          null,
          "comment-stale-missing-source",
        ],
      );
      await adapter.query(
        `INSERT INTO orchestration_backlog_item
           (item_id, team_id, title, track, to_agent, dispatch_body, readiness_state, risk_class,
            source_refs_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "backlog-kapelle-proof",
          "default",
          "Kapelle release proof source context",
          "kapelle",
          "roger",
          "Release-proof readiness follow-up",
          "done",
          "build",
          JSON.stringify(["manager:/backlog/backlog-kapelle-proof"]),
          "2026-07-13T11:00:00.000Z",
          "2026-07-13T11:00:00.000Z",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
        staleAfterMs: 60 * 60 * 1000,
      });

      expect(view.release_readiness).toBe("not_ready");
      expect(view.chris_readable_release_ready).toBe("NOT READY");
      expect(view.feedback_evidence).toMatchObject({ state: "stale", count: 1 });
      expect(view.infra_warnings).toMatchObject({
        state: "warning",
        count: 1,
        source: "orchestration_health_projection",
        action: "review orchestration health and resolve infra warnings before release proof sign-off",
        items: [
          expect.stringContaining("orchestration loop critical: 3 consecutive zero-admit ticks"),
        ],
      });
      const warning = view.infra_warnings.items[0] ?? "";
      expect(warning).toContain("top blocker provider_runtime_mismatch=2");
      expect(warning).toContain("source route /orchestration/status ready_admission.blocker_counts");
      expect(warning).toContain(
        "safe next action: route to a compatible agent or update the requested provider/runtime",
      );
      expect(view.sources).toMatchObject({
        state: "present",
        counts: { safe: 2, unsafe: 0, total: 2 },
        links: expect.arrayContaining([
          expect.objectContaining({ source: "artifact", href: "manager:/artifacts/art-kapelle-proof" }),
          expect.objectContaining({ source: "backlog", href: "manager:/backlog/backlog-kapelle-proof" }),
        ]),
      });
      expect(view.generated_artifacts).toMatchObject({ state: "present", count: 1 });
      expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 1h"]);
      expect(view.missing_reasons).toEqual(["one or more feedback evidence items are missing safe source links"]);
      expect(view.summary).toBe("Release proof is not ready: infra warnings require operator review.");
    } finally {
      await adapter.close();
    }
  });
});
