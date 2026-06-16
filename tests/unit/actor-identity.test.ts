// Monday second-user actor identity foundation (Liz build plan §1) + RD-001
// stable-artifact-id guard.

import { describe, it, expect } from "vitest";
import {
  normalizeActorRef,
  isValidArtifactId,
  MONDAY_ACTORS,
} from "../../src/actor-identity.js";

describe("normalizeActorRef", () => {
  it("resolves user:chris", () => {
    const r = normalizeActorRef("user:chris");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.actor).toEqual(MONDAY_ACTORS["user:chris"]);
      expect(r.actor.displayName).toBe("Chris");
    }
  });

  it("resolves user:liz", () => {
    const r = normalizeActorRef("user:liz");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.actor.id).toBe("liz");
  });

  it("keeps existing Chris flows working (chris / human:chris aliases)", () => {
    for (const alias of ["chris", "human:chris", "USER:CHRIS", " Chris "]) {
      const r = normalizeActorRef(alias);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.actor.ref).toBe("user:chris");
    }
  });

  it("rejects a missing actor with missing_actor", () => {
    for (const v of [undefined, null, "", "   "]) {
      const r = normalizeActorRef(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("missing_actor");
    }
  });

  it("rejects an arbitrary/unknown actor with unknown_actor", () => {
    for (const v of ["erica", "user:erica", "human:bob", "agent:regina", "system:auto"]) {
      const r = normalizeActorRef(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("unknown_actor");
    }
  });

  it("rejects non-string actors", () => {
    const r = normalizeActorRef({ id: "chris" } as unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_actor");
  });
});

describe("isValidArtifactId (RD-001)", () => {
  it("accepts stable artifact_id forms", () => {
    expect(isValidArtifactId("art-0a7da5daf9a90777")).toBe(true);
    expect(isValidArtifactId("art:x:y.md")).toBe(true); // doc-model id form
    expect(isValidArtifactId("phid:artifact:abc")).toBe(true);
  });

  it("rejects basenames, paths, indexes, and display labels", () => {
    expect(isValidArtifactId("loops-page-ux-review.md")).toBe(false); // basename
    expect(isValidArtifactId("/Users/kilgore/Code/rams/output/foo.md")).toBe(false); // path
    expect(isValidArtifactId("3")).toBe(false); // queue index
    expect(isValidArtifactId("12")).toBe(false);
    expect(isValidArtifactId("Loops Page Review")).toBe(false); // display label
    expect(isValidArtifactId("")).toBe(false);
    expect(isValidArtifactId(undefined)).toBe(false);
    expect(isValidArtifactId(42 as unknown)).toBe(false);
  });
});
