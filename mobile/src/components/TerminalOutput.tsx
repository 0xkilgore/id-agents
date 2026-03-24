import React, { useRef, useEffect } from 'react';
import { FlatList, Text, StyleSheet, View } from 'react-native';
import { OutputLine } from '../types';
import { colors, fonts, spacing } from '../theme';

interface Props {
  lines: OutputLine[];
}

const lineColors: Record<OutputLine['type'], string> = {
  command: colors.cyan,
  result: colors.text,
  error: colors.red,
  info: colors.textMuted,
  'ws-news': colors.green,
  system: colors.yellow,
};

function OutputRow({ item }: { item: OutputLine }) {
  return (
    <View style={styles.row}>
      <Text
        style={[styles.text, { color: lineColors[item.type] || colors.text }]}
        selectable
      >
        {item.text}
      </Text>
    </View>
  );
}

export function TerminalOutput({ lines }: Props) {
  const listRef = useRef<FlatList<OutputLine>>(null);

  useEffect(() => {
    if (lines.length > 0) {
      // Auto-scroll to bottom on new content
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 50);
    }
  }, [lines.length]);

  return (
    <FlatList
      ref={listRef}
      data={lines}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <OutputRow item={item} />}
      style={styles.container}
      contentContainerStyle={styles.content}
      // Performance optimizations
      removeClippedSubviews
      maxToRenderPerBatch={20}
      windowSize={15}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  row: {
    paddingVertical: 2,
  },
  text: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    lineHeight: 20,
  },
});
