import { describe, it, expect } from 'vitest';
import {
  projectCompletions,
  projectPromotionOutcomes,
  buildSourceCoverage,
  type NewsEvent,
} from '../../src/monitor/completions-projection.js';

function makeEvent(overrides: Partial<NewsEvent>): NewsEvent {
  return {
    id: 1,
    agent_id: 'roger',
    timestamp: Date.now(),
    type: 'query.received',
    message: null,
    data: null,
    query_id: 'q1',
    owner_id: 'roger',
    ...overrides,
  };
}

describe('completions projection — correlates received + completed', () => {
  it('matches query.received + query.completed by agent + query_id', () => {
    const events: NewsEvent[] = [
      makeEvent({
        id: 1,
        type: 'query.received',
        timestamp: 1000,
        query_id: 'q1',
        owner_id: 'roger',
        data: { from: 'manager' },
      }),
      makeEvent({
        id: 2,
        type: 'query.completed',
        timestamp: 6000,
        query_id: 'q1',
        owner_id: 'roger',
      }),
    ];

    const result = projectCompletions(events, 10000);
    expect(result.in_flight).toHaveLength(0);
    expect(result.recent_completions).toHaveLength(1);
    expect(result.recent_completions[0].duration_ms).toBe(5000);
    expect(result.recent_completions[0].from).toBe('manager');
    expect(result.recent_completions[0].received_ts).toBe(1000);
    expect(result.recent_completions[0].completed_ts).toBe(6000);
  });

  it('computes in-flight elapsed from generated_at - received_ts', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.received',
        timestamp: 5000,
        query_id: 'q-inflight',
        owner_id: 'roger',
        data: { from: 'cto' },
      }),
    ];

    const generatedAt = 15000;
    const result = projectCompletions(events, generatedAt);
    expect(result.in_flight).toHaveLength(1);
    expect(result.in_flight[0].elapsed_ms).toBe(10000);
    expect(result.in_flight[0].from).toBe('cto');
    expect(result.in_flight[0].event_type).toBe('query.received');
  });

  it('uses schedule.received as start event with from=schedule', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'schedule.received',
        timestamp: 2000,
        query_id: 'q-sched',
        owner_id: 'roger',
        data: { schedule_id: 'test' },
      }),
      makeEvent({
        type: 'query.completed',
        timestamp: 8000,
        query_id: 'q-sched',
        owner_id: 'roger',
      }),
    ];

    const result = projectCompletions(events, 10000);
    expect(result.recent_completions).toHaveLength(1);
    expect(result.recent_completions[0].from).toBe('schedule');
    expect(result.recent_completions[0].duration_ms).toBe(6000);
  });

  it('does not compute duration when received event is missing', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.completed',
        timestamp: 8000,
        query_id: 'q-orphan',
        owner_id: 'roger',
      }),
    ];

    const result = projectCompletions(events, 10000);
    expect(result.recent_completions).toHaveLength(0);
    // Should flag in source coverage
    const cov = result.source_coverage.get('roger');
    expect(cov).toBeDefined();
    expect(cov!.error).toContain('missing received');
  });

  it('rejects negative durations', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.received',
        timestamp: 9000,
        query_id: 'q-neg',
        owner_id: 'roger',
      }),
      makeEvent({
        type: 'query.completed',
        timestamp: 5000, // before received
        query_id: 'q-neg',
        owner_id: 'roger',
      }),
    ];

    const result = projectCompletions(events, 10000);
    expect(result.recent_completions).toHaveLength(0);
    const cov = result.source_coverage.get('roger');
    expect(cov!.error).toContain('negative duration');
  });
});

describe('completions projection — 18s artifact prevention', () => {
  it('uses event timestamps not observation time for duration', () => {
    // The critical test: observation starts 18 seconds before completion,
    // but received was about 8 minutes earlier.
    const receivedTs = 1000000;           // query.received at T
    const completedTs = receivedTs + 480_000; // completed 8 minutes later
    const observationStart = completedTs - 18_000; // observer started 18s before completion

    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.received',
        timestamp: receivedTs,
        query_id: 'q-18s',
        owner_id: 'roger',
        data: { from: 'manager' },
      }),
      makeEvent({
        type: 'query.completed',
        timestamp: completedTs,
        query_id: 'q-18s',
        owner_id: 'roger',
      }),
    ];

    // generatedAt is irrelevant for completed queries — duration comes from events.
    const result = projectCompletions(events, observationStart + 18_000);
    expect(result.recent_completions).toHaveLength(1);

    // Duration MUST be ~8 minutes, NOT 18 seconds.
    expect(result.recent_completions[0].duration_ms).toBe(480_000);
    expect(result.recent_completions[0].duration_ms).not.toBe(18_000);

    // Verify it comes from event timestamps.
    expect(result.recent_completions[0].received_ts).toBe(receivedTs);
    expect(result.recent_completions[0].completed_ts).toBe(completedTs);
  });
});

