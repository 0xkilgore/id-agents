import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors, fonts, spacing } from '../theme';
import { RootStackParamList, QrPayload, ServerEntry } from '../types';
import { connectClaudeAuth, testConnection } from '../services/api';
import { saveServer, setCurrentServer } from '../services/storage';

type Props = NativeStackScreenProps<RootStackParamList, 'Scan'>;

export function ScanScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Manual entry fields
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [team, setTeam] = useState('');
  const [claudeCredential, setClaudeCredential] = useState('');

  const connectToServer = async (server: ServerEntry) => {
    setConnecting(true);
    try {
      const result = await testConnection(server.url, server.apiKey, server.team);
      if (result.success) {
        if (claudeCredential.trim()) {
          const auth = await connectClaudeAuth(server, claudeCredential.trim(), 'claude-code-oauth');
          if (!auth.ok || !auth.connected) {
            Alert.alert('Claude Auth Failed', auth.error || 'Could not store Claude credential');
            return;
          }
        }
        await saveServer(server);
        await setCurrentServer(server.name);
        navigation.replace('Terminal', { server });
      } else {
        Alert.alert('Connection Failed', result.error || 'Could not connect to server');
      }
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleQrScanned = ({ data }: { data: string }) => {
    if (!scanning) return;
    setScanning(false);

    try {
      const payload: QrPayload = JSON.parse(data);
      if (!payload.url || !payload.apiKey) {
        Alert.alert('Invalid QR Code', 'QR code does not contain valid server info');
        setScanning(true);
        return;
      }

      const server: ServerEntry = {
        url: payload.url.replace(/\/$/, ''),
        apiKey: payload.apiKey,
        team: payload.team || 'default',
        name: new URL(payload.url).hostname,
      };

      connectToServer(server);
    } catch {
      Alert.alert('Invalid QR Code', 'Could not parse QR code data');
      setScanning(true);
    }
  };

  const handleManualConnect = () => {
    if (!url.trim() || !apiKey.trim()) {
      Alert.alert('Missing Fields', 'URL and API Key are required');
      return;
    }

    const server: ServerEntry = {
      url: url.trim().replace(/\/$/, ''),
      apiKey: apiKey.trim(),
      team: team.trim() || 'default',
      name: name.trim() || new URL(url.trim()).hostname,
    };

    connectToServer(server);
  };

  // Manual entry form
  if (showManual) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.formContainer}>
          <Text style={styles.title}>Connect to Server</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="my-server"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="https://example.com:3000"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="sk-admin-..."
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <Text style={styles.label}>Team</Text>
          <TextInput
            style={styles.input}
            value={team}
            onChangeText={setTeam}
            placeholder="default"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Claude OAuth Token</Text>
          <TextInput
            style={styles.input}
            value={claudeCredential}
            onChangeText={setClaudeCredential}
            placeholder="optional"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.connectButton, connecting && styles.buttonDisabled]}
            onPress={handleManualConnect}
            disabled={connecting}
          >
            {connecting ? (
              <ActivityIndicator color={colors.bg} />
            ) : (
              <Text style={styles.connectButtonText}>Connect</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.switchButton}
            onPress={() => setShowManual(false)}
          >
            <Text style={styles.switchButtonText}>Scan QR Code Instead</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // Camera / QR scanner
  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Camera Permission</Text>
        <Text style={styles.description}>
          Camera access is needed to scan QR codes for quick server connection.
        </Text>
        <TouchableOpacity style={styles.connectButton} onPress={requestPermission}>
          <Text style={styles.connectButtonText}>Grant Access</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.switchButton}
          onPress={() => setShowManual(true)}
        >
          <Text style={styles.switchButtonText}>Enter Manually Instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanning ? handleQrScanned : undefined}
      >
        <View style={styles.overlay}>
          <Text style={styles.scanTitle}>Scan Server QR Code</Text>
          <View style={styles.scanFrame} />
          <Text style={styles.scanHint}>
            Generate with /qr in the CLI
          </Text>
        </View>
      </CameraView>

      {connecting && (
        <View style={styles.connectingOverlay}>
          <ActivityIndicator color={colors.blue} size="large" />
          <Text style={styles.connectingText}>Connecting...</Text>
        </View>
      )}

      <View style={styles.bottomBar}>
        <TouchableOpacity
          style={styles.switchButton}
          onPress={() => setShowManual(true)}
        >
          <Text style={styles.switchButtonText}>Enter Manually</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.switchButton}
          onPress={() => navigation.navigate('Settings')}
        >
          <Text style={styles.switchButtonText}>Saved Servers</Text>
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
  centeredContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  scanTitle: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.lg,
    color: '#fff',
    marginBottom: spacing.xl,
    fontWeight: '600',
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: colors.blue,
    borderRadius: 12,
  },
  scanHint: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textMuted,
    marginTop: spacing.lg,
  },
  connectingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  connectingText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.text,
    marginTop: spacing.md,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: spacing.lg,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  formContainer: {
    padding: spacing.xl,
    paddingTop: 60,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.xl,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.xl,
  },
  description: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textMuted,
    marginBottom: spacing.xl,
    textAlign: 'center',
    lineHeight: 22,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.textMuted,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.text,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  connectButton: {
    backgroundColor: colors.blue,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 6,
    marginTop: spacing.xl,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  connectButtonText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.bg,
    fontWeight: '700',
  },
  switchButton: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  switchButtonText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.blue,
    textAlign: 'center',
  },
});
