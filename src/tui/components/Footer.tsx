import React from 'react';
import { Box, Text } from 'ink';

export type FooterView =
  | 'agents'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail';

interface FooterProps {
  view: FooterView;
  paused?: boolean;
}

// Top-level views (agents, tasks, calendar, heartbeats) are reached via
// hotkey; they have nothing to go back TO, so no `← back` hint. Drill-
// downs (task-detail, heartbeat-detail, news, news-detail) keep the
// back hint because they have a real parent to return to.
const HINTS: Record<FooterView, string> = {
  agents: '↑↓ nav · → news · Tab team · t tasks · c calendar · h heartbeats · p pause · q quit',
  tasks: '↑↓ nav · → detail · Tab team · c calendar · h heartbeats · p pause · q quit · ← back',
  calendar: '↑↓ nav · a agents · t tasks · h heartbeats · p pause · q quit',
  heartbeats: '↑↓ nav · → detail · a agents · t tasks · c calendar · p pause · q quit',
  'task-detail': '↑↓ scroll · p pause · q quit · ← back',
  'heartbeat-detail': '↑↓ scroll · p pause · q quit · ← back',
  news: '↑↓ scroll · → open · p pause · q quit · ← back',
  'news-detail': '↑↓ scroll · p pause · q quit · ← back',
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
