import { describe, expect, it } from "vitest";

import {
  buildReleaseProofReadiness,
  formatOrchestrationLoopInfraWarning,
  readReleaseProofReadiness,
  type ReleaseProofFeedbackEvidence,
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

function feedbackFixture(
  overrides: Partial<ReleaseProofFeedbackEvidence> = {},
): ReleaseProofFeedbackEvidence {
  return {
    id: "op:fixture",
    kind: "comment_recorded",
    observed_at: "2026-07-13T11:30:00.000Z",
    source_link: "manager:/artifacts/art-kapelle/operations/1",
    artifact_id: "art-kapelle",
    summary: "Fixture feedback.",
    ...overrides,
  };
}

function expectSafeOrExplicitUnsupportedSource(fixtures: ReleaseProofFeedbackEvidence[]): void {
  for (const fixture of fixtures) {
    const source = fixture.source_link?.trim() ?? "";
    const hasSafeManagerOrArtifactSource =
      source.startsWith("manager:/") ||
      source.startsWith("https://manager.local/") ||
      source.startsWith("https://github.com/");
    const hasExplicitUnsupportedReason =
      fixture.source_link_status === "unsupported" &&
      fixture.source_link_reason?.includes("unsupported-source") === true;

    expect(
      hasSafeManagerOrArtifactSource || hasExplicitUnsupportedReason,
      `${fixture.id} must use a safe source_link or explicit unsupported-source reason`,
    ).toBe(true);
  }
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
      feedback_source_link_state: {
        state: "present",
        counts: { present: 1, missing: 0, redacted: 0, unsupported: 0, total: 1 },
        items: [
          {
            id: "op:1",
            state: "present",
            source_link: "https://manager.local/artifacts/art-kapelle/comments#op-1",
            reason: null,
          },
        ],
      },
      system_health: {
        state: "clear",
        disk: { state: "ok", disk_critical: false },
        build: { build_behind_origin: null },
        deploy_blockers: { blocked: false, reasons: [] },
      },
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
    expect(view.feedback_source_link_state).toMatchObject({
      state: "missing",
      counts: { present: 0, missing: 1, redacted: 0, unsupported: 0, total: 1 },
      items: [{ id: "op:source-missing", state: "missing", source_link: null }],
    });
    expect(view.next_owner).toMatchObject({
      lane: "release-engineering",
      reason: "source_link_state",
    });
    expect(view.next_owner.candidates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ lane: "chris" })]),
    );
    expect(view.missing_reasons).toEqual([
      "one or more generated artifacts are missing safe source links",
      "no source links are attached to the release proof",
      "one or more feedback evidence items have null source_link",
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
    expect(view.feedback_source_link_state).toMatchObject({
      state: "redacted",
      counts: { present: 0, missing: 0, redacted: 1, unsupported: 0, total: 1 },
      items: [{ id: "op:redacted-source", state: "redacted", source_link: null }],
    });
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items have redacted source_link"]);
    expect(view.sources.links).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ href: "[redacted]" })]),
    );
  });

  it("distinguishes mixed feedback source-link states at receipt level", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        feedbackFixture({
          id: "op:present",
          source_link: "manager:/artifacts/art-kapelle/operations/1",
          source_link_status: "derived",
        }),
        feedbackFixture({
          id: "op:missing",
          source_link: null,
          source_link_status: "unavailable",
          source_link_reason: "artifact source is marked missing",
        }),
        feedbackFixture({
          id: "op:redacted",
          source_link: null,
          source_link_status: "redacted",
          source_link_reason: "stored source link is redacted",
        }),
        feedbackFixture({
          id: "op:unsupported",
          source_link: null,
          source_link_status: "unsupported",
          source_link_reason: "stored source link uses an unsupported or local scheme",
        }),
      ],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.feedback_source_link_state).toEqual({
      state: "missing",
      counts: { present: 1, missing: 1, redacted: 1, unsupported: 1, total: 4 },
      items: [
        {
          id: "op:present",
          state: "present",
          source_link: "manager:/artifacts/art-kapelle/operations/1",
          reason: null,
        },
        {
          id: "op:missing",
          state: "missing",
          source_link: null,
          reason: "artifact source is marked missing",
        },
        {
          id: "op:redacted",
          state: "redacted",
          source_link: null,
          reason: "stored source link is redacted",
        },
        {
          id: "op:unsupported",
          state: "unsupported",
          source_link: null,
          reason: "stored source link uses an unsupported or local scheme",
        },
      ],
    });
    expect(view.reason_codes.source_link_state).toEqual([
      "feedback_source_link_null",
      "feedback_source_link_redacted",
      "feedback_source_link_unsupported",
    ]);
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
    expect(view.summary).not.toContain("feedback evidence items have null source_link");
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
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items have null source_link"]);
    expect(view.summary).toContain("latest feedback evidence is older than 24h");
  });

  it("keeps stale all-null feedback not ready when artifacts are present and infra is clear", () => {
    const staleNullFeedback = Array.from({ length: 11 }, (_, index) =>
      feedbackFixture({
        id: `op:stale-null-source-${index + 1}`,
        kind: index % 2 === 0 ? "comment_recorded" : "approve",
        observed_at: `2026-07-12T${String(10 - Math.floor(index / 2)).padStart(2, "0")}:00:00.000Z`,
        source_link: null,
        source_link_status: "unsupported",
        source_link_reason: "unsupported-source: fixture preserves current feedback evidence without a safe manager source_link",
        summary: "Old feedback without a durable source.",
      })
    );
    expectSafeOrExplicitUnsupportedSource(staleNullFeedback);

    const view = buildReleaseProofReadiness(base({
      feedback_evidence: staleNullFeedback,
      infra_warnings: [],
      stale_after_ms: 24 * 60 * 60 * 1000,
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.chris_readable_release_ready).toBe("NOT READY");
    expect(view.feedback_evidence).toMatchObject({
      state: "stale",
      count: 11,
      latest_at: "2026-07-12T10:00:00.000Z",
    });
    expect(view.source_link_state).toEqual({
      state: "present",
      safe_count: 1,
      unsafe_count: 0,
      total_count: 1,
    });
    expect(view.reason_codes).toEqual({
      loader_error: [],
      feedback_freshness: ["feedback_evidence_stale"],
      infra_warning: [],
      source_link_state: ["feedback_source_link_unsupported"],
      artifact_state: [],
    });
    expect(view.infra_warnings).toMatchObject({ state: "clear", count: 0, source: "none", action: null });
    expect(view.generated_artifacts).toMatchObject({ state: "present", count: 1 });
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 24h"]);
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items have unsupported source links"]);
    expect(view.missing_reasons).not.toContain("one or more generated proof artifacts are not present");
    expect(view.generated_artifacts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifact_id: "art-kapelle",
          source_link: "delivery-log",
          availability: "present",
        }),
      ]),
    );
    expect(view.summary).toBe("Release proof is not ready: latest feedback evidence is older than 24h.");
    expect(view.summary).not.toContain("Release proof is ready for Chris");
    expect(view.summary).not.toContain("infra warnings");
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
      "one or more feedback evidence items have null source_link",
      "one or more feedback evidence items have redacted source_link",
      "one or more feedback evidence items have unsupported source links",
    ]);
    expect(view.reason_codes).toMatchObject({
      feedback_freshness: ["feedback_evidence_stale"],
      infra_warning: [],
      source_link_state: [
        "source_links_unsafe",
        "source_links_missing",
        "feedback_source_link_null",
        "feedback_source_link_redacted",
        "feedback_source_link_unsupported",
      ],
    });
    expect(view.summary).toBe("Release proof is not ready: latest feedback evidence is older than 24h.");
  });

  it("derives feedback operation source links when artifact and backlog sources exist", async () => {
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

      expect(view.release_readiness).toBe("ready");
      expect(view.feedback_evidence).toMatchObject({
        state: "present",
        count: 2,
      });
      expect(view.feedback_evidence.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(/^op:/),
            source_link: expect.stringMatching(/^manager:\/artifacts\/art-kapelle-proof\/operations\/\d+$/),
            source_link_status: "derived",
            source_link_reason: "derived from durable artifact operation",
          }),
        ]),
      );
      expect(view.generated_artifacts.state).toBe("present");
      expect(view.sources).toMatchObject({
        state: "present",
        counts: { safe: 4, unsafe: 0, total: 4 },
        links: expect.arrayContaining([
          expect.objectContaining({ source: "artifact", href: "manager:/artifacts/art-kapelle-proof" }),
          expect.objectContaining({ source: "backlog", href: "manager:/backlog/backlog-kapelle-proof" }),
          expect.objectContaining({ source: "feedback", href: expect.stringMatching(/^manager:\/artifacts\/art-kapelle-proof\/operations\/\d+$/) }),
        ]),
      });
      expect(view.missing_reasons).toEqual([]);
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

  it("resolves latest Chris feedback op:10023 to a safe manager operation source link", async () => {
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
          "art-kapelle-op-10023",
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
           (op_id, artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          10023,
          "art-kapelle-op-10023",
          "comment_recorded",
          "chris",
          "2026-07-13T11:30:00.000Z",
          JSON.stringify({ body: "Latest Chris feedback for kapelle release proof." }),
          null,
          "comment-op-10023",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.release_readiness).toBe("ready");
      expect(view.feedback_evidence.items).toEqual([
        expect.objectContaining({
          id: "op:10023",
          source_link: "manager:/artifacts/art-kapelle-op-10023/operations/10023",
          source_link_status: "derived",
          source_link_safe_state: "present",
          source_link_reason: "derived from durable artifact operation",
        }),
      ]);
      expect(view.feedback_source_link_state).toMatchObject({
        state: "present",
        counts: { present: 1, missing: 0, redacted: 0, unsupported: 0, total: 1 },
        items: [
          {
            id: "op:10023",
            state: "present",
            source_link: "manager:/artifacts/art-kapelle-op-10023/operations/10023",
            reason: "derived from durable artifact operation",
          },
        ],
      });
      expect(view.sources.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "feedback",
            href: "manager:/artifacts/art-kapelle-op-10023/operations/10023",
          }),
        ]),
      );
      expect(view.missing_reasons).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("keeps latest Chris feedback op:9894 null with an unavailable source reason when the artifact is missing", async () => {
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
          "art-kapelle-op-9894",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof evidence",
          "2026-07-13T11:20:00.000Z",
          "filesystem",
          "missing",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (op_id, artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          9894,
          "art-kapelle-op-9894",
          "comment_recorded",
          "chris",
          "2026-07-13T11:30:00.000Z",
          JSON.stringify({ body: "Latest Chris feedback for kapelle release proof, artifact missing." }),
          null,
          "comment-op-9894",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.release_readiness).toBe("not_ready");
      expect(view.feedback_evidence.items).toEqual([
        expect.objectContaining({
          id: "op:9894",
          source_link: null,
          source_link_status: "unavailable",
          source_link_safe_state: "missing",
          source_link_reason: "artifact source is marked missing",
        }),
      ]);
      expect(view.feedback_source_link_state).toMatchObject({
        state: "missing",
        counts: { present: 0, missing: 1, redacted: 0, unsupported: 0, total: 1 },
        items: [{ id: "op:9894", state: "missing", source_link: null, reason: "artifact source is marked missing" }],
      });
      expect(view.missing_reasons).toEqual([
        "one or more generated proof artifacts are not present",
        "one or more feedback evidence items have null source_link",
      ]);
      expect(view.sources.links).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "feedback" }),
        ]),
      );
    } finally {
      await adapter.close();
    }
  });

  it("keeps fresh Chris feedback not ready when an operation has only an unsupported source link", async () => {
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
          "art-kapelle-fresh-feedback",
          "kapelle-release-proof.md",
          "roger",
          "release-proof",
          "/tmp/output/kapelle-release-proof.md",
          "Kapelle release proof evidence",
          "2026-07-13T11:20:00.000Z",
          "manager:/artifacts/art-kapelle-fresh-feedback",
          "present",
          "kapelle",
          "2026-07-13T11:20:00.000Z",
          "2026-07-13T11:20:00.000Z",
        ],
      );
      await adapter.query(
        `INSERT INTO artifact_operations
           (op_id, artifact_id, op_type, actor, ts, payload_json, source_link, idempotency_key)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          10031,
          "art-kapelle-fresh-feedback",
          "comment_recorded",
          "chris",
          "2026-07-13T11:32:00.000Z",
          JSON.stringify({ body: "Fresh Chris feedback with a safe manager artifact link." }),
          "manager:/artifacts/art-kapelle-fresh-feedback/comments#op-10031",
          "comment-safe-source-10031",
          10032,
          "art-kapelle-fresh-feedback",
          "comment_recorded",
          "chris",
          "2026-07-13T11:31:00.000Z",
          JSON.stringify({ body: "Fresh Chris feedback whose source was a local file URL." }),
          "file:///Users/kilgore/Dropbox/Code/roger/output/kapelle-release-proof.md",
          "comment-unsupported-source-10032",
        ],
      );

      const view = await readReleaseProofReadiness(adapter, {
        teamId: "default",
        project: "kapelle",
        now: NOW,
      });

      expect(view.release_readiness).toBe("not_ready");
      expect(view.chris_readable_release_ready).toBe("NOT READY");
      expect(view.feedback_evidence).toMatchObject({
        state: "present",
        count: 2,
      });
      expect(view.feedback_evidence.items).toEqual([
        expect.objectContaining({
          id: "op:10031",
          source_link: "manager:/artifacts/art-kapelle-fresh-feedback/comments#op-10031",
          source_link_status: "present",
          source_link_reason: null,
        }),
        expect.objectContaining({
          id: "op:10032",
          source_link: null,
          source_link_status: "unsupported",
          source_link_reason: "stored source link uses an unsupported or local scheme",
        }),
      ]);
      for (const item of view.feedback_evidence.items) {
        expect(
          (item.source_link?.startsWith("manager:/artifacts/") ?? false) ||
            item.source_link_status === "unsupported",
        ).toBe(true);
      }
      expect(view.source_link_state).toEqual({
        state: "present",
        safe_count: 2,
        unsafe_count: 0,
        total_count: 2,
      });
      expect(view.sources.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "feedback",
            href: "manager:/artifacts/art-kapelle-fresh-feedback/comments#op-10031",
          }),
          expect.objectContaining({
            source: "artifact",
            href: "manager:/artifacts/art-kapelle-fresh-feedback",
          }),
        ]),
      );
      expect(view.sources.links).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ href: expect.stringContaining("file://") }),
        ]),
      );
      expect(view.reason_codes.source_link_state).toEqual(["feedback_source_link_unsupported"]);
      expect(view.stale_reasons).toEqual([]);
      expect(view.missing_reasons).toEqual(["one or more feedback evidence items have unsupported source links"]);
      expect(view.next_owner.candidates).toEqual([
        {
          lane: "release-engineering",
          reason: "source_link_state",
          action: "one or more feedback evidence items have unsupported source links",
        },
      ]);
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
    expect(view.missing_reasons).toEqual(["one or more feedback evidence items have null source_link"]);
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
    expect(view.reason_codes).toMatchObject({
      feedback_freshness: ["feedback_evidence_stale"],
      infra_warning: ["infra_warning"],
      source_link_state: [],
    });
  });

  it("keeps stale feedback, missing source links, and infra warnings release-proof visible together", () => {
    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [
        {
          id: "op:stale-source-missing",
          kind: "comment_recorded",
          observed_at: "2026-07-12T10:00:00.000Z",
          source_link: null,
          artifact_id: "art-kapelle",
          summary: "Old feedback without durable source.",
        },
      ],
      infra_warnings: ["orchestration loop degraded: scheduler freshness warning"],
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

    expect(view).toMatchObject({
      release_readiness: "not_ready",
      chris_readable_release_ready: "NOT READY",
      feedback_evidence: {
        state: "stale",
        count: 1,
        latest_at: "2026-07-12T10:00:00.000Z",
      },
      infra_warnings: {
        state: "warning",
        count: 1,
        source: "orchestration_health_projection",
        action: "review orchestration health and resolve infra warnings before release proof sign-off",
        items: ["orchestration loop degraded: scheduler freshness warning"],
      },
      sources: {
        state: "missing",
        links: [],
      },
      generated_artifacts: {
        state: "missing",
        count: 1,
      },
    });
    expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 1h"]);
    expect(view.missing_reasons).toEqual([
      "one or more generated artifacts are missing safe source links",
      "no source links are attached to the release proof",
      "one or more feedback evidence items have null source_link",
    ]);
    expect(view.error_reasons).toEqual([]);
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

  it("surfaces target_unhealthy as the highest-impact admission repair while preserving retry safety", () => {
    const warning = formatOrchestrationLoopInfraWarning({
      orchestration_loop: {
        severity: "critical",
        consecutive_zero_ticks: 8,
        last_admission_block_reasons: {
          duplicate_dispatch_retry_required: 1,
        },
        explanation: "recent zero-admit ticks cite duplicate retry only",
      },
      ready_item_blockers: {
        recommended_action:
          "runtime repair for target_unhealthy=6 rows where safe; review duplicate_dispatch_retry_required=1 rows and mark retry_safe only for bounded refires or close stale duplicates",
        categories: [],
        stale_ready_fuel: {
          counts_by_blocker_class: [
            { code: "target_unhealthy", category: "runtime_unavailable", count: 6, examples: [] },
            { code: "duplicate_dispatch_retry_required", category: "retry_safety", count: 1, examples: [] },
          ],
        },
        items: [
          {
            code: "duplicate_dispatch_retry_required",
            retry_readiness_status: "retryable_failed_row",
          },
        ],
      },
    } as any);

    expect(warning).toContain("top blocker target_unhealthy=6");
    expect(warning).toContain("source route /orchestration/status ready_admission.blocker_counts");
    expect(warning).toContain("runtime repair for target_unhealthy=6 rows where safe");
    expect(warning).toContain("duplicate_dispatch_retry_required=1 rows");
    expect(warning).toContain("mark retry_safe only for bounded refires or close stale duplicates");
  });

  it("keeps the current build-ready floor warning focused on one more independent lane instead of stale duplicate refires", () => {
    const staleLatest = "2026-07-12T18:35:52.064Z";
    const warning = formatOrchestrationLoopInfraWarning({
      orchestration_loop: {
        severity: "critical",
        consecutive_zero_ticks: 4,
        last_admission_block_reasons: {
          build_ready_below_floor: 1,
          build_ready_lane_diversity_below_min_lanes: 1,
        },
        explanation:
          "ready=17, useful_ready=17, build_ready=11/12, admissible_now=3; operator summary: add 1 more independent build lane to reach 12/12 build-ready coverage",
      },
      ready_item_blockers: {
        recommended_action:
          "author or promote build-ready work in 1 more independent lane; stale duplicate rows are not the fix for this floor deficit",
        categories: [
          {
            code: "build_ready_below_floor",
            category: "lane_eligibility",
            count: 1,
            examples: [],
            owner_lane: "orchestration",
            recommended_action:
              "author or promote build-ready work in 1 more independent lane; stale duplicate rows are not the fix for this floor deficit",
          },
        ],
        stale_ready_fuel: {
          counts_by_blocker_class: [
            { code: "build_ready_below_floor", category: "lane_eligibility", count: 1, examples: [] },
            { code: "infra_warning", category: "operator_review", count: 1, examples: [] },
          ],
        },
        items: [
          {
            code: "duplicate_dispatch_retry_required",
            retry_readiness_status: "stale_duplicate",
          },
        ],
      },
    } as any);

    const view = buildReleaseProofReadiness(base({
      feedback_evidence: [feedbackFixture({ id: "op:stale-floor", observed_at: staleLatest })],
      infra_warnings: [warning],
    }));

    expect(view.feedback_evidence).toMatchObject({
      state: "stale",
      latest_at: staleLatest,
      count: 1,
    });
    expect(view.infra_warning).toEqual({
      state: "warning",
      count: 1,
      requires_operator_review: true,
      source: "orchestration_health_projection",
      action: "review orchestration health and resolve infra warnings before release proof sign-off",
    });
    expect(view.summary).toBe("Release proof is not ready: infra warnings require operator review.");
    const rendered = view.infra_warnings.items[0] ?? "";
    expect(rendered).toContain("ready=17, useful_ready=17, build_ready=11/12, admissible_now=3");
    expect(rendered).toContain("add 1 more independent build lane");
    expect(rendered).toContain("top blocker build_ready_below_floor=1");
    expect(rendered).not.toContain("mark retry_safe only for bounded refires");
    expect(rendered).not.toContain("close stale duplicates");
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
        counts: { safe: 3, unsafe: 0, total: 3 },
        links: expect.arrayContaining([
          expect.objectContaining({ source: "artifact", href: "manager:/artifacts/art-kapelle-proof" }),
          expect.objectContaining({ source: "backlog", href: "manager:/backlog/backlog-kapelle-proof" }),
          expect.objectContaining({ source: "feedback", href: expect.stringMatching(/^manager:\/artifacts\/art-kapelle-proof\/operations\/\d+$/) }),
        ]),
      });
      expect(view.generated_artifacts).toMatchObject({ state: "present", count: 1 });
      expect(view.stale_reasons).toEqual(["latest feedback evidence is older than 1h"]);
      expect(view.missing_reasons).toEqual([]);
      expect(view.summary).toBe("Release proof is not ready: infra warnings require operator review.");
    } finally {
      await adapter.close();
    }
  });
});
