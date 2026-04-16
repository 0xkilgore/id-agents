import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  paused?: boolean;
  lastUpdated?: number;
}

export function Footer({ paused, lastUpdated }: FooterProps): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text dimColor>
        [↑↓] select [PgUp/PgDn] page [Home/End] jump [Tab/⇧Tab] team [p] pause [q] quit
      </Text>
      <Box>
        {paused ? <Text color="yellow">⏸ paused </Text> : null}
        {lastUpdated ? (
          <Text dimColor>updated {formatAbsolute(lastUpdated)}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function formatAbsolute(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
