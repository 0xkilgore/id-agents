import React from 'react';
import { Box, Text } from 'ink';
import type { DispatchAttemptLedgerRow } from '../api/types.js';

interface DispatchAttemptLedgerPanelProps {
  rows: DispatchAttemptLedgerRow[];
  loading: boolean;
  error: Error | null;
}

export function DispatchAttemptLedgerPanel(props: DispatchAttemptLedgerPanelProps): React.ReactElement | null {
  const { rows, loading, error } = props;
  const visible = rows.slice(0, 4);

  if (visible.length === 0 && !loading && !error) return null;

  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text dimColor>dispatch attempts </Text>
        {error ? (
          <Text color="red">ledger error: {error.message}</Text>
        ) : loading ? (
          <Text dimColor>loading</Text>
        ) : visible.length === 0 ? (
          <Text dimColor>no recent dispatch attempts</Text>
        ) : (
          visible.map((row, i) => (
            <React.Fragment key={row.id}>
              {i > 0 ? <Text dimColor> │ </Text> : null}
              <Attempt row={row} />
            </React.Fragment>
          ))
        )}
      </Text>
    </Box>
  );
}

function Attempt({ row }: { row: DispatchAttemptLedgerRow }): React.ReactElement {
  const target = row.to_agent ?? 'unknown';
  const query = row.original_query_id ?? row.original_dispatch_id ?? row.correlation_key;
  const primary =
    row.talk_to_attempted
      ? `/talk-to ${row.talk_to_status_code ?? (row.talk_to_ok ? 'ok' : 'fail')}`
      : row.news_to_attempted
        ? `/news-to ${row.news_to_status_code ?? (row.news_to_ok ? 'ok' : 'fail')}`
        : 'unknown path';
  const status = terminalStatusLabel(row.terminal_status);
  return (
    <>
      <Text color={status.color}>{status.label}</Text>
      <Text dimColor> → {target} </Text>
      <Text dimColor>{primary}</Text>
      <Text dimColor> ({query})</Text>
    </>
  );
}

function terminalStatusLabel(status: DispatchAttemptLedgerRow['terminal_status']): {
  label: string;
  color: 'green' | 'yellow' | 'red';
} {
  if (status === 'sent') return { label: 'sent', color: 'green' };
  if (status === 'fallback_sent') return { label: 'fallback sent', color: 'yellow' };
  if (status === 'failed') return { label: 'failed', color: 'red' };
  return { label: 'pending', color: 'yellow' };
}
