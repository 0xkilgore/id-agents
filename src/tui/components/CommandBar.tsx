import React from 'react';
import { Box, Text } from 'ink';

interface CommandBarProps {
  buffer: string;
  running: boolean;
}

// Bottom-of-screen command input. The first character of `buffer` is the
// entry sigil (`:` or `/`) preserved verbatim so the user always sees
// what they typed. Backspace cannot delete the sigil; Esc exits the bar.
export function CommandBar({ buffer, running }: CommandBarProps): React.ReactElement {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan">{running ? 'running ' : ''}</Text>
      <Text>{buffer}</Text>
      <Text inverse> </Text>
    </Box>
  );
}
