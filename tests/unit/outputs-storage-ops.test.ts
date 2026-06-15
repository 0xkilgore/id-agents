// Kapelle B11 — tests for outputs storage + ops (manager-side artifact
// review surface).

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import {
  migrateOutputsTables,
  getReviewState,
  countOperations,
  listOperations,
  listInboxItems,
  deriveStatus,
  artifactIdFromPath,
  registerArtifact,
  getArtifact,
  backfillCatalogFromDeliveryLog,
} from '../../src/outputs/storage.js';
import {
  viewArtifact,
  approveArtifact,
  shipArtifact,
  computeShipBlockers,
  SHIP_BLOCKERS,
} from '../../src/outputs/ops.js';

function makeAdapter(): SqliteAdapter {
  const adapter = new SqliteAdapter(':memory:');
  return adapter;
}

async function setup(): Promise<SqliteAdapter> {
  const adapter = makeAdapter();
  await migrateOutputsTables(adapter);
  return adapter;
}

describe('Kapelle B11 — outputs/storage migration', () => {
  it('creates the three artifact_* / artifacts tables', async () => {
    const adapter = await setup();
    const { rows } = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'artifact_%' OR name = 'artifacts')",
      [],
    );
    const names = rows.map(r => r.name).sort();
    expect(names).toEqual(['artifact_operations', 'artifact_review_state', 'artifacts']);
  });

  it('is idempotent — second migration call is a no-op', async () => {
    const adapter = await setup();
    await migrateOutputsTables(adapter);
    // Still works.
    const state = await getReviewState(adapter, 'art-missing');
    expect(state).toBeNull();
  });
});

describe('Kapelle B11 — viewArtifact', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('lazily creates a review row on first view', async () => {
    const result = await viewArtifact(adapter, 'art-1', { viewer: 'chris' });
    expect(result.state.first_viewed_at).not.toBeNull();
    expect(result.state.last_viewed_at).toBe(result.state.first_viewed_at);
    expect(result.state.viewed_by_last).toBe('chris');
    expect(result.state.viewed_count).toBe(1);
    expect(result.op_id).toBeGreaterThan(0);

    const count = await countOperations(adapter, 'art-1');
    expect(count).toBe(1);
  });

  it('increments viewed_count + updates last_viewed_at on repeat views', async () => {
    await viewArtifact(adapter, 'art-1', { viewer: 'chris' });
    const second = await viewArtifact(adapter, 'art-1', { viewer: 'erica' });
    expect(second.state.viewed_count).toBe(2);
    expect(second.state.viewed_by_last).toBe('erica');
    // first_viewed_at should NOT change
    expect(second.state.first_viewed_at).toBeTruthy();
    // op log grows
    const count = await countOperations(adapter, 'art-1');
    expect(count).toBe(2);
  });

  it('records source_link if provided on view', async () => {
    const result = await viewArtifact(adapter, 'art-2', {
      viewer: 'chris',
      source_link: 'reactor:phid:art-XYZ',
    });
    expect(result.state.source_link).toBe('reactor:phid:art-XYZ');
  });

  it('defaults the viewer to "operator" when none supplied', async () => {
    const result = await viewArtifact(adapter, 'art-3', {});
    expect(result.state.viewed_by_last).toBe('operator');
  });
});

describe('Kapelle B11 — approveArtifact', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('approves a never-viewed artifact (lazy create)', async () => {
    const result = await approveArtifact(adapter, 'art-1', { approver: 'chris', note: 'LGTM' });
    expect(result.state.approved_at).toBeTruthy();
    expect(result.state.approved_by).toBe('chris');
    expect(result.state.approval_note).toBe('LGTM');
  });

  it('first-approve-wins for approved_at', async () => {
    const first = await approveArtifact(adapter, 'art-1', { approver: 'chris' });
    const firstTs = first.state.approved_at;
    // Tiny delay to ensure different ISO timestamps
    await new Promise(r => setTimeout(r, 10));
    const second = await approveArtifact(adapter, 'art-1', { approver: 'erica', note: 'reaffirmed' });
    expect(second.state.approved_at).toBe(firstTs);
    // But approved_by + note update
    expect(second.state.approved_by).toBe('erica');
    expect(second.state.approval_note).toBe('reaffirmed');
  });
});

