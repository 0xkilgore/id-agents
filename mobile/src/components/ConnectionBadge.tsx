import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts, spacing } from '../theme';

interface Props {
  serverName: string;
  team: string;
  connected: boolean;
}

export function ConnectionBadge({ serverName, team, connected }: Props) {
  return (
    <View style={styles.container}>
      <View
        style={[
          styles.dot,
          { backgroundColor: connected ? colors.statusOnline : colors.statusOffline },
        ]}
      />
      <Text style={styles.serverName} numberOfLines={1}>
        {serverName}
      </Text>
      <Text style={styles.separator}>/</Text>
      <Text style={styles.team} numberOfLines={1}>
        {team}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.sm,
  },
  serverName: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.text,
    fontWeight: '600',
  },
  separator: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textDim,
    marginHorizontal: spacing.xs,
  },
  team: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textMuted,
  },
});
