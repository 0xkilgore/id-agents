import React from 'react';
import { Box, Text } from 'ink';

export type FooterView = 'agents' | 'news';

interface FooterProps {
  view: FooterView;
  paused?: boolean;
}

const HINTS: Record<FooterView, string> = {
  agents: '↑↓ nav · Tab team · n news · p pause · q quit',
  news: '↑↓ scroll · Esc back · p pause · q quit',
};

export function Footer({ view, paused }: FooterProps): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text dimColor>{HINTS[view]}</Text>
      {paused ? <Text color="yellow">⏸ paused</Text> : null}
    </Box>
  );
}