describe('Kapelle B11 — computeShipBlockers', () => {
  it('returns NO_EXECUTOR + NOT_APPROVED for a fresh artifact', () => {
    const blockers = computeShipBlockers(null);
    expect(blockers).toContain(SHIP_BLOCKERS.NO_EXECUTOR);
    expect(blockers).toContain(SHIP_BLOCKERS.NOT_APPROVED);
    expect(blockers).not.toContain(SHIP_BLOCKERS.ALREADY_SHIPPED);
  });

  it('drops NOT_APPROVED once approved', () => {
    const state = {
      artifact_id: 'a', source_link: null,
      first_viewed_at: '2026-06-08T00:00:00Z', last_viewed_at: '2026-06-08T00:00:00Z',
      viewed_by_last: 'chris', viewed_count: 1,
      approved_at: '2026-06-08T00:01:00Z', approved_by: 'chris', approval_note: null,
      shipped_at: null, shipped_by: null, ship_blockers_json: null,
      created_at: '2026-06-08T00:00:00Z', updated_at: '2026-06-08T00:01:00Z',
    };
    const blockers = computeShipBlockers(state);
    expect(blockers).not.toContain(SHIP_BLOCKERS.NOT_APPROVED);
    expect(blockers).toContain(SHIP_BLOCKERS.NO_EXECUTOR);
  });

  it('returns ALREADY_SHIPPED + NO_EXECUTOR for a shipped artifact', () => {
    const state = {
      artifact_id: 'a', source_link: null,
      first_viewed_at: '2026-06-08T00:00:00Z', last_viewed_at: '2026-06-08T00:00:00Z',
      viewed_by_last: 'chris', viewed_count: 1,
      approved_at: '2026-06-08T00:01:00Z', approved_by: 'chris', approval_note: null,
      shipped_at: '2026-06-08T00:02:00Z', shipped_by: 'chris', ship_blockers_json: null,
      created_at: '2026-06-08T00:00:00Z', updated_at: '2026-06-08T00:02:00Z',
    };
    const blockers = computeShipBlockers(state);
    expect(blockers).toContain(SHIP_BLOCKERS.ALREADY_SHIPPED);
    expect(blockers).toContain(SHIP_BLOCKERS.NO_EXECUTOR);
  });
});

describe('Kapelle B11 — shipArtifact (stubbed: always blocks today)', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('returns status:"blocked" with no_executor + not_approved for a fresh artifact', async () => {
    const result = await shipArtifact(adapter, 'art-1', { shipper: 'chris' });
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('no_executor_configured');
    expect(result.blockers).toContain('artifact_not_approved');
    expect(result.recorded_op_id).toBeGreaterThan(0);
  });

  it('records a ship_blocked op even when blocked', async () => {
    await shipArtifact(adapter, 'art-1', { shipper: 'chris' });
    const ops = await listOperations(adapter, 'art-1', 10, 0);
    const opTypes = ops.map(o => o.op_type);
    expect(opTypes).toContain('ship_blocked');
  });

  it('keeps no_executor blocker even after approve (stub guarantee)', async () => {
    await approveArtifact(adapter, 'art-1', { approver: 'chris' });
    const result = await shipArtifact(adapter, 'art-1', { shipper: 'chris' });
    expect(result.status).toBe('blocked');
    expect(result.blockers).toEqual(['no_executor_configured']);
  });

  it('persists ship_blockers_json to review state', async () => {
    await shipArtifact(adapter, 'art-1', { shipper: 'chris' });
    const state = await getReviewState(adapter, 'art-1');
    expect(state).not.toBeNull();
    expect(state!.ship_blockers_json).toBeTruthy();
    const decoded = JSON.parse(state!.ship_blockers_json!);
    expect(Array.isArray(decoded)).toBe(true);
  });
});

