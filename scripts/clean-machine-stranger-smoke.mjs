#!/usr/bin/env node
// Synthetic clean-machine smoke for the Gideon R2/R5 spike.
// Run after `npm run build`: `node scripts/clean-machine-stranger-smoke.mjs`.

import os from 'node:os';
import path from 'node:path';

const {
  evaluateSyntheticStrangerStarterFleet,
  syntheticStrangerClaudeOnlyEnv,
} = await import('../dist/clean-machine-spike/index.js');

const profileHome = process.env.CLEAN_MACHINE_HOME
  || path.join(os.tmpdir(), 'id-agents-stranger-profile');
const env = syntheticStrangerClaudeOnlyEnv(profileHome, {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'synthetic-claude-only-key',
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  OPENAI_API_KEY: '',
  CURSOR_API_KEY: '',
  OPENROUTER_API_KEY: '',
});

const result = evaluateSyntheticStrangerStarterFleet(env);
const missingAuthResult = evaluateSyntheticStrangerStarterFleet(syntheticStrangerClaudeOnlyEnv(profileHome, {
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  OPENAI_API_KEY: '',
  CURSOR_API_KEY: '',
  OPENROUTER_API_KEY: '',
}));
const summary = {
  ok: result.ok,
  profileHome,
  cockpit: result.cockpit,
  agents: result.agents,
  credentialSeams: result.credential.sources.map((source) => source.seam),
  privateMachinePathFindings: result.privateMachinePathFindings,
  providerAssumptions: result.providerAssumptions,
  claudeOnlyOffendingCodes: result.graceful.offendingCodes,
  missingAuth: {
    ok: missingAuthResult.ok,
    cockpit: missingAuthResult.cockpit,
    reason: missingAuthResult.credential.reason,
    credentialSeams: missingAuthResult.credential.sources.map((source) => source.seam),
    providerAssumptions: missingAuthResult.providerAssumptions,
    claudeOnlyOffendingCodes: missingAuthResult.graceful.offendingCodes,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (
  !result.ok
  || missingAuthResult.ok
  || missingAuthResult.cockpit.state !== 'blocked'
  || !missingAuthResult.credential.reason?.includes('Connect Claude in Kapelle first-run setup')
) {
  process.exitCode = 1;
}
