import React from 'react';
import { Box, Text } from 'ink';
import type { LibraryAgentDetailResponse } from '../api/manager.js';

interface LibraryAgentDetailProps {
  agent: LibraryAgentDetailResponse | null;
  agentName: string | null;
  loading: boolean;
  error: Error | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth: number;
}

const README_PREVIEW_LINES = 18;

export function LibraryAgentDetail(props: LibraryAgentDetailProps): React.ReactElement {
  const { agent, agentName, loading, error, positionLabel, windowSize, scrollOffset, contentWidth } = props;

  const lines = buildBodyLines(agent, contentWidth, loading, error);
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          library agent · {agent?.name ?? agentName ?? '(none)'}
          {agent ? <Text dimColor>  {agent.shape}</Text> : null}
        </Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={windowSize} />
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Body(props: { visible: string[]; windowSize: number }): React.ReactElement {
  const { visible, windowSize } = props;
  const padCount = Math.max(0, windowSize - visible.length);
  return (
    <>
      {visible.map((line, i) => (
        <Text key={`line-${i}`}>{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </>
  );
}

function buildBodyLines(
  agent: LibraryAgentDetailResponse | null,
  width: number,
  loading: boolean,
  error: Error | null,
): string[] {
  if (error) return [`error: ${error.message}`];
  if (!agent) return [loading ? 'loading…' : '(no library agent selected)'];

  const out: string[] = [];
  out.push(`name:        ${agent.name}`);
  out.push(`shape:       ${agent.shape}`);
  out.push(`source path: ${agent.source_path}`);
  out.push(`memory file: ${agent.memoryFile}`);
  out.push(`README:      ${agent.hasReadme ? 'present' : '—'}`);
  out.push(`LICENSE:     ${agent.hasLicense ? 'present' : '—'}`);
  out.push('');
  out.push('── subfolders ──');
  if (agent.subfolders.length === 0) {
    out.push('(none)');
  } else {
    for (const sub of agent.subfolders) out.push(`• ${sub}`);
  }
  out.push('');
  out.push('── bundled skills ──');
  if (agent.bundledSkills.length === 0) {
    out.push('(none)');
  } else {
    for (const skill of agent.bundledSkills) out.push(`• ${skill}`);
  }
  out.push('');
  out.push('── README preview ──');
  if (!agent.readme || agent.readme.trim() === '') {
    out.push('(no README.md)');
  } else {
    const readmeLines = agent.readme.split(/\r?\n/);
    for (const raw of readmeLines.slice(0, README_PREVIEW_LINES)) {
      const line = raw.trimEnd();
      if (line === '') {
        out.push('');
        continue;
      }
      out.push(...wrap(line, width));
    }
    if (readmeLines.length > README_PREVIEW_LINES) {
      out.push(`… (${readmeLines.length - README_PREVIEW_LINES} more lines)`);
    }
  }
  return out;
}

function wrap(s: string, width: number): string[] {
  if (width <= 0) return [s];
  const out: string[] = [];
  let remaining = s;
  while (remaining.length > width) {
    out.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  out.push(remaining);
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
