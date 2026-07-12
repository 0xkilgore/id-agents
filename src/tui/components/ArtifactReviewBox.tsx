import React from 'react';
import { Box, Text } from 'ink';
import type {
  ArtifactComment,
  ArtifactDeskRow,
  ArtifactMutationReceipt,
  ArtifactReviewResponse,
} from '../api/types.js';
import { truncate } from '../util/format.js';

export interface ArtifactActionState {
  kind: 'idle' | 'posting' | 'posted' | 'failed';
  action: 'comment' | 'approve' | 'ship' | null;
  message: string | null;
  receipt?: ArtifactMutationReceipt | null;
}

interface ArtifactReviewBoxProps {
  artifact: ArtifactDeskRow | null;
  review: ArtifactReviewResponse | null;
  comments: ArtifactComment[];
  loading: boolean;
  error: Error | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
  actionState: ArtifactActionState;
}

export function ArtifactReviewBox(props: ArtifactReviewBoxProps): React.ReactElement {
  const {
    artifact,
    review,
    comments,
    loading,
    error,
    positionLabel,
    windowSize,
    scrollOffset,
    contentWidth,
    actionState,
  } = props;
  const bodyWindowSize = Math.max(0, windowSize - 1);
  const lines = buildLines({ artifact, review, comments, loading, error, contentWidth, actionState });
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - bodyWindowSize));
  const end = Math.min(total, start + bodyWindowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>artifact · {artifact?.title ? truncate(artifact.title, 42) : '(none selected)'}</Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text color={actionState.kind === 'failed' ? 'red' : actionState.kind === 'posted' ? 'green' : 'gray'}>
        {actionLabel(actionState)}
        <Text dimColor> · m comment · v approve · p ship · r refresh</Text>
      </Text>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.map((line, i) => (
        <Line key={`line-${i}`} line={line} />
      ))}
      {Array.from({ length: Math.max(0, bodyWindowSize - visible.length) }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

type DetailLine =
  | { text: string; tone?: 'dim' | 'warn' | 'ok' | 'bad' | 'info' }
  | { text: string; label: string; tone?: 'dim' | 'warn' | 'ok' | 'bad' | 'info' };

function buildLines(input: {
  artifact: ArtifactDeskRow | null;
  review: ArtifactReviewResponse | null;
  comments: ArtifactComment[];
  loading: boolean;
  error: Error | null;
  contentWidth: number;
  actionState: ArtifactActionState;
}): DetailLine[] {
  const { artifact, review, comments, loading, error, contentWidth, actionState } = input;
  if (!artifact) return [{ text: '(no artifact selected)', tone: 'dim' }];
  const out: DetailLine[] = [];
  out.push({ label: 'id', text: artifact.id });
  out.push({ label: 'status', text: artifact.status || 'unknown' });
  out.push({ label: 'agent', text: artifact.agent_name ?? 'unknown' });
  out.push({ label: 'source', text: artifact.source_path ?? artifact.artifact_ref ?? 'unavailable' });
  out.push({
    label: 'body',
    text: artifact.delivery?.body_available === false || artifact.visibility_proof?.body_renderable === false
      ? `unavailable (${artifact.delivery?.freshness ?? 'missing'})`
      : artifact.delivery?.body_source ?? 'available',
    tone: artifact.delivery?.body_available === false || artifact.visibility_proof?.body_renderable === false ? 'warn' : 'ok',
  });
  out.push({ text: '' });
  if (error) {
    out.push({ text: `review load failed: ${error.message}`, tone: 'bad' });
  } else if (loading && !review) {
    out.push({ text: 'loading review state...', tone: 'dim' });
  } else if (!review) {
    out.push({ text: 'review state not found; artifact remains selectable from surfaced desk', tone: 'warn' });
  } else {
    const state = review.state;
    out.push({ text: '-- review --', tone: 'dim' });
    out.push({ label: 'operations', text: String(review.operations_count ?? 0) });
    out.push({ label: 'comments', text: String(review.comments_count ?? comments.length) });
    out.push({ label: 'approved', text: state?.approved_at ? `${state.approved_by ?? 'unknown'} at ${state.approved_at}` : 'not approved' });
    out.push({ label: 'rejected', text: state?.rejected_at ? `${state.rejected_by ?? 'unknown'} at ${state.rejected_at}` : 'not rejected' });
  }
  if (actionState.kind === 'failed') {
    out.push({ text: '' });
    out.push({ text: `last action failed: ${actionState.message ?? 'unknown error'}`, tone: 'bad' });
    if (actionState.receipt?.code) out.push({ label: 'code', text: actionState.receipt.code });
    if (actionState.receipt?.blockers?.length) out.push({ label: 'blockers', text: actionState.receipt.blockers.join(', ') });
  }
  out.push({ text: '' });
  out.push({ text: '-- comments --', tone: 'dim' });
  if (comments.length === 0) {
    out.push({ text: 'no comments recorded', tone: 'dim' });
  } else {
    for (const c of comments.slice(0, 8)) {
      const prefix = `${c.op_id} ${c.actor}`;
      for (const line of wrap(c.body, Math.max(20, contentWidth - prefix.length - 3))) {
        out.push({ label: prefix, text: line, tone: routeTone(c) });
      }
    }
  }
  const preview = artifact.delivery?.body_preview;
  if (preview) {
    out.push({ text: '' });
    out.push({ text: '-- preview --', tone: 'dim' });
    for (const line of wrap(preview.replace(/\s+/g, ' ').trim(), contentWidth).slice(0, 6)) {
      out.push({ text: line });
    }
  }
  return out;
}

function Line({ line }: { line: DetailLine }): React.ReactElement {
  const color = line.tone === 'bad' ? 'red' : line.tone === 'warn' ? 'yellow' : line.tone === 'ok' ? 'green' : line.tone === 'info' ? 'cyan' : undefined;
  if ('label' in line) {
    return (
      <Text color={color}>
        <Text dimColor>{line.label.padEnd(12)}</Text>
        {line.text || ' '}
      </Text>
    );
  }
  return <Text color={color} dimColor={line.tone === 'dim'}>{line.text || ' '}</Text>;
}

function actionLabel(state: ArtifactActionState): string {
  if (state.kind === 'idle') return 'review ready';
  if (state.kind === 'posting') return `${state.action ?? 'action'} posting...`;
  if (state.kind === 'posted') return state.message ?? `${state.action ?? 'action'} recorded`;
  return state.message ?? `${state.action ?? 'action'} failed`;
}

function routeTone(comment: ArtifactComment): DetailLine['tone'] {
  const visible = comment.route_status?.visible_state ?? '';
  if (visible.includes('failed')) return 'warn';
  if (visible.includes('routed')) return 'ok';
  return undefined;
}

function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  out.push(rest);
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
