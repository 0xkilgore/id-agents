// T-CKPT.agent-sharing / F4 — Express routes for share/delegate grants.
//
//   POST /shares             — share a subject with a Monday user (kind=share)
//   POST /delegations        — delegate a subject to an agent (kind=delegate)
//   GET  /grants             — list grants (filter by actor/subject/grantee/kind)
//   GET  /grants/:id         — fetch one grant
//   POST /grants/:id/revoke  — revoke an active grant (grantor or user:chris)
//
// Validation/shaping lives in model.buildGrant; persistence in storage. Routes
// stay thin and map model/storage results to typed HTTP responses.

import type { Application, Request, Response } from "express";
import type { DbAdapter } from "../db/db-adapter.js";
import { randomUUID } from "node:crypto";
import { normalizeActorRef } from "../actor-identity.js";
import { buildGrant, canRevoke, type GrantKind, type GranteeKind } from "./model.js";
import {
  insertGrant,
  listGrants,
  getGrant,
  revokeGrant,
  type GrantFilter,
} from "./storage.js";

export function mountAgentSharingRoutes(
  app: Application,
  adapter: DbAdapter,
  opts: { nowIso?: () => string; idGen?: () => string } = {},
): void {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const idGen = opts.idGen ?? (() => randomUUID());

  async function createGrant(kind: GrantKind, req: Request, res: Response) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // /delegations accepts `agent` as a friendlier alias for grantee_ref.
    const grantee_ref = kind === "delegate" ? (body.grantee_ref ?? body.agent) : body.grantee_ref;
    const built = buildGrant(
      {
        kind,
        actor_ref: body.actor_ref ?? body.actorRef,
        subject_kind: body.subject_kind,
        subject_ref: body.subject_ref,
        grantee_ref,
        scope: body.scope,
      },
      nowIso(),
      idGen,
    );
    if (!built.ok) {
      return res.status(400).json({ ok: false, error: built.error });
    }
    try {
      const result = await insertGrant(adapter, built.grant);
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        created: result.created,
        grant: result.grant,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  app.post("/shares", (req, res) => createGrant("share", req, res));
  app.post("/delegations", (req, res) => createGrant("delegate", req, res));

  app.get("/grants", async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const filter: GrantFilter = {
        kind: q.kind as GrantKind | undefined,
        actor_ref: q.actor_ref,
        subject_kind: q.subject_kind,
        subject_ref: q.subject_ref,
        grantee_kind: q.grantee_kind as GranteeKind | undefined,
        grantee_ref: q.grantee_ref,
        active_only: q.active === "all" ? false : true,
      };
      const grants = await listGrants(adapter, filter);
      return res.json({ ok: true, grants, count: grants.length });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/grants/:id", async (req, res) => {
    try {
      const grant = await getGrant(adapter, req.params.id);
      if (!grant) return res.status(404).json({ ok: false, error: "grant not found" });
      return res.json({ ok: true, grant });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/grants/:id/revoke", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actorRef = body.actor_ref ?? body.actorRef;
      const grant = await getGrant(adapter, req.params.id);
      if (!grant) return res.status(404).json({ ok: false, error: "grant not found" });
      if (!canRevoke(grant, actorRef)) {
        return res.status(403).json({ ok: false, error: "only the granting actor or user:chris may revoke" });
      }
      // Record the actual revoker (grantor or the user:chris override), not the grantor by default.
      const revokerRes = normalizeActorRef(actorRef);
      const revokedBy = revokerRes.ok ? revokerRes.actor.ref : grant.actor_ref;
      const result = await revokeGrant(adapter, req.params.id, revokedBy, nowIso());
      if (!result.ok && result.reason === "already_revoked") {
        return res.status(409).json({ ok: false, error: "grant already revoked", grant: result.grant });
      }
      if (!result.ok) return res.status(404).json({ ok: false, error: "grant not found" });
      return res.json({ ok: true, grant: result.grant });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
