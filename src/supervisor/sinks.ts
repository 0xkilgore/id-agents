// Supervisor v0 — Alert sinks.
// Structured log, JSONL file, optional local notification.

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import type { SupervisorAlertRecord } from './types.js';
import type { SupervisorWatchConfig } from './config.js';

export interface AlertSink {
  emit(record: SupervisorAlertRecord): void;
}

export class LogSink implements AlertSink {
  emit(record: SupervisorAlertRecord): void {
    const level = record.status === 'resolved' ? 'info'
      : record.severity === 'critical' ? 'error'
      : record.severity === 'warning' ? 'warn'
      : 'info';

    const line = `[Supervisor] ${record.status.toUpperCase()} ${record.kind} [${record.severity}] ${record.title}`;
    switch (level) {
      case 'error': console.error(line); break;
      case 'warn': console.warn(line); break;
      default: console.log(line); break;
    }
  }
}

export class JsonlFileSink implements AlertSink {
  private filePath: string;
  private initialized = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureDir(): void {
    if (this.initialized) return;
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.initialized = true;
  }

  emit(record: SupervisorAlertRecord): void {
    try {
      this.ensureDir();
      appendFileSync(this.filePath, JSON.stringify(record) + '\n');
    } catch (err) {
      console.error('[Supervisor] supervisor_sink_error: failed to write alert file:', err instanceof Error ? err.message : String(err));
    }
  }

  getFilePath(): string {
    return this.filePath;
  }
}

export class LocalNotificationSink implements AlertSink {
  private config: SupervisorWatchConfig;

  constructor(config: SupervisorWatchConfig) {
    this.config = config;
  }

  emit(record: SupervisorAlertRecord): void {
    if (!this.config.localNotificationsEnabled) return;
    if (record.status === 'resolved') return;
    if (record.severity !== 'critical') return;
    if (!this.config.criticalNotificationKinds.includes(record.kind)) return;

    // Best-effort local notification via osascript on macOS
    try {
      const { execFileSync } = require('child_process');
      execFileSync('osascript', [
        '-e',
        `display notification "${record.summary.slice(0, 200)}" with title "Supervisor Alert" subtitle "${record.kind}: ${record.title.slice(0, 100)}"`,
      ], { timeout: 3000 });
    } catch {
      // Ignore notification failures — this is never the sole channel.
    }
  }
}

export class CompositeSink implements AlertSink {
  private sinks: AlertSink[];

  constructor(sinks: AlertSink[]) {
    this.sinks = sinks;
  }

  emit(record: SupervisorAlertRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(record);
      } catch (err) {
        console.error('[Supervisor] sink error:', err instanceof Error ? err.message : String(err));
      }
    }
  }
}

export function createDefaultSinks(config: SupervisorWatchConfig): CompositeSink {
  const sinks: AlertSink[] = [
    new LogSink(),
    new JsonlFileSink(config.alertFilePath),
  ];

  if (config.localNotificationsEnabled) {
    sinks.push(new LocalNotificationSink(config));
  }

  return new CompositeSink(sinks);
}
