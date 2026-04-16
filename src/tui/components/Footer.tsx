import React from 'react';
import { Box, Text } from 'ink';

interface FooterProps {
  paused?: boolean;
  lastUpdatedAgo?: string;
}

export function Footer({ paused, lastUpdatedAgo }: FooterProps): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text dimColor>
        [↑↓] select [PgUp/PgDn] page [Home/End] jump [Tab/⇧Tab] team [p] pause [q] quit
      </Text>
      <Text dimColor>
        {paused ? <Text color="yellow">⏸ paused</Text> : null}
        {lastUpdatedAgo ? ` · updated ${lastUpdatedAgo}` : null}
      </Text>
    </Box>
  );
}
