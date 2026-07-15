// Verify-on-done gate — rejects hollow dones (claimed deliverable absent).

import { describe, it, expect } from "vitest";
import {
  requiresSmallSiteFixContract,
  verifyDoneClaims,
  type DoneClaim,
  type DoneVerificationProbes,
} from "../../src/dispatch-verification/done-verification.js";

function probes(over: Partial<DoneVerificationProbes> = {}): DoneVerificationProbes {
  return {
    fileExists: () => true,
    commitOnBase: () => true,
    ...over,
  };
}

describe("verifyDoneClaims", () => {
  it("passes when a claimed artifact exists", () => {
    const claim: DoneClaim = { artifact_path: "/abs/output/report.md" };
    const r = verifyDoneClaims(claim, probes({ fileExists: () => true }));
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ kind: "artifact", ok: true });
  });

  it("FAILS (hollow done) when a claimed artifact is missing", () => {
    const claim: DoneClaim = { artifact_path: "/abs/output/missing.md" };
    const r = verifyDoneClaims(claim, probes({ fileExists: () => false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/claimed artifact not found/);
    expect(r.checks[0].ok).toBe(false);
  });

  it("passes when a promoted commit is on base", () => {
    const claim: DoneClaim = {
      promotion: { repos: [{ path: "/repo", base: "main", promoted_sha: "abc123" }] },
    };
    const r = verifyDoneClaims(claim, probes({ commitOnBase: () => true }));
    expect(r.ok).toBe(true);
    expect(r.checks[0]).toMatchObject({ kind: "commit", target: "abc123@main", ok: true });
  });

  it("FAILS when a promoted commit is NOT on base", () => {
    const claim: DoneClaim = {
      promotion: { repos: [{ path: "/repo", base: "main", promoted_sha: "deadbeef" }] },
    };
    const r = verifyDoneClaims(claim, probes({ commitOnBase: () => false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/deadbeef is not on main/);
  });

  it("FAILS when a promotion repo is missing its path", () => {
    const claim: DoneClaim = { promotion: { repos: [{ promoted_sha: "abc123" }] } };
    const r = verifyDoneClaims(claim, probes());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing path/);
  });

  it("passes a dispatch that claims nothing verifiable (gate never invents a requirement)", () => {
    expect(verifyDoneClaims({}, probes()).ok).toBe(true);
    expect(verifyDoneClaims({ artifact_path: "  " }, probes()).ok).toBe(true);
    expect(verifyDoneClaims({ promotion: { repos: [] } }, probes()).ok).toBe(true);
  });

  it("verifies ALL claims — artifact ok but a commit missing still fails", () => {
    const claim: DoneClaim = {
      artifact_path: "/abs/output/report.md",
      promotion: {
        repos: [
          { path: "/repo", base: "main", promoted_sha: "good" },
          { path: "/repo2", base: "main", promoted_sha: "bad" },
        ],
      },
    };
    const r = verifyDoneClaims(claim, probes({
      fileExists: () => true,
      commitOnBase: (_p, sha) => sha === "good",
    }));
    expect(r.ok).toBe(false);
    expect(r.checks.filter((c) => c.ok)).toHaveLength(2); // artifact + good commit
    expect(r.reason).toMatch(/bad is not on main/);
  });

  it("treats a throwing probe as a failed check (never crashes the gate)", () => {
    const claim: DoneClaim = { artifact_path: "/x" };
    const r = verifyDoneClaims(claim, probes({ fileExists: () => { throw new Error("fs boom"); } }));
    expect(r.ok).toBe(false);
  });

  it("requires owner acceptance, production URL, and screenshot/evidence for Finance site-fix dispatches", () => {
    const claim: DoneClaim = {
      dispatch_context: {
        subject: "Finance net-worth graph site fix",
        body_markdown: "Fix the Finance net-worth graph rendering regression and ship the small site update.",
      },
    };
    expect(requiresSmallSiteFixContract(claim)).toMatchObject({ required: true });

    const r = verifyDoneClaims(claim, probes());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Finance\/Cleveland Park/);
    expect(r.reason).toMatch(/owner_accepted=true/);
    expect(r.reason).toMatch(/production_url/);
    expect(r.reason).toMatch(/screenshot_or_evidence/);
  });

  it("accepts a complete small site-fix delivery contract", () => {
    const claim: DoneClaim = {
      dispatch_context: {
        subject: "Cleveland Park preview update",
        body_markdown: "Patch the website PDF preview and deliver production evidence.",
      },
      delivery_contract: {
        kind: "small_site_fix",
        project: "Cleveland Park",
        owner_accepted: true,
        production_url: "https://cleveland-park.example.com/parents",
        screenshot_url: "https://cleveland-park.example.com/evidence/preview.png",
      },
    };
    const r = verifyDoneClaims(claim, probes());
    expect(r.ok).toBe(true);
    expect(r.checks).toContainEqual(expect.objectContaining({
      kind: "small_site_fix_contract",
      ok: true,
      target: "Cleveland Park",
    }));
  });

  it("rejects local URLs as production evidence for a small site-fix delivery contract", () => {
    const r = verifyDoneClaims({
      delivery_contract: {
        kind: "small_site_fix",
        project: "Finance",
        owner_accepted: "accepted",
        production_url: "http://localhost:3000/finance",
        screenshot_path: "/tmp/finance-graph.png",
      },
    }, probes());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/production_url/);
  });
});
