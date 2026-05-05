import React from 'react';
import { Box, Text } from 'ink';

interface CommandResultViewProps {
  command: string;       // raw line including the entry sigil, e.g. ":agents"
  text: string;          // formatted result body (JSON pretty-print for v1)
  windowSize: number;
  scrollOffset: number;
}

// Cheap key-field highlight. Catches the common pretty-printed JSON
// shape `<indent>"key": <value>` and colours the key. Lines that don't
// match (array elements, multi-line strings, top-level scalars) render
// as-is. A real syntax pass is a Phase 3+ concern; this is the minimal
// affordance the cto called out as "nearly free" in the brief.
const KEY_LINE_RE = /^(\s*)"([^"\\]+)"(\s*:\s*)(.*)$/;

function renderJsonLine(line: string, lineKey: string): React.ReactElement {
  if (!line) {
    return <Text key={lineKey}> </Text>;
  }
  const m = KEY_LINE_RE.exec(line);
  if (!m) {
    return <Text key={lineKey} wrap="truncate-end">{line}</Text>;
  }
  const [, indent, key, sep, rest] = m;
  return (
    <Text key={lineKey} wrap="truncate-end">
      {indent}
      <Text color="yellow">{`"${key}"`}</Text>
      {sep}
      {rest}
    </Text>
  );
}

// Scrollable scaffold for command results. v1 renders the formatted JSON
// payload line-by-line with key-field highlighting; command-specific
// renderers (Phase 3+) will swap in for known commands by inspecting
// `command`.
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
      {visible.map((line, i) => renderJsonLine(line, `cmd-line-${start + i}`))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`cmd-pad-${i}`}> </Text>
      ))}
    </Box>
  );
}
