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
  const visible = rows
    .filter((r) => r.talk_to_ok === false || r.fallback_used)
    .slice(0, 3);

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
          <Text dimColor>no recent primary-path failures</Text>
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
  const fallback = row.fallback_used
    ? row.fallback_ok
      ? 'fallback ok'
      : 'fallback failed'
    : 'no fallback';
  const fallbackColor = row.fallback_used && row.fallback_ok ? 'green' : row.fallback_used ? 'red' : 'yellow';
  return (
    <>
      <Text color="red">/talk-to {row.talk_to_status_code ?? 'fail'}</Text>
      <Text dimColor> → {target} </Text>
      <Text color={fallbackColor}>{fallback}</Text>
      <Text dimColor> ({query})</Text>
    </>
  );
}
