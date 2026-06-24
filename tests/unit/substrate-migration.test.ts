// DV7 — reusable substrate-migration tooling: parity / backfill / dual-write /
// config, plus an EQUIVALENCE proof that the generic parity engine reproduces
// the live artifacts `computeArtifactParity` on the same inputs.

import { describe, it, expect, vi } from "vitest";
import {
  computeParity,
  runBackfill,
  dualWrite,
  defineDomainCutover,
  type ParityComparable,
} from "../../src/substrate-migration/index.js";
import { computeArtifactParity } from "../../src/outputs/parity.js";

// A row shape shared by the live artifacts parity (ComparableRow) and, via an
// adapter, the generic engine — the same data drives both sides of the proof.
interface ArtifactRow {
  abs_path: string;
  agent: string | null;
  tag: string | null;
  title: string | null;
  produced_at: string;
}

function artifactToComparable(r: ArtifactRow): ParityComparable {
  return {
    key: r.abs_path,
    fidelity: { title: r.title },
    ordering_ts: r.produced_at,
    groups: { agent: r.agent, tag: r.tag },
  };
}

function row(over: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    abs_path: "/Code/roger/output/a.md",
    agent: "roger",
    tag: "spec",
    title: "title a",
    produced_at: "2026-06-23T10:00:00.000Z",
    ...over,
  };
}

const NOW = "2026-06-24T00:00:00.000Z";

describe("computeParity", () => {
  it("is ok when the substrate faithfully contains every legacy row", () => {
    const rows = [row(), row({ abs_path: "/b.md", title: "title b", produced_at: "2026-06-23T11:00:00.000Z" })];
    const cmp = rows.map(artifactToComparable);
    const report = computeParity(cmp, cmp, NOW, { groupDims: ["agent", "tag"] });
    expect(report.status).toBe("ok");
    expect(report.drift).toEqual([]);
    expect(report.metrics.find((m) => m.name === "legacy_rows_present")?.ok).toBe(true);
  });

  it("flags a legacy row missing from the substrate", () => {
    const legacy = [row(), row({ abs_path: "/b.md" })].map(artifactToComparable);
    const substrate = [row()].map(artifactToComparable);
    const report = computeParity(substrate, legacy, NOW);
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("missing in substrate: /b.md"))).toBe(true);
  });

  it("flags a fidelity (title) drift", () => {
    const legacy = [row({ title: "legacy title" })].map(artifactToComparable);
    const substrate = [row({ title: "substrate title" })].map(artifactToComparable);
    const report = computeParity(substrate, legacy, NOW);
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.startsWith("title drift"))).toBe(true);
  });

  it("allows a substrate superset (rows the legacy walk never saw)", () => {
    const legacy = [row()].map(artifactToComparable);
    const substrate = [row(), row({ abs_path: "/extra.md", title: "extra" })].map(artifactToComparable);
    const report = computeParity(substrate, legacy, NOW);
    expect(report.status).toBe("ok");
  });

  it("flags a newest-N ordering disagreement over shared rows", () => {
    const a = row({ abs_path: "/a.md", produced_at: "2026-06-23T10:00:00.000Z" });
    const b = row({ abs_path: "/b.md", produced_at: "2026-06-23T12:00:00.000Z" });
    // Same rows both sides → ordering is derived from produced_at, so to force a
    // disagreement we give the substrate a different produced_at for /b.md.
    const legacy = [a, b].map(artifactToComparable);
    const substrate = [a, row({ abs_path: "/b.md", produced_at: "2026-06-23T08:00:00.000Z" })].map(artifactToComparable);
    const report = computeParity(substrate, legacy, NOW, { newestN: 20 });
    expect(report.status).toBe("drift");
    expect(report.drift.some((d) => d.includes("ordering differs"))).toBe(true);
  });
});

describe("runBackfill", () => {
  it("tallies inserts vs updates and is idempotent on re-run", async () => {
    const store = new Map<string, string>();
    const upsert = (r: ArtifactRow) => {
      const inserted = !store.has(r.abs_path);
      store.set(r.abs_path, r.title ?? "");
      return { inserted };
    };
    const rows = [row({ abs_path: "/a.md" }), row({ abs_path: "/b.md" })];

    const first = await runBackfill({ rows, upsert });
    expect(first).toMatchObject({ rows_seen: 2, rows_parsed: 2, inserted: 2, updated: 0, skipped: 0 });

    const second = await runBackfill({ rows, upsert });
    expect(second).toMatchObject({ inserted: 0, updated: 2, skipped: 0 });
    expect(store.size).toBe(2);
  });

  it("counts parse-rejected rows as skipped without aborting", async () => {
    const rows = ["keep", "", "keep2"];
    const summary = await runBackfill<string, string>({
      rows,
      parse: (line) => (line.trim() ? line : null),
      upsert: () => ({ inserted: true }),
    });
    expect(summary).toMatchObject({ rows_seen: 3, rows_parsed: 2, skipped: 1, inserted: 2 });
  });

  it("supports async iterables", async () => {
    async function* gen() {
      yield row({ abs_path: "/x.md" });
      yield row({ abs_path: "/y.md" });
    }
    const summary = await runBackfill({ rows: gen(), upsert: () => ({ inserted: true }) });
    expect(summary.rows_parsed).toBe(2);
  });
});

