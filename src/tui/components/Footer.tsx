import React from 'react';
import { Box, Text } from 'ink';

export function Footer(): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text dimColor>[q] quit</Text>
    </Box>
  );
}