describe('completions projection — sorting', () => {
  it('sorts in-flight by largest elapsed first', () => {
    const events: NewsEvent[] = [
      makeEvent({ type: 'query.received', timestamp: 3000, query_id: 'q-short', owner_id: 'a' }),
      makeEvent({ type: 'query.received', timestamp: 1000, query_id: 'q-long', owner_id: 'b' }),
      makeEvent({ type: 'query.received', timestamp: 2000, query_id: 'q-mid', owner_id: 'c' }),
    ];

    const result = projectCompletions(events, 5000);
    expect(result.in_flight).toHaveLength(3);
    expect(result.in_flight[0].query_id).toBe('q-long');
    expect(result.in_flight[1].query_id).toBe('q-mid');
    expect(result.in_flight[2].query_id).toBe('q-short');
  });

  it('sorts completions by completed_ts descending', () => {
    const events: NewsEvent[] = [
      makeEvent({ type: 'query.received', timestamp: 1000, query_id: 'q1', owner_id: 'a' }),
      makeEvent({ type: 'query.completed', timestamp: 3000, query_id: 'q1', owner_id: 'a' }),
      makeEvent({ type: 'query.received', timestamp: 2000, query_id: 'q2', owner_id: 'b' }),
      makeEvent({ type: 'query.completed', timestamp: 5000, query_id: 'q2', owner_id: 'b' }),
    ];

    const result = projectCompletions(events, 6000);
    expect(result.recent_completions).toHaveLength(2);
    expect(result.recent_completions[0].query_id).toBe('q2'); // completed later
    expect(result.recent_completions[1].query_id).toBe('q1');
  });
});

describe('completions projection — multiple received events', () => {
  it('uses earliest received event for duration', () => {
    const events: NewsEvent[] = [
      makeEvent({ type: 'query.received', timestamp: 1000, query_id: 'q1', owner_id: 'roger' }),
      makeEvent({ type: 'query.received', timestamp: 2000, query_id: 'q1', owner_id: 'roger' }),
      makeEvent({ type: 'query.completed', timestamp: 5000, query_id: 'q1', owner_id: 'roger' }),
    ];

    const result = projectCompletions(events, 6000);
    expect(result.recent_completions[0].duration_ms).toBe(4000);
    expect(result.recent_completions[0].received_ts).toBe(1000);
  });
});

describe('completions projection — promotion outcomes', () => {
  it('extracts promotion from query.completed data', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.completed',
        timestamp: 5000,
        query_id: 'q-promo',
        owner_id: 'roger',
        data: {
          promotion: {
            required: true,
            completed: true,
            repos: [{
              source_branch: 'feat-x',
              promoted_sha: 'abc123',
              pushed: true,
              verified: true,
              base: 'main',
              remote_main_sha: 'abc123',
            }],
          },
        },
      }),
    ];

    const outcomes = projectPromotionOutcomes(events);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].branch).toBe('feat-x');
    expect(outcomes[0].commit).toBe('abc123');
    expect(outcomes[0].promoted_to_main).toBe(true);
    expect(outcomes[0].pushed).toBe(true);
    expect(outcomes[0].verified).toBe(true);
    expect(outcomes[0].source).toBe('agent-done-promotion');
  });

  it('marks verified=false when sha mismatch', () => {
    const events: NewsEvent[] = [
      makeEvent({
        type: 'query.completed',
        query_id: 'q-mismatch',
        owner_id: 'roger',
        data: {
          promotion: {
            completed: true,
            repos: [{
              source_branch: 'feat-y',
              promoted_sha: 'abc',
              remote_main_sha: 'def',
              pushed: true,
              verified: true,
            }],
          },
        },
      }),
    ];

    const outcomes = projectPromotionOutcomes(events);
    expect(outcomes).toHaveLength(1);
    // verified is passed through as true even though shas don't match —
    // the field reflects repo.verified, the sha comparison is separate
    expect(outcomes[0].verified).toBe(false);
  });

  it('ignores events without promotion block', () => {
    const events: NewsEvent[] = [
      makeEvent({ type: 'query.completed', query_id: 'q-no-promo', data: { result: 'done' } }),
    ];
    expect(projectPromotionOutcomes(events)).toHaveLength(0);
  });
});

describe('source coverage', () => {
  it('builds coverage from agent map', () => {
    const coverageMap = new Map([
      ['roger', { newest_ts: 5000, error: null }],
      ['cto', { newest_ts: null, error: 'missing received for q1' }],
    ]);

    const rows = buildSourceCoverage(coverageMap);
    expect(rows).toHaveLength(2);

    const roger = rows.find(r => r.agent === 'roger')!;
    expect(roger.news_seen).toBe(true);
    expect(roger.newest_news_ts).toBe(5000);
    expect(roger.error).toBeNull();

    const cto = rows.find(r => r.agent === 'cto')!;
    expect(cto.news_seen).toBe(false);
    expect(cto.error).toContain('missing received');
  });
});
