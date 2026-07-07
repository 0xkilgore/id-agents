// T-RELIABILITY (2026-06-30) — recovered artifact-comment sweep is deterministic
// and NONE of it reaches the needs_you digest.
//
// Two guarantees:
//   1. classify + route are deterministic (same batch -> identical report).
//   2. every routed comment dispatch is stamped ARTIFACT_COMMENT_DISPATCH_CHANNEL,
//      and the needs_you digest hard-excludes that channel — so a recovered
//      batch can't leak into "Chris needs-you".

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateOutputsTables, registerArtifact } from '../../src/outputs/storage.js';
import {
  classifyArtifactComment, routeCommentToOwningAgent, sweepRecoveredArtifactComments,
  ARTIFACT_COMMENT_DISPATCH_CHANNEL, type CommentDispatchEnqueueFn,
} from '../../src/outputs/comment-dispatch.js';
import { isArtifactCommentDispatch } from '../../src/desk/needs-me.js';
import type { ArtifactComment } from '../../src/outputs/types.js';
import type { DispatchReadRow } from '../../src/dispatch-scheduler/read-model.js';

const ART = 'art-sweep-1';

function comment(op_id: number, body: string, extra: Partial<ArtifactComment> = {}): ArtifactComment {
  return {
    op_id, artifact_id: ART, actor: 'human:chris', body,
    anchor: null, ts: '2026-06-30T00:00:00.000Z', reaction: null, ...extra,
  };
}

function makeEnqueue() {
  const calls: Array<{ to_agent: string; channel?: string }> = [];
  const fn: CommentDispatchEnqueueFn = async (input) => {
    calls.push({ to_agent: input.to_agent, channel: input.channel });
    return { query_id: `q-${calls.length}`, dispatch_phid: `phid:disp-${calls.length}`, status: 'queued' };
  };
  return { fn, calls };
}

async function makeAdapter(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter(':memory:');
  await migrateOutputsTables(adapter);
  await registerArtifact(adapter, {
    artifact_id: ART, basename: 'sweep.md', agent: 'regina',
    abs_path: '/tmp/sweep.md', title: 'Sweep artifact',
    produced_at: '2026-06-30T00:00:00.000Z', source: 'manual', availability: 'present',
  }, '2026-06-30T00:00:00.000Z');
  return adapter;
}

// A recovered batch covering all three route kinds (text + reaction forms).
function recoveredBatch(): ArtifactComment[] {
  return [
    comment(1, 'Ship it'),                              // approval_signal
    comment(2, 'LGTM'),                                 // approval_signal
    comment(3, 'Please fix the header spacing'),        // substantive_follow_up
    comment(4, 'Why did the total change here?'),       // question
    comment(5, 'thumbs down', { reaction: 'wrong' }),   // substantive_follow_up (reaction)
    comment(6, 'explain please', { reaction: 'explain' }), // question (reaction)
    comment(7, 'ship_it', { reaction: 'ship_it' }),     // approval_signal (reaction)
    comment(8, 'acknowledged', { reaction: 'acknowledged' }), // acknowledgement (reaction)
  ];
}

describe('artifact-comment classification — deterministic', () => {
  it('classifies approval / substantive / question and is stable across runs', () => {
    const cases: Array<[ArtifactComment, string]> = [
      [comment(1, 'Ship it'), 'approval_signal'],
      [comment(2, 'approved'), 'approval_signal'],
      [comment(3, 'Please fix the header'), 'substantive_follow_up'],
      [comment(4, 'why is this here?'), 'question'],
      [comment(5, 'x', { reaction: 'ship_it' }), 'approval_signal'],
      [comment(6, 'x', { reaction: 'wrong' }), 'substantive_follow_up'],
      [comment(7, 'x', { reaction: 'iterate' }), 'substantive_follow_up'],
      [comment(8, 'x', { reaction: 'explain' }), 'question'],
      [comment(9, 'x', { reaction: 'acknowledged' }), 'acknowledgement'],
    ];
    for (const [c, kind] of cases) {
      expect(classifyArtifactComment(c)).toBe(kind);
      expect(classifyArtifactComment(c)).toBe(classifyArtifactComment(c)); // stable
    }
  });
});

