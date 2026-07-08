import { describe, it, expect } from 'vitest';
import {
  evaluateStuckQueries,
  evaluateAgentDown,
  evaluateBuildFailures,
  evaluatePromotionFailures,
  evaluateRepeatedNewsErrors,
  evaluateModelApiErrors,
  evaluateAllRules,
} from '../../src/supervisor/rules.js';
import { DEFAULT_CONFIG } from '../../src/supervisor/config.js';
import type { SourceSnapshot, ActiveDispatch, TerminalDispatch, AgentStatus } from '../../src/supervisor/types.js';
import type { SupervisorWatchConfig } from '../../src/supervisor/config.js';

import stuckQueryFixture from '../fixtures/supervisor/stuck-query.json';
import agentDownFixture from '../fixtures/supervisor/agent-down.json';
import buildFailureFixture from '../fixtures/supervisor/build-failure.json';
import promotionFailureFixture from '../fixtures/supervisor/promotion-failure.json';
import repeatedNewsFixture from '../fixtures/supervisor/repeated-news-errors.json';

function cfg(overrides: Partial<SupervisorWatchConfig> = {}): SupervisorWatchConfig {
  return { ...DEFAULT_CONFIG, enabled: true, ...overrides };
}

function emptySnapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    collected_at: new Date().toISOString(),
    active_dispatches: [],
    terminal_dispatches: [],
    watched_agents: [],
    recent_news: [],
    available_sources: [],
    missing_sources: [],
    ...overrides,
  };
}

describe('supervisor rules — stuck queries', () => {
  it('detects a stuck in_flight dispatch', () => {
    const snapshot = stuckQueryFixture.snapshot as SourceSnapshot;
    const now = Date.parse(stuckQueryFixture.now_iso);
    const findings = evaluateStuckQueries(snapshot, cfg(), now);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('stuck_query');
    expect(findings[0].dedupe_key).toBe('stuck_query:query_1780154100000_abc');
    expect(findings[0].agent_id).toBe('roger');
  });

  it('returns critical when age exceeds 2x threshold and no progress', () => {
    const snapshot = stuckQueryFixture.snapshot as SourceSnapshot;
    const now = Date.parse(stuckQueryFixture.now_iso);
    const findings = evaluateStuckQueries(snapshot, cfg({ stuckQuerySeconds: 900 }), now);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].confidence).toBe('high');
  });

  it('does not alert on dispatches under threshold', () => {
    const snapshot = stuckQueryFixture.snapshot as SourceSnapshot;
    const now = Date.parse(stuckQueryFixture.now_iso);
    // Set threshold very high
    const findings = evaluateStuckQueries(snapshot, cfg({ stuckQuerySeconds: 99999 }), now);
    expect(findings).toHaveLength(0);
  });

  it('suppresses done/cancelled/needs_clarification dispatches', () => {
    const snapshot = emptySnapshot({
      active_dispatches: [
        {
          dispatch_phid: 'phid:done-1',
          query_id: 'q1',
          to_agent: 'roger',
          status: 'done',
          started_at: '2026-05-28T10:00:00.000Z',
          updated_at: '2026-05-28T10:00:00.000Z',
          subject: 'test',
          promote: false,
          promotion_input: null,
        },
        {
          dispatch_phid: 'phid:nc-1',
          query_id: 'q2',
          to_agent: 'roger',
          status: 'needs_clarification',
          started_at: '2026-05-28T10:00:00.000Z',
          updated_at: '2026-05-28T10:00:00.000Z',
          subject: 'test',
          promote: false,
          promotion_input: null,
        },
      ],
    });
    const now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const findings = evaluateStuckQueries(snapshot, cfg(), now);
    expect(findings).toHaveLength(0);
  });

  it('downgrades to warning when recent news exists', () => {
    const d: ActiveDispatch = {
      dispatch_phid: 'phid:stuck-with-news',
      query_id: 'q-news',
      to_agent: 'roger',
      status: 'in_flight',
      started_at: '2026-05-28T11:00:00.000Z',
      updated_at: '2026-05-28T11:00:00.000Z',
      subject: 'test',
      promote: false,
      promotion_input: null,
    };
    const snapshot = emptySnapshot({
      active_dispatches: [d],
      recent_news: [{
        id: 'n1',
        agent_id: 'roger',
        ts: '2026-05-28T11:58:00.000Z',
        message: 'Still working on it...',
      }],
    });
    const now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const findings = evaluateStuckQueries(snapshot, cfg({ stuckQuerySeconds: 1800 }), now);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].confidence).toBe('medium');
  });

  it('respects agent overrides for stuck threshold', () => {
    const snapshot = stuckQueryFixture.snapshot as SourceSnapshot;
    const now = Date.parse(stuckQueryFixture.now_iso);
    const config = cfg({
      stuckQuerySeconds: 100,
      agentOverrides: [{ agent_id: 'roger', stuckQuerySeconds: 99999 }],
    });
    const findings = evaluateStuckQueries(snapshot, config, now);
    expect(findings).toHaveLength(0);
  });

  it('ignores unwatched agents', () => {
    const snapshot = stuckQueryFixture.snapshot as SourceSnapshot;
    const now = Date.parse(stuckQueryFixture.now_iso);
    const config = cfg({ watchedAgents: ['cto'] });
    const findings = evaluateStuckQueries(snapshot, config, now);
    expect(findings).toHaveLength(0);
  });
});

