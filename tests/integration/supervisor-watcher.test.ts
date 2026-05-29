import { describe, it, expect, beforeEach } from 'vitest';
import { SupervisorWatcher, type SupervisorSourceReader } from '../../src/supervisor/watcher.js';
import { AlertStateManager } from '../../src/supervisor/alerts.js';
import type { SupervisorWatchConfig } from '../../src/supervisor/config.js';
import { DEFAULT_CONFIG } from '../../src/supervisor/config.js';
import type {
  ActiveDispatch,
  TerminalDispatch,
  AgentStatus,
  NewsEntry,
  SupervisorAlertRecord,
} from '../../src/supervisor/types.js';

class FakeSourceReader implements SupervisorSourceReader {
  activeDispatches: ActiveDispatch[] = [];
  terminalDispatches: TerminalDispatch[] = [];
  watchedAgents: AgentStatus[] = [];
  recentNews: NewsEntry[] = [];

  async readActiveDispatches() { return this.activeDispatches; }
  async readTerminalDispatches() { return this.terminalDispatches; }
  async readWatchedAgents() { return this.watchedAgents; }
  async readRecentNews() { return this.recentNews; }
}

class RecordingSink {
  records: SupervisorAlertRecord[] = [];

  emit(record: SupervisorAlertRecord): void {
    this.records.push(record);
  }
}

function cfg(overrides: Partial<SupervisorWatchConfig> = {}): SupervisorWatchConfig {
  return {
    ...DEFAULT_CONFIG,
    enabled: true,
    alertFilePath: '/tmp/supervisor-test-alerts.jsonl',
    ...overrides,
  };
}