describe('Kapelle B11 — listInboxItems projection', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('returns items with derived status', async () => {
    await viewArtifact(adapter, 'art-viewed', { viewer: 'chris' });
    await approveArtifact(adapter, 'art-approved', { approver: 'chris' });
    await shipArtifact(adapter, 'art-blocked', { shipper: 'chris' }); // creates ship_blocked

    const items = await listInboxItems(adapter, {}, 50, 0);
    const byId = new Map(items.map(i => [i.artifact_id, i]));
    expect(byId.get('art-viewed')!.status).toBe('viewed');
    expect(byId.get('art-approved')!.status).toBe('approved');
    expect(byId.get('art-blocked')!.status).toBe('ship_blocked');
  });

  it('filters by status', async () => {
    await viewArtifact(adapter, 'art-A', { viewer: 'c' });
    await approveArtifact(adapter, 'art-B', { approver: 'c' });
    const onlyApproved = await listInboxItems(adapter, { status: 'approved' }, 50, 0);
    expect(onlyApproved.map(i => i.artifact_id)).toEqual(['art-B']);
  });

  it('annotates op_count + last_op_at', async () => {
    await viewArtifact(adapter, 'art-1', { viewer: 'c' });
    await viewArtifact(adapter, 'art-1', { viewer: 'c' });
    await approveArtifact(adapter, 'art-1', { approver: 'c' });
    const items = await listInboxItems(adapter, {}, 50, 0);
    expect(items[0].op_count).toBe(3);
    expect(items[0].last_op_at).toBeTruthy();
  });
});

describe('Kapelle B11 — deriveStatus', () => {
  const base = {
    artifact_id: 'a', source_link: null,
    first_viewed_at: null, last_viewed_at: null,
    viewed_by_last: null, viewed_count: 0,
    approved_at: null, approved_by: null, approval_note: null,
    shipped_at: null, shipped_by: null, ship_blockers_json: null,
    created_at: '2026-06-08T00:00:00Z', updated_at: '2026-06-08T00:00:00Z',
  };

  it('never_viewed when nothing set', () => {
    expect(deriveStatus(base)).toBe('never_viewed');
  });
  it('viewed when first_viewed_at set', () => {
    expect(deriveStatus({ ...base, first_viewed_at: '2026-06-08T00:01:00Z' })).toBe('viewed');
  });
  it('approved when approved_at set', () => {
    expect(deriveStatus({
      ...base,
      first_viewed_at: '2026-06-08T00:01:00Z',
      approved_at: '2026-06-08T00:02:00Z',
    })).toBe('approved');
  });
  it('shipped when shipped_at set', () => {
    expect(deriveStatus({ ...base, shipped_at: '2026-06-08T00:03:00Z' })).toBe('shipped');
  });
  it('ship_blocked when ship_blockers_json set but not shipped', () => {
    expect(deriveStatus({ ...base, ship_blockers_json: '["x"]' })).toBe('ship_blocked');
  });
});

// ── Catalog: artifacts table + register + backfill ─────────────────

describe('Kapelle B11 — artifactIdFromPath', () => {
  it('produces deterministic art-<hex> ids', () => {
    const a = artifactIdFromPath('/abs/foo.md');
    const b = artifactIdFromPath('/abs/foo.md');
    expect(a).toBe(b);
    expect(a).toMatch(/^art-[0-9a-f]{16}$/);
  });
  it('different paths → different ids', () => {
    expect(artifactIdFromPath('/abs/foo.md')).not.toBe(artifactIdFromPath('/abs/bar.md'));
  });
});

