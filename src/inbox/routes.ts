// Inbox 2.0 — Express routes for /inbox/*.
// Read APIs + typed action mutation endpoints.

import type { Application, Request, Response } from 'express';
import type { DbAdapter } from '../db/db-adapter.js';
import type { InboxSummaryResponse, InboxItemDetail, OperatorState, ClassifyInboxItemOp, ProposeRouteOp } from './types.js';
import {
  countInboxItems, countReceivedSince, getOldestUnresolved, getNewestReceived,
  listInboxItems, getInboxItem, getLinks, getAuditEvents,
  getPolicyViolations, getRoutingDecisions, listAllPolicyViolations,
} from './storage.js';
import { applyClassifyInboxItem, applyProposeRoute, applySnooze, applyCheckOff, applyAuditNote } from './ops.js';
import { applyBulkInboxAction } from './bulk.js';
import { evaluateInboxRouting, DEFAULT_ROUTING_RULES } from './evaluator.js';

export function mountInboxRoutes(app: Application, adapter: DbAdapter): void {

  // ── GET /inbox/summary ──

  app.get('/inbox/summary', async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      const [last24h, newCount, needsRouteCount, waitingCount, outputReady, snoozed, errored, oldest, newest] = await Promise.all([
        countReceivedSince(adapter, since24h),
        countInboxItems(adapter, 'new'),
        countInboxItems(adapter, 'needs_route'),
        countInboxItems(adapter, 'waiting_on_agent'),
        countInboxItems(adapter, 'output_ready'),
        countInboxItems(adapter, 'snoozed'),
        countInboxItems(adapter, 'errored'),
        getOldestUnresolved(adapter),
        getNewestReceived(adapter),
      ]);

      const { rows: approvalRows } = await adapter.query<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM inbox_items WHERE classification_label = 'approval_needed'",
        [],
      );

      const response: InboxSummaryResponse = {
        schema_version: 'inbox.summary.v1',
        generated_at: now.toISOString(),
        last_24h_received: last24h,
        unresolved: newCount + needsRouteCount + waitingCount,
        waiting_on_agent: waitingCount,
        output_ready: outputReady,
        approval_needed: Number(approvalRows[0]?.cnt ?? 0),
        snoozed,
        errored,
        freshness: {
          oldest_unresolved_at: oldest,
          newest_received_at: newest,
          projection_version: 1,
        },
      };

      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /inbox/items ──

  app.get('/inbox/items', async (req: Request, res: Response) => {
    try {
      const filters = {
        state: req.query.state as OperatorState | undefined,
        source: req.query.source as string | undefined,
        project: req.query.project as string | undefined,
        agent: req.query.agent as string | undefined,
        policy_violation: req.query.policy_violation === 'true',
        snoozed: req.query.snoozed === 'true' ? true : req.query.snoozed === 'false' ? false : undefined,
        errored: req.query.errored === 'true',
      };
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const items = await listInboxItems(adapter, filters, limit, offset);
      res.json({ items, limit, offset, count: items.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /inbox/items/:phid ──

  app.get('/inbox/items/:phid', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      const item = await getInboxItem(adapter, req.params.phid);
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }

      const [links, audit_events, policy_violations, routing_decisions] = await Promise.all([
        getLinks(adapter, req.params.phid),
        getAuditEvents(adapter, req.params.phid),
        getPolicyViolations(adapter, req.params.phid),
        getRoutingDecisions(adapter, req.params.phid),
      ]);

      const detail: InboxItemDetail = {
        item,
        links,
        audit_events,
        policy_violations,
        routing_decisions,
      };

      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /inbox/routing-rules ──

  app.get('/inbox/routing-rules', (_req: Request, res: Response) => {
    res.json({ rules: DEFAULT_ROUTING_RULES });
  });

  // ── GET /inbox/policy-violations ──

  app.get('/inbox/policy-violations', async (req: Request, res: Response) => {
    try {
      const unresolved = req.query.unresolved !== 'false';
      const violations = await listAllPolicyViolations(adapter, unresolved);
      res.json({ violations, count: violations.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/classify ──

  app.post('/inbox/items/:phid/classify', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      const op: ClassifyInboxItemOp = {
        type: 'CLASSIFY_INBOX_ITEM',
        inbox_phid: req.params.phid,
        actor: req.body.actor ?? { id: 'human:chris', kind: 'human' },
        ts: req.body.ts ?? new Date().toISOString(),
        label: req.body.label,
        confidence: req.body.confidence ?? null,
        classifier: req.body.classifier ?? 'human',
        rule_id: req.body.rule_id ?? null,
        rationale: req.body.rationale,
        projected_project: req.body.projected_project ?? null,
        projected_agent: req.body.projected_agent ?? null,
        projected_action: req.body.projected_action ?? null,
        source_op_id: req.body.source_op_id ?? null,
        input_revision: req.body.input_revision ?? `rev-${Date.now()}`,
        idempotency_key: req.body.idempotency_key ?? `classify-${Date.now()}`,
      };

      const result = await applyClassifyInboxItem(adapter, op);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/propose-route ──

  app.post('/inbox/items/:phid/propose-route', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      const op: ProposeRouteOp = {
        type: 'PROPOSE_ROUTE',
        inbox_phid: req.params.phid,
        actor: req.body.actor ?? { id: 'human:chris', kind: 'human' },
        ts: req.body.ts ?? new Date().toISOString(),
        rule_id: req.body.rule_id ?? null,
        action_type: req.body.action_type,
        action_target: req.body.action_target ?? null,
        reason: req.body.reason,
        input_revision: req.body.input_revision ?? `rev-${Date.now()}`,
        is_primary: req.body.is_primary ?? true,
        idempotency_key: req.body.idempotency_key ?? `route-${Date.now()}`,
      };

      const result = await applyProposeRoute(adapter, op);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/snooze ──

  app.post('/inbox/items/:phid/snooze', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      await applySnooze(adapter, {
        type: 'SNOOZE',
        inbox_phid: req.params.phid,
        actor_id: req.body.actor_id ?? 'human:chris',
        ts: req.body.ts ?? new Date().toISOString(),
        until: req.body.until,
        reason: req.body.reason ?? null,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/check-off ──

  app.post('/inbox/items/:phid/check-off', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      await applyCheckOff(adapter, {
        type: 'CHECK_OFF',
        inbox_phid: req.params.phid,
        actor_id: req.body.actor_id ?? 'human:chris',
        ts: req.body.ts ?? new Date().toISOString(),
        reason: req.body.reason,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/audit-note ──

  app.post('/inbox/items/:phid/audit-note', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      await applyAuditNote(adapter, {
        type: 'AUDIT_NOTE',
        inbox_phid: req.params.phid,
        actor_id: req.body.actor_id ?? 'human:chris',
        ts: req.body.ts ?? new Date().toISOString(),
        note: req.body.note,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/bulk ── (PT5: bulk route / archive / mark_acted over many items)

  app.post('/inbox/bulk', async (req: Request, res: Response) => {
    try {
      const result = await applyBulkInboxAction(adapter, {
        action: req.body.action,
        phids: req.body.phids ?? [],
        actor_id: req.body.actor_id ?? 'human:chris',
        ts: req.body.ts ?? new Date().toISOString(),
        reason: req.body.reason ?? null,
        action_type: req.body.action_type,
        action_target: req.body.action_target ?? null,
        rule_id: req.body.rule_id ?? null,
      });
      res.json({ schema_version: 'inbox.bulk.v1', ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── POST /inbox/items/:phid/evaluate-routes ──

  app.post('/inbox/items/:phid/evaluate-routes', async (req: Request<{ phid: string }>, res: Response) => {
    try {
      const item = await getInboxItem(adapter, req.params.phid);
      if (!item) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
      const decisions = evaluateInboxRouting(item, DEFAULT_ROUTING_RULES, new Date());
      res.json({ decisions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