describe('supervisor rules — agent down', () => {
  it('detects agent with stale heartbeat and active dispatches', () => {
    const snapshot = agentDownFixture.snapshot as SourceSnapshot;
    const now = Date.parse(agentDownFixture.now_iso);
    const findings = evaluateAgentDown(snapshot, cfg({ agentDownSeconds: 300 }), now);

    expect(findings).toHaveLength(2);
    // roger has stale heartbeat (600s) and active work
    const roger = findings.find(f => f.agent_id === 'roger');
    expect(roger).toBeDefined();
    expect(roger!.severity).toBe('critical');
    expect(roger!.kind).toBe('agent_down');

    // cto has no heartbeat at all but has active work
    const cto = findings.find(f => f.agent_id === 'cto');
    expect(cto).toBeDefined();
    expect(cto!.severity).toBe('critical');
  });

  it('does not alert on idle agent with no heartbeat data', () => {
    const snapshot = emptySnapshot({
      watched_agents: [{
        agent_id: 'idle-agent',
        last_seen_at: null,
        active_dispatches: 0,
        status_state: 'unknown',
      }],
    });
    const now = Date.now();
    const findings = evaluateAgentDown(snapshot, cfg(), now);
    expect(findings).toHaveLength(0);
  });

  it('uses warning severity for down agent without active work', () => {
    const snapshot = emptySnapshot({
      watched_agents: [{
        agent_id: 'idle-down',
        last_seen_at: '2026-05-28T11:00:00.000Z',
        active_dispatches: 0,
        status_state: 'online',
      }],
    });
    const now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const findings = evaluateAgentDown(snapshot, cfg({ agentDownSeconds: 300 }), now);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });
});

describe('supervisor rules — build failures', () => {
  it('detects failed build dispatch, ignores non-build failure', () => {
    const snapshot = buildFailureFixture.snapshot as SourceSnapshot;
    const findings = evaluateBuildFailures(snapshot, cfg());

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('build_failure');
    expect(findings[0].dispatch_id).toBe('phid:disp-fail-001');
    expect(findings[0].severity).toBe('warning');
  });

  it('detects build failure by subject keyword', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [{
        dispatch_phid: 'phid:disp-keyword',
        query_id: 'q-kw',
        to_agent: 'roger',
        status: 'failed',
        completed_at: '2026-05-28T12:00:00.000Z',
        subject: 'Deploy the new API endpoint',
        failure_kind: 'agent_error',
        failure_detail: 'crash',
        promote: false,
        promotion_result: null,
        promotion_input: null,
      }],
    });
    const findings = evaluateBuildFailures(snapshot, cfg());
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('build_failure');
  });
});