describe("dualWrite", () => {
  it("returns both results when legacy and substrate succeed", async () => {
    const result = await dualWrite({
      writeLegacy: async () => ({ id: "L1" }),
      writeSubstrate: async (legacy) => ({ mirrored: legacy.id }),
    });
    expect(result.legacy).toEqual({ id: "L1" });
    expect(result.substrate).toEqual({ ok: true, value: { mirrored: "L1" } });
  });

  it("preserves the legacy write and captures a substrate failure", async () => {
    const onSubstrateError = vi.fn();
    const result = await dualWrite({
      writeLegacy: async () => ({ id: "L1" }),
      writeSubstrate: async () => {
        throw new Error("substrate down");
      },
      onSubstrateError,
    });
    expect(result.legacy).toEqual({ id: "L1" });
    expect(result.substrate).toEqual({ ok: false, error: "substrate down" });
    expect(onSubstrateError).toHaveBeenCalledOnce();
  });

  it("propagates a legacy-write failure (the operation truly failed)", async () => {
    await expect(
      dualWrite({
        writeLegacy: async () => {
          throw new Error("legacy down");
        },
        writeSubstrate: async () => ({}),
      }),
    ).rejects.toThrow("legacy down");
  });
});

describe("defineDomainCutover", () => {
  const cfg = defineDomainCutover<ArtifactRow, ArtifactRow>({
    domain: "artifacts",
    flagKey: "ARTIFACTS_USE_DOCUMENT_MODEL",
    substrateToComparable: artifactToComparable,
    legacyToComparable: artifactToComparable,
    parity: { groupDims: ["agent", "tag"] },
  });

  it("reads its flag with the documented truthiness", () => {
    expect(cfg.useDocumentModel({ ARTIFACTS_USE_DOCUMENT_MODEL: "on" })).toBe(true);
    expect(cfg.useDocumentModel({ ARTIFACTS_USE_DOCUMENT_MODEL: "1" })).toBe(true);
    expect(cfg.useDocumentModel({ ARTIFACTS_USE_DOCUMENT_MODEL: "false" })).toBe(false);
    expect(cfg.useDocumentModel({})).toBe(false);
  });

  it("binds parity to the domain's comparable adapters", () => {
    const rows = [row()];
    expect(cfg.checkParity(rows, rows, NOW).status).toBe("ok");
    expect(cfg.checkParity([], rows, NOW).status).toBe("drift");
  });

  it("rejects an incomplete config at wiring time", () => {
    expect(() => defineDomainCutover({ domain: "", flagKey: "X", substrateToComparable: artifactToComparable, legacyToComparable: artifactToComparable } as never)).toThrow(/non-empty/);
    expect(() => defineDomainCutover({ domain: "d", flagKey: "", substrateToComparable: artifactToComparable, legacyToComparable: artifactToComparable } as never)).toThrow(/flagKey/);
  });
});

describe("equivalence with the live artifacts parity", () => {
  const cfg = defineDomainCutover<ArtifactRow, ArtifactRow>({
    domain: "artifacts",
    flagKey: "ARTIFACTS_USE_DOCUMENT_MODEL",
    substrateToComparable: artifactToComparable,
    legacyToComparable: artifactToComparable,
    parity: { newestN: 20, groupDims: ["agent", "tag"] },
  });

  const scenarios: Array<{ name: string; substrate: ArtifactRow[]; legacy: ArtifactRow[] }> = [
    {
      name: "all faithful",
      substrate: [row({ abs_path: "/a.md" }), row({ abs_path: "/b.md", produced_at: "2026-06-23T11:00:00.000Z" })],
      legacy: [row({ abs_path: "/a.md" }), row({ abs_path: "/b.md", produced_at: "2026-06-23T11:00:00.000Z" })],
    },
    {
      name: "missing row",
      substrate: [row({ abs_path: "/a.md" })],
      legacy: [row({ abs_path: "/a.md" }), row({ abs_path: "/b.md" })],
    },
    {
      name: "title drift",
      substrate: [row({ abs_path: "/a.md", title: "X" })],
      legacy: [row({ abs_path: "/a.md", title: "Y" })],
    },
    {
      name: "substrate superset",
      substrate: [row({ abs_path: "/a.md" }), row({ abs_path: "/extra.md" })],
      legacy: [row({ abs_path: "/a.md" })],
    },
  ];

  for (const s of scenarios) {
    it(`matches computeArtifactParity status for: ${s.name}`, () => {
      const live = computeArtifactParity(s.substrate, s.legacy, NOW, 20);
      const generic = cfg.checkParity(s.substrate, s.legacy, NOW);
      expect(generic.status).toBe(live.status);
      // The gating metrics (presence + fidelity) agree on ok/not-ok.
      const livePresent = live.metrics.find((m) => m.name === "delivery_rows_present")?.ok;
      const genPresent = generic.metrics.find((m) => m.name === "legacy_rows_present")?.ok;
      expect(genPresent).toBe(livePresent);
      const liveTitle = live.metrics.find((m) => m.name === "title_fidelity")?.ok;
      const genTitle = generic.metrics.find((m) => m.name === "fidelity")?.ok;
      expect(genTitle).toBe(liveTitle);
    });
  }
});
