// T-CKPT.agent-sharing / F4 — pure grant model: validate + shape share/delegate
// requests over the Monday seed actors, plus identity key + revoke authority.

import { describe, it, expect } from "vitest";
import {
  buildGrant,
  grantIdentityKey,
  canRevoke,
  DEFAULT_GRANT_SCOPE,
  type BuildGrantInput,
} from "../../src/agent-sharing/model.js";

const NOW = "2026-06-24T12:00:00.000Z";
let counter = 0;
const idGen = () => `grant-${++counter}`;

function input(over: Partial<BuildGrantInput>): BuildGrantInput {
  return {
    kind: "share",
    actor_ref: "user:chris",
    subject_kind: "project",
    subject_ref: "blowout",
    grantee_ref: "user:liz",
    ...over,
  };
}

describe("buildGrant — share", () => {
  it("shares a subject from one Monday actor to another", () => {
    const r = buildGrant(input({}), NOW, idGen);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.grant).toMatchObject({
        kind: "share",
        actor_ref: "user:chris",
        subject_kind: "project",
        subject_ref: "blowout",
        grantee_kind: "user",
        grantee_ref: "user:liz",
        scope: DEFAULT_GRANT_SCOPE,
        revoked_at: null,
      });
    }
  });

  it("normalizes actor + grantee aliases (chris/liz) to Monday refs", () => {
    const r = buildGrant(input({ actor_ref: "chris", grantee_ref: "liz" }), NOW, idGen);
    expect(r.ok && r.grant.actor_ref).toBe("user:chris");
    expect(r.ok && r.grant.grantee_ref).toBe("user:liz");
  });

  it("rejects sharing with yourself", () => {
    const r = buildGrant(input({ actor_ref: "user:liz", grantee_ref: "user:liz" }), NOW, idGen);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/yourself/);
  });

  it("rejects an unknown grantee actor for a share", () => {
    const r = buildGrant(input({ grantee_ref: "user:bob" }), NOW, idGen);
    expect(r.ok).toBe(false);
  });
});

describe("buildGrant — delegate", () => {
  it("delegates a subject to an agent", () => {
    const r = buildGrant(
      input({ kind: "delegate", grantee_ref: "finances", subject_ref: "q2-close" }),
      NOW,
      idGen,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.grant).toMatchObject({ kind: "delegate", grantee_kind: "agent", grantee_ref: "finances" });
    }
  });

  it("strips an agent: prefix on the delegate grantee", () => {
    const r = buildGrant(input({ kind: "delegate", grantee_ref: "agent:finances" }), NOW, idGen);
    expect(r.ok && r.grant.grantee_ref).toBe("finances");
  });

  it("rejects delegating to a Monday user (use share for people)", () => {
    const r = buildGrant(input({ kind: "delegate", grantee_ref: "user:liz" }), NOW, idGen);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/agent name/);
  });
});

describe("buildGrant — validation", () => {
  it("rejects an unknown kind", () => {
    const r = buildGrant(input({ kind: "transfer" as unknown as "share" }), NOW, idGen);
    expect(r.ok).toBe(false);
  });
  it("rejects an unknown granting actor", () => {
    expect(buildGrant(input({ actor_ref: "user:bob" }), NOW, idGen).ok).toBe(false);
    expect(buildGrant(input({ actor_ref: "" }), NOW, idGen).ok).toBe(false);
  });
  it("requires subject_kind and subject_ref", () => {
    expect(buildGrant(input({ subject_kind: "" }), NOW, idGen).ok).toBe(false);
    expect(buildGrant(input({ subject_ref: "  " }), NOW, idGen).ok).toBe(false);
  });
  it("requires a grantee", () => {
    expect(buildGrant(input({ grantee_ref: "" }), NOW, idGen).ok).toBe(false);
  });
  it("accepts a valid scope and rejects an invalid one", () => {
    expect(buildGrant(input({ scope: "view" }), NOW, idGen).ok).toBe(true);
    const bad = buildGrant(input({ scope: "admin" }), NOW, idGen);
    expect(bad.ok).toBe(false);
  });
});

describe("grantIdentityKey", () => {
  it("is stable across scope but distinct per (kind, actor, subject, grantee)", () => {
    const a = buildGrant(input({ scope: "view" }), NOW, idGen);
    const b = buildGrant(input({ scope: "collaborate" }), NOW, idGen);
    expect(a.ok && b.ok && grantIdentityKey(a.grant) === grantIdentityKey(b.grant)).toBe(true);
    const c = buildGrant(input({ subject_ref: "other" }), NOW, idGen);
    expect(a.ok && c.ok && grantIdentityKey(a.grant) === grantIdentityKey(c.grant)).toBe(false);
  });
});

describe("canRevoke", () => {
  const grant = { actor_ref: "user:liz" };
  it("the granting actor may revoke", () => {
    expect(canRevoke(grant, "user:liz")).toBe(true);
    expect(canRevoke(grant, "liz")).toBe(true);
  });
  it("user:chris may revoke anyone's grant (admin override)", () => {
    expect(canRevoke(grant, "user:chris")).toBe(true);
  });
  it("a non-grantor non-chris actor may not revoke", () => {
    expect(canRevoke({ actor_ref: "user:chris" }, "user:liz")).toBe(false);
  });
  it("an unknown actor may never revoke", () => {
    expect(canRevoke(grant, "user:bob")).toBe(false);
    expect(canRevoke(grant, "")).toBe(false);
  });
});
