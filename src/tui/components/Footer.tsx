import React from 'react';
import { Box, Text } from 'ink';

export type FooterView = 'agents' | 'news' | 'news-detail' | 'tasks';

interface FooterProps {
  view: FooterView;
  paused?: boolean;
}

const HINTS: Record<FooterView, string> = {
  agents: '↑↓ nav · → news · Tab team · t tasks · p pause · q quit',
  tasks: '↑↓ nav · Tab team · t agents · p pause · q quit',
  news: '↑↓ scroll · → open · ← back · p pause · q quit',
  'news-detail': '↑↓ scroll · ← back · p pause · q quit',
};

export function Footer({ view, paused }: FooterProps): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>{HINTS[view]}</Text>
      <Box>
        {paused ? <Text color="yellow">⏸ paused  </Text> : null}
        <Text dimColor>ID Agents Dashboard</Text>
      </Box>
    </Box>
  );
}
