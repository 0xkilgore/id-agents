import { describe, expect, it } from "vitest";

import {
  buildReleaseProofReadiness,
  type ReleaseProofReadinessInput,
} from "../../src/continuous-orchestration/release-proof-readiness.js";

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
      feedback_evidence: { state: "present", count: 1 },
      infra_warnings: { state: "clear", count: 0 },
      sources: { state: "present" },
      generated_artifacts: { state: "present", count: 1 },
    });
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
    expect(view.infra_warnings.state).toBe("error");
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
      "one or more generated artifacts are missing source links or file paths",
      "no source links are attached to the release proof",
      "one or more feedback evidence items are missing source links",
    ]);
  });

  it("keeps infra warnings visible and blocks readiness", () => {
    const view = buildReleaseProofReadiness(base({
      infra_warnings: ["promotion blocker phid:disp-1: remote tip not verified"],
    }));

    expect(view.release_readiness).toBe("not_ready");
    expect(view.infra_warnings).toMatchObject({
      state: "warning",
      count: 1,
      items: ["promotion blocker phid:disp-1: remote tip not verified"],
    });
    expect(view.summary).toContain("infra warnings");
  });
});
