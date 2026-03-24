import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, TouchableOpacity } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, OutputLine, ServerEntry } from '../types';
import { colors, fonts, spacing } from '../theme';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { TerminalOutput } from '../components/TerminalOutput';
import { CommandInput } from '../components/CommandInput';
import { executeCommand } from '../services/api';
import { WebSocketManager } from '../services/websocket';
import {
  formatCommand,
  formatResponse,
  formatWsNews,
  systemLine,
} from '../services/formatter';

type Props = NativeStackScreenProps<RootStackParamList, 'Terminal'>;

export function TerminalScreen({ route, navigation }: Props) {
  const { server } = route.params;
  const [lines, setLines] = useState<OutputLine[]>([
    systemLine(`Connected to ${server.name} (${server.team})`),
  ]);
  const [wsConnected, setWsConnected] = useState(false);
  const [executing, setExecuting] = useState(false);
  const wsRef = useRef<WebSocketManager | null>(null);

  // Add lines immutably
  const addLines = useCallback((newLines: OutputLine[]) => {
    setLines((prev) => [...prev, ...newLines]);
  }, []);

  // Set up WebSocket
  useEffect(() => {
    const ws = new WebSocketManager(server);
    wsRef.current = ws;

    const unsubscribe = ws.onMessage((message) => {
      if (message.type === 'connected') {
        setWsConnected(true);
        return;
      }

      if (message.type === 'news') {
        const line = formatWsNews(message);
        if (line) {
          addLines([line]);
        }
      }
    });

    ws.connect();

    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [server, addLines]);

  // Add settings button to header
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={() => navigation.navigate('Settings')}
          style={{ paddingHorizontal: spacing.md }}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: fonts.size.sm, color: colors.blue }}>
            Servers
          </Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  const handleCommand = async (command: string) => {
    // Add the command line
    addLines([formatCommand(command)]);

    // Handle local commands
    if (command === '/clear') {
      setLines([systemLine('Cleared')]);
      return;
    }

    if (command === '/disconnect') {
      wsRef.current?.disconnect();
      navigation.goBack();
      return;
    }

    // Execute remote command
    setExecuting(true);
    try {
      const response = await executeCommand(server, command);
      const resultLines = formatResponse(response);
      addLines(resultLines);
    } catch (err: any) {
      addLines([
        {
          id: `err-${Date.now()}`,
          text: `Error: ${err.message || 'Command failed'}`,
          type: 'error',
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <View style={styles.container}>
      <ConnectionBadge
        serverName={server.name}
        team={server.team}
        connected={wsConnected}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <TerminalOutput lines={lines} />
        <CommandInput onSubmit={handleCommand} disabled={executing} />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
});
