// Supervisor v0 — Alert state management.
// Handles dedupe, open/resolved transitions, and JSONL replay on restart.

import crypto from 'crypto';
import type {
  SupervisorAlertRecord,
  SupervisorAlertState,
  RuleFinding,
  ConfigSnapshot,
} from './types.js';

function makeAlertId(dedupeKey: string): string {
  return crypto.createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16);
}

export class AlertStateManager {
  private openAlerts = new Map<string, SupervisorAlertState>();
  // Track consecutive ticks where a previously-open alert's condition is absent.
  private missingTicks = new Map<string, number>();
  private readonly resolutionTickThreshold: number;

  constructor(resolutionTickThreshold = 2) {
    this.resolutionTickThreshold = resolutionTickThreshold;
  }

  getOpenAlerts(): SupervisorAlertState[] {
    return Array.from(this.openAlerts.values());
  }

  getAlertState(dedupeKey: string): SupervisorAlertState | undefined {
    return this.openAlerts.get(dedupeKey);
  }

  processTick(
    findings: RuleFinding[],
    configSnapshot: ConfigSnapshot,
    now: string,
  ): SupervisorAlertRecord[] {
    const emitted: SupervisorAlertRecord[] = [];
    const seenKeys = new Set<string>();

    for (const finding of findings) {
      seenKeys.add(finding.dedupe_key);
      const existing = this.openAlerts.get(finding.dedupe_key);

      if (!existing) {
        // New alert
        const alertId = makeAlertId(finding.dedupe_key);
        const record: SupervisorAlertRecord = {
          alert_id: alertId,
          dedupe_key: finding.dedupe_key,
          status: 'open',
          kind: finding.kind,
          severity: finding.severity,
          confidence: finding.confidence,
          detected_at: now,
          updated_at: now,
          agent_id: finding.agent_id,
          query_id: finding.query_id,
          dispatch_id: finding.dispatch_id,
          graph_id: finding.graph_id,
          task_name: finding.task_name,
          title: finding.title,
          summary: finding.summary,
          evidence: finding.evidence,
          counters: finding.counters,
          config_snapshot: configSnapshot,
        };

        const state: SupervisorAlertState = {
          alert_id: alertId,
          dedupe_key: finding.dedupe_key,
          kind: finding.kind,
          status: 'open',
          severity: finding.severity,
          first_detected_at: now,
          last_seen_at: now,
          last_record_json: record,
          occurrence_count: 1,
        };

        this.openAlerts.set(finding.dedupe_key, state);
        this.missingTicks.delete(finding.dedupe_key);
        emitted.push(record);
      } else {
        // Existing alert — check if materially changed
        this.missingTicks.delete(finding.dedupe_key);

        const changed = existing.severity !== finding.severity ||
          existing.last_record_json.summary !== finding.summary ||
          JSON.stringify(existing.last_record_json.counters) !== JSON.stringify(finding.counters);

        if (changed) {
          existing.severity = finding.severity;
          existing.last_seen_at = now;
          existing.occurrence_count++;

          const record: SupervisorAlertRecord = {
            alert_id: existing.alert_id,
            dedupe_key: finding.dedupe_key,
            status: 'updated',
            kind: finding.kind,
            severity: finding.severity,
            confidence: finding.confidence,
            detected_at: existing.first_detected_at,
            updated_at: now,
            agent_id: finding.agent_id,
            query_id: finding.query_id,
            dispatch_id: finding.dispatch_id,
            graph_id: finding.graph_id,
            task_name: finding.task_name,
            title: finding.title,
            summary: finding.summary,
            evidence: finding.evidence,
            counters: finding.counters,
            config_snapshot: configSnapshot,
          };

          existing.last_record_json = record;
          emitted.push(record);
        } else {
          // Same state, just update last_seen
          existing.last_seen_at = now;
        }
      }
    }

    // Resolve alerts whose condition is no longer present
    for (const [key, state] of this.openAlerts) {
      if (seenKeys.has(key)) continue;

      const misses = (this.missingTicks.get(key) ?? 0) + 1;
      this.missingTicks.set(key, misses);

      if (misses >= this.resolutionTickThreshold) {
        state.status = 'resolved';
        state.resolved_at = now;

        const record: SupervisorAlertRecord = {
          alert_id: state.alert_id,
          dedupe_key: state.dedupe_key,
          status: 'resolved',
          kind: state.kind,
          severity: state.severity,
          confidence: state.last_record_json.confidence,
          detected_at: state.first_detected_at,
          updated_at: now,
          resolved_at: now,
          agent_id: state.last_record_json.agent_id,
          query_id: state.last_record_json.query_id,
          dispatch_id: state.last_record_json.dispatch_id,
          graph_id: state.last_record_json.graph_id,
          task_name: state.last_record_json.task_name,
          title: state.last_record_json.title,
          summary: `Resolved: ${state.last_record_json.summary}`,
          evidence: state.last_record_json.evidence,
          counters: state.last_record_json.counters,
          config_snapshot: state.last_record_json.config_snapshot,
        };

        emitted.push(record);
        this.openAlerts.delete(key);
        this.missingTicks.delete(key);
      }
    }

    return emitted;
  }

  replayFromRecords(records: SupervisorAlertRecord[]): void {
    // Replay JSONL records to reconstruct open alert state.
    // Process in order; final state wins.
    for (const record of records) {
      if (record.status === 'resolved') {
        this.openAlerts.delete(record.dedupe_key);
        this.missingTicks.delete(record.dedupe_key);
        continue;
      }

      const state: SupervisorAlertState = {
        alert_id: record.alert_id,
        dedupe_key: record.dedupe_key,
        kind: record.kind,
        status: 'open',
        severity: record.severity,
        first_detected_at: record.detected_at,
        last_seen_at: record.updated_at,
        last_record_json: record,
        occurrence_count: 1,
      };

      const existing = this.openAlerts.get(record.dedupe_key);
      if (existing) {
        state.occurrence_count = existing.occurrence_count + 1;
        state.first_detected_at = existing.first_detected_at;
      }

      this.openAlerts.set(record.dedupe_key, state);
    }
  }
}
