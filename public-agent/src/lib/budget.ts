import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';
import { atomicWriteJson } from './atomic.js';

interface BudgetState {
  utc_date: string;        // YYYY-MM-DD
  tokens_used: number;
}

function budgetFile(env: Env): string {
  return path.join(env.dataDir, 'budget.json');
}

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function read(env: Env): BudgetState {
  const file = budgetFile(env);
  if (!fs.existsSync(file)) {
    return { utc_date: todayUtc(), tokens_used: 0 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BudgetState;
    if (!parsed.utc_date || typeof parsed.tokens_used !== 'number') {
      return { utc_date: todayUtc(), tokens_used: 0 };
    }
    return parsed;
  } catch {
    return { utc_date: todayUtc(), tokens_used: 0 };
  }
}

function write(env: Env, state: BudgetState): void {
  atomicWriteJson(budgetFile(env), state);
}

function rollover(state: BudgetState, today: string): BudgetState {
  if (state.utc_date !== today) {
    return { utc_date: today, tokens_used: 0 };
  }
  return state;
}

function resetsAt(today: string): string {
  return new Date(Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)) + 1,
  )).toISOString();
}

export function isOverBudget(env: Env): { over: boolean; used: number; remaining: number; resets_at: string } {
  const today = todayUtc();
  const state = rollover(read(env), today);
  const resets_at = resetsAt(today);
  if (env.maxTokensPerDay <= 0) {
    return { over: false, used: state.tokens_used, remaining: Number.POSITIVE_INFINITY, resets_at };
  }
  const remaining = Math.max(0, env.maxTokensPerDay - state.tokens_used);
  return { over: state.tokens_used >= env.maxTokensPerDay, used: state.tokens_used, remaining, resets_at };
}

// Pessimistic pre-reservation. Add `tokens` to tokens_used *before* the
// OpenRouter call so two concurrent requests can't both slip past the budget
// check. Reconcile after the call returns with the true usage.
export function reserveTokens(env: Env, tokens: number): void {
  if (tokens <= 0) return;
  const today = todayUtc();
  const state = rollover(read(env), today);
  state.tokens_used += tokens;
  write(env, state);
}

// Replace a prior reservation with the real usage. `reserved` is what was
// added in reserveTokens; `actual` is the OpenRouter-reported total.
// Net change on disk: (actual - reserved) — can be negative.
export function reconcileTokens(env: Env, reserved: number, actual: number): void {
  const delta = actual - reserved;
  if (delta === 0) return;
  const today = todayUtc();
  const state = rollover(read(env), today);
  state.tokens_used = Math.max(0, state.tokens_used + delta);
  write(env, state);
}

// Kept for backwards-compat and the non-reserved path (e.g. failed reservations).
export function recordTokens(env: Env, tokens: number): void {
  if (tokens <= 0) return;
  reserveTokens(env, tokens);
}