describe('Kapelle B11 — registerArtifact + getArtifact', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('inserts on first call, returns inserted=true', async () => {
    const { row, inserted } = await registerArtifact(adapter, {
      basename: '2026-06-08-foo.md',
      agent: 'cane',
      tag: 'today',
      abs_path: '/abs/foo.md',
      title: 'Foo summary',
      produced_at: '2026-06-08T09:00:00-05:00',
      source: 'agent-done',
    }, '2026-06-08T09:00:00Z');
    expect(inserted).toBe(true);
    expect(row.artifact_id).toMatch(/^art-/);
    expect(row.availability).toBe('present');

    const fetched = await getArtifact(adapter, row.artifact_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Foo summary');
    expect(fetched!.tag).toBe('today');
  });

  it('preserves produced_at on update (first-writer wins)', async () => {
    const r1 = await registerArtifact(adapter, {
      basename: 'x.md', agent: 'cane', abs_path: '/abs/x.md',
      produced_at: '2026-06-08T09:00:00-05:00',
    }, '2026-06-08T09:00:00Z');
    expect(r1.inserted).toBe(true);
    const r2 = await registerArtifact(adapter, {
      basename: 'x.md', agent: 'cane', abs_path: '/abs/x.md',
      produced_at: '2099-01-01T00:00:00Z', // newer ts — should be ignored
      title: 'updated title',
    }, '2026-06-08T10:00:00Z');
    expect(r2.inserted).toBe(false);
    expect(r2.row.produced_at).toBe('2026-06-08T09:00:00-05:00');
    expect(r2.row.title).toBe('updated title');
  });

  it('supports availability=missing on register (ghost-file flag)', async () => {
    const { row } = await registerArtifact(adapter, {
      basename: 'gone.md', agent: 'cane', abs_path: '/abs/gone.md',
      produced_at: '2026-06-08T09:00:00-05:00',
      availability: 'missing',
    }, '2026-06-08T09:00:00Z');
    expect(row.availability).toBe('missing');
  });
});

