import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';
import { RootStackParamList, ServerEntry } from './src/types';
import { colors, fonts } from './src/theme';
import { ScanScreen } from './src/screens/ScanScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { getCurrentServer } from './src/services/storage';

const Stack = createNativeStackNavigator<RootStackParamList>();

const DarkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.blue,
    background: colors.bg,
    card: colors.bgSecondary,
    text: colors.text,
    border: colors.border,
    notification: colors.blue,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.bgSecondary },
  headerTintColor: colors.text,
  headerTitleStyle: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
  },
  contentStyle: { backgroundColor: colors.bg },
};

export default function App() {
  const [initialRoute, setInitialRoute] = useState<keyof RootStackParamList | null>(null);
  const [initialServer, setInitialServer] = useState<ServerEntry | null>(null);

  // Check for a saved current server on launch
  useEffect(() => {
    async function checkSaved() {
      const server = await getCurrentServer();
      if (server) {
        setInitialServer(server);
        setInitialRoute('Terminal');
      } else {
        setInitialRoute('Scan');
      }
    }
    checkSaved();
  }, []);

  if (!initialRoute) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={colors.blue} size="large" />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={DarkTheme}>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName={initialRoute}
        screenOptions={screenOptions}
      >
        <Stack.Screen
          name="Scan"
          component={ScanScreen}
          options={{ title: 'ID Agents', headerShown: false }}
        />
        <Stack.Screen
          name="Terminal"
          component={TerminalScreen}
          initialParams={initialServer ? { server: initialServer } : undefined}
          options={({ route }) => ({
            title: route.params?.server?.name || 'Terminal',
            headerBackVisible: false,
            headerRight: () => null, // Settings button added in screen
          })}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Saved Servers' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
