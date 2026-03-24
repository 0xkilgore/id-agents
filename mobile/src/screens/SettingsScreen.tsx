import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, ServerEntry } from '../types';
import { colors, fonts, spacing } from '../theme';
import {
  getServers,
  deleteServer,
  getCurrentServerName,
  setCurrentServer,
} from '../services/storage';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [currentName, setCurrentName] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    const list = await getServers();
    const current = await getCurrentServerName();
    setServers(list);
    setCurrentName(current);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadServers();
    }, [loadServers])
  );

  const handleSelect = async (server: ServerEntry) => {
    await setCurrentServer(server.name);
    navigation.navigate('Terminal', { server });
  };

  const handleDelete = (server: ServerEntry) => {
    Alert.alert(
      'Delete Server',
      `Remove "${server.name}" from saved servers?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteServer(server.name);
            await loadServers();
          },
        },
      ]
    );
  };

  const renderServer = ({ item }: { item: ServerEntry }) => {
    const isCurrent = item.name === currentName;
    return (
      <TouchableOpacity
        style={[styles.serverRow, isCurrent && styles.serverRowActive]}
        onPress={() => handleSelect(item)}
        onLongPress={() => handleDelete(item)}
      >
        <View style={styles.serverInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.serverName}>{item.name}</Text>
            {isCurrent && <Text style={styles.currentBadge}>ACTIVE</Text>}
          </View>
          <Text style={styles.serverUrl} numberOfLines={1}>
            {item.url}
          </Text>
          <Text style={styles.serverTeam}>team: {item.team}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={servers}
        keyExtractor={(item) => item.name}
        renderItem={renderServer}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No saved servers</Text>
            <Text style={styles.emptyHint}>
              Scan a QR code or enter server details to get started
            </Text>
          </View>
        }
      />
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => navigation.navigate('Scan')}
        >
          <Text style={styles.addButtonText}>+ Add Server</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  list: {
    padding: spacing.lg,
  },
  serverRow: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  serverRowActive: {
    borderColor: colors.blue,
  },
  serverInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  serverName: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.text,
    fontWeight: '600',
  },
  currentBadge: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.xs,
    color: colors.blue,
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  serverUrl: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textMuted,
    marginBottom: 2,
  },
  serverTeam: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.xs,
    color: colors.textDim,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.lg,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  emptyHint: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textDim,
    textAlign: 'center',
    lineHeight: 22,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  addButton: {
    backgroundColor: colors.blue,
    padding: spacing.md,
    borderRadius: 6,
    alignItems: 'center',
  },
  addButtonText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.bg,
    fontWeight: '700',
  },
});