describe('Kapelle B11 — listInboxItems join with catalog', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('joins catalog fields when present', async () => {
    const path = '/abs/foo.md';
    const id = artifactIdFromPath(path);
    await viewArtifact(adapter, id, { viewer: 'chris' });
    await registerArtifact(adapter, {
      basename: '2026-06-08-foo.md',
      agent: 'cane',
      tag: 'today',
      abs_path: path,
      title: 'Foo bar',
      produced_at: '2026-06-08T09:00:00-05:00',
    }, '2026-06-08T09:00:00Z');

    const items = await listInboxItems(adapter, {}, 50, 0);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Foo bar');
    expect(items[0].basename).toBe('2026-06-08-foo.md');
    expect(items[0].agent).toBe('cane');
    expect(items[0].tag).toBe('today');
    expect(items[0].abs_path).toBe(path);
    expect(items[0].availability).toBe('present');
  });

  it('returns availability=unknown when review row exists but no catalog row', async () => {
    await viewArtifact(adapter, 'art-orphan', { viewer: 'chris' });
    const items = await listInboxItems(adapter, {}, 50, 0);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBeNull();
    expect(items[0].basename).toBeNull();
    expect(items[0].availability).toBe('unknown');
  });

  it('W1-6: catalog-only artifact (no review row) appears as never_viewed when includeNeverViewed', async () => {
    const path = '/abs/catalog-only.md';
    await registerArtifact(adapter, {
      basename: 'catalog-only.md',
      agent: 'cane',
      tag: 'today',
      abs_path: path,
      title: 'Catalog only',
      produced_at: '2026-06-08T09:00:00-05:00',
    }, '2026-06-08T09:00:00Z');

    const items = await listInboxItems(adapter, { includeNeverViewed: true }, 50, 0);
    expect(items).toHaveLength(1);
    expect(items[0].artifact_id).toBe(artifactIdFromPath(path));
    expect(items[0].status).toBe('never_viewed');
    expect(items[0].basename).toBe('catalog-only.md');
    expect(items[0].agent).toBe('cane');
    expect(items[0].availability).toBe('present');
  });

  it('W1-6: catalog-only artifact is EXCLUDED when includeNeverViewed is false', async () => {
    await registerArtifact(adapter, {
      basename: 'co.md', agent: 'cane', abs_path: '/abs/co.md',
      produced_at: '2026-06-08T09:00:00Z',
    }, '2026-06-08T09:00:00Z');
    const items = await listInboxItems(adapter, { includeNeverViewed: false }, 50, 0);
    expect(items).toHaveLength(0);
  });

  it('returns availability=missing when catalog says so', async () => {
    const path = '/abs/ghost.md';
    const id = artifactIdFromPath(path);
    await viewArtifact(adapter, id, { viewer: 'chris' });
    await registerArtifact(adapter, {
      basename: 'ghost.md', agent: 'cane', abs_path: path,
      produced_at: '2026-06-08T09:00:00-05:00',
      availability: 'missing',
    }, '2026-06-08T09:00:00Z');
    const items = await listInboxItems(adapter, {}, 50, 0);
    expect(items[0].availability).toBe('missing');
  });

  it('agent filter joins via catalog.agent', async () => {
    const p1 = '/abs/cane.md';
    const p2 = '/abs/regina.md';
    const id1 = artifactIdFromPath(p1);
    const id2 = artifactIdFromPath(p2);
    await viewArtifact(adapter, id1, { viewer: 'chris' });
    await viewArtifact(adapter, id2, { viewer: 'chris' });
    await registerArtifact(adapter, {
      basename: 'cane.md', agent: 'cane', abs_path: p1,
      produced_at: '2026-06-08T09:00:00Z',
    }, '2026-06-08T09:00:00Z');
    await registerArtifact(adapter, {
      basename: 'regina.md', agent: 'regina', abs_path: p2,
      produced_at: '2026-06-08T09:00:00Z',
    }, '2026-06-08T09:00:00Z');

    const items = await listInboxItems(adapter, { agent: 'cane' }, 50, 0);
    expect(items.map(i => i.basename)).toEqual(['cane.md']);
  });
});

describe('Kapelle B11 — backfillCatalogFromDeliveryLog', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await setup(); });

  it('parses pipe-separated rows and inserts catalog entries', async () => {
    const txt = [
      '# delivery-log header',
      '',
      '2026-06-08T09:00:00-05:00 | cane | - | foo.md | /abs/foo.md | "Foo summary"',
      '2026-06-08T10:00:00-05:00 | regina | today | bar.md | /abs/bar.md | "Bar summary"',
      '',
      'malformed line not enough fields',
    ].join('\n');
    const res = await backfillCatalogFromDeliveryLog(adapter, txt, '2026-06-08T11:00:00Z');
    expect(res.rows_parsed).toBe(2);
    expect(res.inserted).toBe(2);
    expect(res.updated).toBe(0);
    // Header + blanks + malformed
    expect(res.skipped).toBeGreaterThanOrEqual(3);

    const idFoo = artifactIdFromPath('/abs/foo.md');
    const fooRow = await getArtifact(adapter, idFoo);
    expect(fooRow).not.toBeNull();
    expect(fooRow!.title).toBe('Foo summary');
    expect(fooRow!.source).toBe('delivery-log');
  });

  it('is idempotent on re-run', async () => {
    const txt = '2026-06-08T09:00:00-05:00 | cane | - | foo.md | /abs/foo.md | "x"';
    const a = await backfillCatalogFromDeliveryLog(adapter, txt, '2026-06-08T11:00:00Z');
    expect(a.inserted).toBe(1);
    const b = await backfillCatalogFromDeliveryLog(adapter, txt, '2026-06-08T12:00:00Z');
    expect(b.inserted).toBe(0);
    expect(b.updated).toBe(1);
  });
});
