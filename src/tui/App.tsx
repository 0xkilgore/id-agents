import React from 'react';
import { Box, useApp, useInput } from 'ink';
import { Header } from './components/Header.js';
import { Footer } from './components/Footer.js';

const MANAGER_URL = process.env.MANAGER_URL ?? 'http://localhost:4100';

export function App(): React.ReactElement {
  const { exit } = useApp();
  useInput(
    (input) => {
      if (input === 'q') exit();
    },
    { isActive: process.stdin.isTTY === true },
  );

  return (
    <Box flexDirection="column">
      <Header managerUrl={MANAGER_URL} />
      <Box flexGrow={1} />
      <Footer />
    </Box>
  );
}