describe('supervisor rules — promotion failures', () => {
  it('detects missing promotion payload and sha mismatch', () => {
    const snapshot = promotionFailureFixture.snapshot as SourceSnapshot;
    const findings = evaluatePromotionFailures(snapshot, cfg());

    expect(findings).toHaveLength(2);

    const missing = findings.find(f => f.dispatch_id === 'phid:disp-promo-001');
    expect(missing).toBeDefined();
    expect(missing!.kind).toBe('promotion_failure');
    expect(missing!.severity).toBe('critical');

    const mismatch = findings.find(f => f.dispatch_id === 'phid:disp-promo-002');
    expect(mismatch).toBeDefined();
    expect(mismatch!.kind).toBe('promotion_failure');
  });

  it('does not alert on non-build dispatch (promote=false)', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [{
        dispatch_phid: 'phid:no-promo',
        query_id: 'q-np',
        to_agent: 'cto',
        status: 'done',
        completed_at: '2026-05-28T12:00:00.000Z',
        subject: 'Research task',
        failure_kind: null,
        failure_detail: null,
        promote: false,
        promotion_result: null,
        promotion_input: null,
      }],
    });
    const findings = evaluatePromotionFailures(snapshot, cfg());
    expect(findings).toHaveLength(0);
  });

  it('passes when promotion block is complete and verified', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [{
        dispatch_phid: 'phid:good-promo',
        query_id: 'q-gp',
        to_agent: 'roger',
        status: 'done',
        completed_at: '2026-05-28T12:00:00.000Z',
        subject: 'Build feature',
        failure_kind: null,
        failure_detail: null,
        promote: true,
        promotion_result: {
          required: true,
          completed: true,
          repos: [{
            path: '/repo',
            base: 'main',
            source_branch: 'feat',
            strategy: 'fast_forward',
            promoted_sha: 'abc123',
            remote_main_sha: 'abc123',
            pushed: true,
            verified: true,
          }],
        },
        promotion_input: null,
      }],
    });
    const findings = evaluatePromotionFailures(snapshot, cfg());
    expect(findings).toHaveLength(0);
  });

  it('routes hygiene-classified promotion failures to Worktree Hygiene instead of promotion_failure', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [{
        dispatch_phid: 'phid:disp-hygiene',
        query_id: 'q-hygiene',
        to_agent: 'roger',
        status: 'done',
        completed_at: '2026-05-28T12:00:00.000Z',
        subject: 'Build thing',
        failure_kind: null,
        failure_detail: null,
        promote: true,
        promotion_input: { repo: '/repo/app', branch: 'feature/diverged', base: 'main', remote: 'origin' },
        promotion_result: {
          required: true,
          completed: false,
          failure_detail: 'branch feature/diverged has diverged from main (ahead=1, behind=2)',
        },
      }],
    });

    const findings = evaluatePromotionFailures(snapshot, cfg());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'worktree_hygiene',
      dedupe_key: 'worktree_hygiene:/repo/app:feature/diverged:ahead_behind_divergence',
    });
  });
});

describe('supervisor rules — repeated news errors', () => {
  it('detects repeated error entries for an agent', () => {
    const snapshot = repeatedNewsFixture.snapshot as SourceSnapshot;
    const now = Date.parse(repeatedNewsFixture.now_iso);
    const findings = evaluateRepeatedNewsErrors(snapshot, cfg(), now);

    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('news_repeated_error');
    expect(findings[0].agent_id).toBe('roger');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].confidence).toBe('medium');
  });

  it('does not alert below repeat count threshold', () => {
    const snapshot = repeatedNewsFixture.snapshot as SourceSnapshot;
    const now = Date.parse(repeatedNewsFixture.now_iso);
    const findings = evaluateRepeatedNewsErrors(snapshot, cfg({ newsErrorRepeatCount: 5 }), now);
    expect(findings).toHaveLength(0);
  });

  it('ignores non-error news', () => {
    const snapshot = emptySnapshot({
      recent_news: [
        { id: 'n1', agent_id: 'roger', ts: '2026-05-28T11:50:00.000Z', message: 'Working on task...' },
        { id: 'n2', agent_id: 'roger', ts: '2026-05-28T11:51:00.000Z', message: 'Still making progress' },
        { id: 'n3', agent_id: 'roger', ts: '2026-05-28T11:52:00.000Z', message: 'Almost done' },
      ],
    });
    const now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const findings = evaluateRepeatedNewsErrors(snapshot, cfg(), now);
    expect(findings).toHaveLength(0);
  });
});