describe('SupervisorWatcher — integration', () => {
  let reader: FakeSourceReader;
  let sink: RecordingSink;

  beforeEach(() => {
    reader = new FakeSourceReader();
    sink = new RecordingSink();
  });

  it('emits stuck_query alert on first tick', async () => {
    reader.activeDispatches = [{
      dispatch_phid: 'phid:test-stuck',
      query_id: 'q-test',
      to_agent: 'roger',
      status: 'in_flight',
      started_at: '2026-05-28T11:00:00.000Z',
      updated_at: '2026-05-28T11:00:00.000Z',
      subject: 'Test dispatch',
      promote: false,
      promotion_input: null,
    }];

    const now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const watcher = new SupervisorWatcher({
      config: cfg({ stuckQuerySeconds: 1800 }),
      sourceReader: reader,
      sink,
      now: () => now,
    });

    await watcher.tick();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].kind).toBe('stuck_query');
    expect(sink.records[0].status).toBe('open');
  });

  it('resolves alert when condition clears after 2 ticks', async () => {
    reader.activeDispatches = [{
      dispatch_phid: 'phid:test-resolve',
      query_id: 'q-resolve',
      to_agent: 'roger',
      status: 'in_flight',
      started_at: '2026-05-28T11:00:00.000Z',
      updated_at: '2026-05-28T11:00:00.000Z',
      subject: 'Test',
      promote: false,
      promotion_input: null,
    }];

    let now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const watcher = new SupervisorWatcher({
      config: cfg({ stuckQuerySeconds: 1800 }),
      sourceReader: reader,
      sink,
      now: () => now,
    });

    // First tick — alert opens
    await watcher.tick();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0].status).toBe('open');

    // Clear the condition
    reader.activeDispatches = [];
    now += 30_000;

    // Second tick — no resolution yet
    await watcher.tick();
    expect(sink.records).toHaveLength(1);

    // Third tick — resolves
    now += 30_000;
    await watcher.tick();
    expect(sink.records).toHaveLength(2);
    expect(sink.records[1].status).toBe('resolved');
  });

  it('does not emit duplicate alerts on repeated ticks', async () => {
    reader.activeDispatches = [{
      dispatch_phid: 'phid:test-dedup',
      query_id: 'q-dedup',
      to_agent: 'roger',
      status: 'in_flight',
      started_at: '2026-05-28T11:00:00.000Z',
      updated_at: '2026-05-28T11:00:00.000Z',
      subject: 'Test',
      promote: false,
      promotion_input: null,
    }];

    let now = new Date('2026-05-28T12:00:00.000Z').getTime();
    const watcher = new SupervisorWatcher({
      config: cfg({ stuckQuerySeconds: 1800 }),
      sourceReader: reader,
      sink,
      now: () => now,
    });

    await watcher.tick();
    now += 30_000;
    await watcher.tick();
    now += 30_000;
    await watcher.tick();

    // Only 1 open + potentially 1 update if counters change
    const openRecords = sink.records.filter(r => r.status === 'open');
    expect(openRecords).toHaveLength(1);
  });

  it('detects all 5 alert kinds in one tick', async () => {
    const baseTime = new Date('2026-05-28T12:00:00.000Z').getTime();

    reader.activeDispatches = [{
      dispatch_phid: 'phid:stuck',
      query_id: 'q-stuck',
      to_agent: 'roger',
      status: 'in_flight',
      started_at: '2026-05-28T11:00:00.000Z',
      updated_at: '2026-05-28T11:00:00.000Z',
      subject: 'Build something',
      promote: false,
      promotion_input: null,
    }];

    reader.terminalDispatches = [
      {
        dispatch_phid: 'phid:failed-build',
        query_id: 'q-fb',
        to_agent: 'roger',
        status: 'failed',
        completed_at: '2026-05-28T11:45:00.000Z',
        subject: 'Build feature X',
        failure_kind: 'agent_error',
        failure_detail: 'tsc failed',
        promote: true,
        promotion_result: null,
        promotion_input: null,
      },
      {
        dispatch_phid: 'phid:missing-promo',
        query_id: 'q-mp',
        to_agent: 'roger',
        status: 'done',
        completed_at: '2026-05-28T11:50:00.000Z',
        subject: 'Deploy',
        failure_kind: null,
        failure_detail: null,
        promote: true,
        promotion_result: null,
        promotion_input: null,
      },
    ];

    reader.watchedAgents = [{
      agent_id: 'cto',
      last_seen_at: '2026-05-28T11:50:00.000Z',
      active_dispatches: 1,
      status_state: 'online',
    }];

    reader.recentNews = [
      { id: 'n1', agent_id: 'roger', ts: '2026-05-28T11:50:00.000Z', message: 'Error: timeout connecting' },
      { id: 'n2', agent_id: 'roger', ts: '2026-05-28T11:52:00.000Z', message: 'Error: timeout connecting' },
      { id: 'n3', agent_id: 'roger', ts: '2026-05-28T11:54:00.000Z', message: 'Error: timeout connecting' },
    ];

    const watcher = new SupervisorWatcher({
      config: cfg({
        stuckQuerySeconds: 1800,
        agentDownSeconds: 300,
      }),
      sourceReader: reader,
      sink,
      now: () => baseTime,
    });

    await watcher.tick();

    const kinds = new Set(sink.records.map(r => r.kind));
    expect(kinds.has('stuck_query')).toBe(true);
    expect(kinds.has('agent_down')).toBe(true);
    expect(kinds.has('build_failure')).toBe(true);
    expect(kinds.has('promotion_failure')).toBe(true);
    expect(kinds.has('news_repeated_error')).toBe(true);
  });

  it('tolerates source reader failures gracefully', async () => {
    const failingReader: SupervisorSourceReader = {
      async readActiveDispatches() { throw new Error('DB connection failed'); },
      async readTerminalDispatches() { throw new Error('DB connection failed'); },
      async readWatchedAgents() { return []; },
      async readRecentNews() { return []; },
    };

    const watcher = new SupervisorWatcher({
      config: cfg(),
      sourceReader: failingReader,
      sink,
      now: () => Date.now(),
    });

    // Should not throw
    await watcher.tick();
    expect(sink.records).toHaveLength(0);
  });

  it('does not start when disabled', () => {
    const watcher = new SupervisorWatcher({
      config: cfg({ enabled: false }),
      sourceReader: reader,
      sink,
    });

    watcher.start();
    expect(watcher.isRunning()).toBe(false);
  });

  it('start/stop lifecycle works', () => {
    const watcher = new SupervisorWatcher({
      config: cfg({ enabled: true, pollIntervalSeconds: 9999 }),
      sourceReader: reader,
      sink,
    });

    watcher.start();
    expect(watcher.isRunning()).toBe(true);
    watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });
});
