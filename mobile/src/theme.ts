import { Platform } from 'react-native';

export const colors = {
  // Background
  bg: '#0d1117',
  bgSecondary: '#161b22',
  bgTertiary: '#21262d',
  bgInput: '#0d1117',
  border: '#30363d',

  // Text
  text: '#e6edf3',
  textMuted: '#8b949e',
  textDim: '#484f58',

  // Accent
  green: '#3fb950',
  red: '#f85149',
  yellow: '#d29922',
  blue: '#58a6ff',
  cyan: '#39d2c0',
  purple: '#bc8cff',
  orange: '#f0883e',

  // Status
  statusOnline: '#3fb950',
  statusOffline: '#8b949e',
  statusError: '#f85149',
  statusBusy: '#d29922',
};

export const fonts = {
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'monospace',
  }),
  size: {
    xs: 11,
    sm: 13,
    base: 14,
    lg: 16,
    xl: 18,
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};