describe('recovered-comment batch sweep — deterministic + channel-stamped', () => {
  let adapter: SqliteAdapter;
  beforeEach(async () => { adapter = await makeAdapter(); });

  it('produces identical reports for the same batch (deterministic)', async () => {
    const e1 = makeEnqueue();
    const r1 = await sweepRecoveredArtifactComments({ adapter, enqueue: e1.fn, comments: recoveredBatch().map((c) => ({ artifactId: ART, comment: c })) });
    const e2 = makeEnqueue();
    const r2 = await sweepRecoveredArtifactComments({ adapter, enqueue: e2.fn, comments: recoveredBatch().map((c) => ({ artifactId: ART, comment: c })) });

    expect(r1.counts).toEqual({ acknowledgement: 1, approval_signal: 3, substantive_follow_up: 2, question: 2 });
    expect(r2.counts).toEqual(r1.counts);
    expect(r2.entries.map((x) => x.route_kind)).toEqual(r1.entries.map((x) => x.route_kind));
    expect(r1.total).toBe(8);
  });

  it('routes ONLY substantive comments, and stamps the artifact_comment channel', async () => {
    const { fn, calls } = makeEnqueue();
    const report = await sweepRecoveredArtifactComments({ adapter, enqueue: fn, comments: recoveredBatch().map((c) => ({ artifactId: ART, comment: c })) });

    // 2 substantive -> 2 dispatches; approvals + questions never dispatch.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.channel === ARTIFACT_COMMENT_DISPATCH_CHANNEL)).toBe(true);

    const routed = report.entries.filter((x) => x.result.routed);
    expect(routed).toHaveLength(2);
    expect(report.entries.filter((x) => x.route_kind === 'approval_signal').every((x) => !x.result.routed)).toBe(true);
    expect(report.entries.filter((x) => x.route_kind === 'question').every((x) => !x.result.routed)).toBe(true);
  });

  it('single-comment routing also stamps the channel', async () => {
    const { fn, calls } = makeEnqueue();
    const res = await routeCommentToOwningAgent({ adapter, enqueue: fn, artifactId: ART, comment: comment(9, 'Please revise the intro') });
    expect(res.routed).toBe(true);
    expect(calls[0].channel).toBe(ARTIFACT_COMMENT_DISPATCH_CHANNEL);
  });
});

describe('needs_you digest exclusion — hardened', () => {
  function row(channel: string | null, needs_operator = true): DispatchReadRow {
    return {
      dispatch_phid: `phid:disp-${channel}`,
      needs_operator,
      needs_input: { clarification_id: null, active: null, history: [], resume_delivery_status: null },
      source_metadata: { channel, from_actor: 'human:chris', priority: 5 },
    } as unknown as DispatchReadRow;
  }

  it('isArtifactCommentDispatch identifies only the artifact_comment channel', () => {
    expect(isArtifactCommentDispatch(row(ARTIFACT_COMMENT_DISPATCH_CHANNEL))).toBe(true);
    expect(isArtifactCommentDispatch(row('email'))).toBe(false);
    expect(isArtifactCommentDispatch(row('inbox'))).toBe(false);
    expect(isArtifactCommentDispatch(row(null))).toBe(false);
  });

  it('the needs_you routed filter drops artifact-comment dispatches, keeps real ones', () => {
    // Same predicate the digest applies: needs-attention AND not an artifact comment.
    const rows = [
      row(ARTIFACT_COMMENT_DISPATCH_CHANNEL), // recovered comment -> must be excluded
      row(ARTIFACT_COMMENT_DISPATCH_CHANNEL),
      row('inbox'),                            // a real routed item -> kept
    ];
    const surfaced = rows.filter(
      (r) => (r.needs_operator || r.needs_input.active != null) && !isArtifactCommentDispatch(r),
    );
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].source_metadata.channel).toBe('inbox');
  });
});
