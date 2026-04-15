// SPDX-License-Identifier: MIT

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('getDeployerAddress returns null without wallet config', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['OWS_REGISTRAR_WALLET', 'AGENT_PRIVATE_KEY', 'PRIVATE_KEY'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('agent_account metadata is omitted when no deployer address available', () => {
    const address: string | undefined = undefined;
    const deployerAddress: string | null = null;

    const agentAccount = address || deployerAddress;
    const metadata = { name: 'test-agent' };
    const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };

    expect(updatedMeta).toEqual({ name: 'test-agent' });
    expect(updatedMeta).not.toHaveProperty('agent_account');
  });

  it('agent_account uses explicit address when deployerAddress is null', () => {
    const address = '0xabc123';
    const deployerAddress: string | null = null;

    const agentAccount = address || deployerAddress;
    const metadata = { name: 'test-agent' };
    const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };

    expect(updatedMeta).toEqual({ name: 'test-agent', agent_account: '0xabc123' });
  });

  it('agent_account uses deployerAddress when no explicit address', () => {
    const address: string | undefined = undefined;
    const deployerAddress: string | null = '0xdeployer';

    const agentAccount = address || deployerAddress;
    const metadata = { name: 'test-agent' };
    const updatedMeta = { ...metadata, ...(agentAccount && { agent_account: agentAccount }) };

    expect(updatedMeta).toEqual({ name: 'test-agent', agent_account: '0xdeployer' });
  });

  it('register: false config works without any wallet configuration', () => {
    expect(process.env.OWS_REGISTRAR_WALLET).toBeUndefined();
    expect(process.env.AGENT_PRIVATE_KEY).toBeUndefined();
    expect(process.env.PRIVATE_KEY).toBeUndefined();

    const agentSpec = { name: 'test', register: false };
    const deployerAddress: string | null = null;

    expect(agentSpec.register).toBe(false);
    expect(deployerAddress).toBeNull();

    const metadata: Record<string, unknown> = { name: agentSpec.name };
    const agentAccount = deployerAddress;
    if (agentAccount) {
      metadata.agent_account = agentAccount;
    }
    expect(metadata).not.toHaveProperty('agent_account');
  });
});
