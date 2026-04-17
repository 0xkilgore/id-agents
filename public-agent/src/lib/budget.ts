import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../env.js';

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
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(budgetFile(env), JSON.stringify(state, null, 2));
}

function rollover(state: BudgetState, today: string): BudgetState {
  if (state.utc_date !== today) {
    return { utc_date: today, tokens_used: 0 };
  }
  return state;
}

export function isOverBudget(env: Env): { over: boolean; used: number; resets_at: string } {
  const today = todayUtc();
  const state = rollover(read(env), today);
  const resets_at = new Date(Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)) + 1,
  )).toISOString();
  if (env.maxTokensPerDay <= 0) return { over: false, used: state.tokens_used, resets_at };
  return { over: state.tokens_used >= env.maxTokensPerDay, used: state.tokens_used, resets_at };
}

export function recordTokens(env: Env, tokens: number): void {
  if (tokens <= 0) return;
  const today = todayUtc();
  const state = rollover(read(env), today);
  state.tokens_used += tokens;
  write(env, state);
}
