export type TaskActionState =
  | 'idle'
  | 'pending'
  | 'acknowledged'
  | 'failed'
  | 'stale'
  | 'refreshed';

export type TaskEmptyState = 'none' | 'index-building' | 'no-tasks' | 'filter-hidden';

export interface TaskSurfaceStateInput {
  totalCount: number;
  visibleCount: number;
  selectedTeam: string | null;
  loading: boolean;
  errorMessage: string | null;
  lastUpdatedMs: number;
  nowMs: number;
  actionState?: TaskActionState;
  actionMessage?: string | null;
  staleAfterMs?: number;
}

export interface TaskSurfaceState {
  state: TaskActionState;
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  detail: string | null;
  emptyState: TaskEmptyState;
  emptyLabel: string | null;
}

const DEFAULT_STALE_AFTER_MS = 15_000;

export function deriveTaskSurfaceState(input: TaskSurfaceStateInput): TaskSurfaceState {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const actionState = input.actionState ?? 'idle';
  const errorMessage = trimToNull(input.errorMessage);
  const hasData = input.lastUpdatedMs > 0;
  const stale =
    hasData &&
    !input.loading &&
    input.nowMs - input.lastUpdatedMs > staleAfterMs;

  const emptyState = deriveEmptyState(input);
  const emptyLabel = labelForEmptyState(emptyState, input.selectedTeam);

  if (actionState === 'pending') {
    return {
      state: 'pending',
      label: 'refresh pending',
      tone: 'warning',
      detail: input.actionMessage ?? 'read model request in flight',
      emptyState,
      emptyLabel,
    };
  }

  if (actionState === 'failed') {
    return {
      state: 'failed',
      label: 'refresh failed',
      tone: 'danger',
      detail: input.actionMessage ?? errorMessage,
      emptyState,
      emptyLabel,
    };
  }

  if (errorMessage) {
    return {
      state: hasData ? 'stale' : 'failed',
      label: hasData ? 'stale' : 'read failed',
      tone: hasData ? 'warning' : 'danger',
      detail: errorMessage,
      emptyState,
      emptyLabel,
    };
  }

  if (actionState === 'refreshed') {
    return {
      state: 'refreshed',
      label: 'refreshed',
      tone: 'success',
      detail: input.actionMessage ?? 'task rows updated',
      emptyState,
      emptyLabel,
    };
  }

  if (actionState === 'acknowledged') {
    return {
      state: 'acknowledged',
      label: 'acknowledged',
      tone: 'success',
      detail: input.actionMessage ?? 'read model answered; no row changes',
      emptyState,
      emptyLabel,
    };
  }

  if (stale) {
    return {
      state: 'stale',
      label: 'stale',
      tone: 'warning',
      detail: `last refreshed ${Math.max(1, Math.floor((input.nowMs - input.lastUpdatedMs) / 1000))}s ago`,
      emptyState,
      emptyLabel,
    };
  }

  return {
    state: 'idle',
    label: hasData ? 'current' : input.loading ? 'index building' : 'idle',
    tone: 'neutral',
    detail: null,
    emptyState,
    emptyLabel,
  };
}

function deriveEmptyState(input: TaskSurfaceStateInput): TaskEmptyState {
  if (input.visibleCount > 0) return 'none';
  if (input.loading && input.lastUpdatedMs === 0) return 'index-building';
  if (input.totalCount > 0 && input.selectedTeam !== null) return 'filter-hidden';
  return 'no-tasks';
}

function labelForEmptyState(state: TaskEmptyState, selectedTeam: string | null): string | null {
  switch (state) {
    case 'index-building':
      return 'building task index...';
    case 'filter-hidden':
      return `no tasks match team ${selectedTeam ?? ''}`;
    case 'no-tasks':
      return 'no tasks recorded yet';
    case 'none':
      return null;
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const s = value?.trim();
  return s ? s : null;
}
