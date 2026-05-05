import React from 'react';
import { Box, Text } from 'ink';

interface CommandResultViewProps {
  command: string;       // raw line including the entry sigil, e.g. ":agents"
  text: string;          // formatted result body (JSON pretty-print for v1)
  windowSize: number;
  scrollOffset: number;
}

// Scrollable scaffold for command results. v1 renders the formatted JSON
// payload line-by-line; command-specific renderers (Phase 3+) will swap
// in for known commands by inspecting `command`.
export function CommandResultView(props: CommandResultViewProps): React.ReactElement {
  const lines = props.text.length === 0 ? [''] : props.text.split('\n');
  const total = lines.length;
  const maxStart = Math.max(0, total - props.windowSize);
  const start = Math.min(Math.max(0, props.scrollOffset), maxStart);
  const visible = lines.slice(start, start + props.windowSize);
  const padCount = Math.max(0, props.windowSize - visible.length);
  const endLineNo = start + visible.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">cmd · {props.command}</Text>
        <Text dimColor>
          {total} lines · {total === 0 ? 0 : start + 1}–{endLineNo} · ↑↓ scroll · Esc clear
        </Text>
      </Box>
      <Text dimColor> </Text>
      {visible.map((line, i) => (
        <Text key={`cmd-line-${start + i}`} wrap="truncate-end">{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`cmd-pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