describe('supervisor rules — model/API errors (Spec 2026-05-29)', () => {
  function modelApiTerminal(overrides: Partial<TerminalDispatch> = {}): TerminalDispatch {
    return {
      dispatch_phid: 'phid:disp-mapi-1',
      query_id: 'q-mapi-1',
      to_agent: 'roger',
      status: 'failed',
      completed_at: '2026-05-29T12:00:00.000Z',
      subject: 'spec audit',
      failure_kind: 'model_api_error_exhausted',
      failure_detail: 'thinking_block_400 exhausted after 3 attempts',
      promote: false,
      promotion_result: null,
      promotion_input: null,
      ...overrides,
    };
  }

  it('emits model_api_error for model_api_error_exhausted failure', () => {
    const snapshot = emptySnapshot({ terminal_dispatches: [modelApiTerminal()] });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('model_api_error');
    expect(findings[0].dedupe_key).toBe('model_api_error:phid:disp-mapi-1');
    expect(findings[0].severity).toBe('warning'); // non-build dispatch
    expect(findings[0].confidence).toBe('high');
    expect(findings[0].agent_id).toBe('roger');
    expect(findings[0].query_id).toBe('q-mapi-1');
  });

  it('elevates severity to critical for build dispatch (promote=true)', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [
        modelApiTerminal({
          promote: true,
          promotion_input: { repo: '/r', branch: 'feat', base: 'main', remote: 'origin' },
        }),
      ],
    });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('also matches harness_empty_result_exhausted and harness_process_error_exhausted', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [
        modelApiTerminal({ dispatch_phid: 'phid:e', failure_kind: 'harness_empty_result_exhausted' }),
        modelApiTerminal({ dispatch_phid: 'phid:p', failure_kind: 'harness_process_error_exhausted' }),
      ],
    });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.dispatch_id).sort()).toEqual(['phid:e', 'phid:p']);
  });

  it('ignores semantic agent_error failures (those belong to build_failure)', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [modelApiTerminal({ failure_kind: 'agent_error' })],
    });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings).toHaveLength(0);
  });

  it('ignores non-failed dispatches', () => {
    const snapshot = emptySnapshot({
      terminal_dispatches: [modelApiTerminal({ status: 'done' })],
    });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings).toHaveLength(0);
  });

  it('build_failure does NOT fire alongside model_api_error for the same dispatch', () => {
    // A build dispatch that failed with model_api_error_exhausted: build_failure
    // should be suppressed so we get one alert (model_api_error), not two.
    const snapshot = emptySnapshot({
      terminal_dispatches: [
        modelApiTerminal({
          subject: 'Build the API endpoint',
          promote: true,
          promotion_input: { repo: '/r', branch: 'feat', base: 'main', remote: 'origin' },
        }),
      ],
    });
    const buildFindings = evaluateBuildFailures(snapshot, cfg());
    const modelFindings = evaluateModelApiErrors(snapshot, cfg());
    expect(buildFindings).toHaveLength(0); // suppressed
    expect(modelFindings).toHaveLength(1);
  });

  it('evidence detail includes failure_kind and failure_detail', () => {
    const snapshot = emptySnapshot({ terminal_dispatches: [modelApiTerminal()] });
    const findings = evaluateModelApiErrors(snapshot, cfg());
    expect(findings[0].evidence[0].source).toBe('dispatch');
    expect(findings[0].evidence[0].detail).toContain('model_api_error_exhausted');
    expect(findings[0].evidence[0].detail).toContain('thinking_block_400 exhausted');
  });
});

describe('supervisor rules — evaluateAllRules', () => {
  it('runs all rules and returns combined findings', () => {
    const snapshot: SourceSnapshot = {
      collected_at: '2026-05-28T12:00:00.000Z',
      active_dispatches: stuckQueryFixture.snapshot.active_dispatches as ActiveDispatch[],
      terminal_dispatches: buildFailureFixture.snapshot.terminal_dispatches as TerminalDispatch[],
      watched_agents: agentDownFixture.snapshot.watched_agents as AgentStatus[],
      recent_news: repeatedNewsFixture.snapshot.recent_news,
      available_sources: ['all'],
      missing_sources: [],
    };

    const now = Date.parse(stuckQueryFixture.now_iso);
    const findings = evaluateAllRules(snapshot, cfg({ agentDownSeconds: 300 }), now);

    const kinds = new Set(findings.map(f => f.kind));
    expect(kinds.has('stuck_query')).toBe(true);
    expect(kinds.has('agent_down')).toBe(true);
    expect(kinds.has('build_failure')).toBe(true);
    expect(kinds.has('news_repeated_error')).toBe(true);
  });
});
