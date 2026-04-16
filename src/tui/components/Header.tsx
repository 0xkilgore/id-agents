import React from 'react';
import { Box, Text } from 'ink';

interface HeaderProps {
  managerUrl: string;
}

export function Header({ managerUrl }: HeaderProps): React.ReactElement {
  return (
    <Box borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text bold>id-agents · dashboard</Text>
      <Text dimColor>MANAGER {managerUrl}</Text>
    </Box>
  );
}
