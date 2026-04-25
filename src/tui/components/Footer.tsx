import React from 'react';
import { Box, Text } from 'ink';

export type FooterView =
  | 'agents'
  | 'agent-detail'
  | 'news'
  | 'news-detail'
  | 'tasks'
  | 'task-detail'
  | 'calendar'
  | 'heartbeats'
  | 'heartbeat-detail'
  | 'library-agents'
  | 'library-agent-detail'
  | 'library-skills'
  | 'library-skill-detail';

interface FooterProps {
  view: FooterView;
}

// Top-level views (agents, tasks, calendar, heartbeats) are reached via
// hotkey; they have nothing to go back TO, so no `← back` hint. Drill-
// downs (task-detail, heartbeat-detail, news, news-detail) keep the
// back hint because they have a real parent to return to.
const HINTS: Record<FooterView, string> = {
  agents: '↑↓ nav · → detail/news · Tab team · t tasks · l library · s skills · c calendar · h heartbeats · q quit',
  'agent-detail': '↑↓ scroll · q quit · ← back',
  tasks: '↑↓ nav · → detail · Tab team · l library · s skills · c calendar · h heartbeats · q quit · ← back',
  calendar: '↑↓ nav · a agents · t tasks · l library · s skills · h heartbeats · q quit',
  heartbeats: '↑↓ nav · → detail · a agents · t tasks · l library · s skills · c calendar · q quit',
  'task-detail': '↑↓ scroll · q quit · ← back',
  'heartbeat-detail': '↑↓ scroll · q quit · ← back',
  news: '↑↓ scroll · → open · q quit · ← back',
  'news-detail': '↑↓ scroll · q quit · ← back',
  'library-agents': '↑↓ nav · → detail · s skills · a agents · t tasks · c calendar · h heartbeats · q quit · ← back',
  'library-agent-detail': '↑↓ scroll · q quit · ← back',
  'library-skills': '↑↓ nav · → detail · l library · a agents · t tasks · c calendar · h heartbeats · q quit · ← back',
  'library-skill-detail': '↑↓ scroll · q quit · ← back',
};

export function Footer({ view }: FooterProps): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>{HINTS[view]}</Text>
      <Text dimColor>ID Agents Dashboard</Text>
    </Box>
  );
}
