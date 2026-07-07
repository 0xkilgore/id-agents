// SPDX-License-Identifier: MIT
//
// Pure closeout classification for deploy-freshness-watchdog. The watchdog
// needs to prove the running manager actually moved to the remote tip after a
// remediation attempt; a successful launchctl kickstart alone is not enough.

export const DEFAULT_REDEPLOY_COMMAND =
  '/Users/kilgore/Dropbox/Code/cane/scripts/manager-promote-rebuild-restart.sh && curl -sS http://localhost:4100/health';

function short(sha) {
  return typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 12) : 'null';
}

/**
 * @typedef {Object} CloseoutInput
 * @property {boolean} healthOk
 * @property {string|null} freshnessState
 * @property {string|null} buildSha
 * @property {string|null} originMainSha
 * @property {string|null} remoteMainSha
 * @property {string} [remoteMainSource]
 * @property {string} [redeployCommand]
 *
 * @typedef {Object} CloseoutResult
 * @property {'fresh'|'stale'} classification
 * @property {boolean} ok
 * @property {boolean|null} buildMatchesOrigin
 * @property {boolean|null} originMatchesRemoteTip
 * @property {string[]} failures
 * @property {string} summary
 * @property {string|null} escalation
 */

/**
 * Classify post-remediation evidence.
 * @param {CloseoutInput} input
 * @returns {CloseoutResult}
 */
export function classifyCloseout(input) {
  const h = input || {};
  const command = h.redeployCommand || DEFAULT_REDEPLOY_COMMAND;
  const buildMatchesOrigin =
    h.buildSha && h.originMainSha ? h.buildSha === h.originMainSha : null;
  const originMatchesRemoteTip =
    h.originMainSha && h.remoteMainSha ? h.originMainSha === h.remoteMainSha : null;

  const failures = [];
  if (!h.healthOk) failures.push('/health unreadable after remediation');
  if (h.freshnessState !== 'fresh') failures.push(`freshness=${h.freshnessState ?? 'unknown'} (expected fresh)`);
  if (buildMatchesOrigin !== true) {
    failures.push(`build_sha ${short(h.buildSha)} != origin_main_sha ${short(h.originMainSha)}`);
  }
  if (originMatchesRemoteTip !== true) {
    failures.push(`origin_main_sha ${short(h.originMainSha)} != remote main tip ${short(h.remoteMainSha)}`);
  }

  const ok = failures.length === 0;
  const evidence =
    `build_sha=${short(h.buildSha)} origin_main_sha=${short(h.originMainSha)} ` +
    `remote_main_sha=${short(h.remoteMainSha)} freshness=${h.freshnessState ?? 'unknown'} ` +
    `remote_tip_equal=${originMatchesRemoteTip === true}`;

  return {
    classification: ok ? 'fresh' : 'stale',
    ok,
    buildMatchesOrigin,
    originMatchesRemoteTip,
    failures,
    summary: ok
      ? `closeout verified fresh: ${evidence}`
      : `closeout still stale: ${evidence}; ${failures.join('; ')}`,
    escalation: ok
      ? null
      : `Manager still stale after watchdog remediation. Run exactly: ${command}`,
  };
}

/**
 * @param {CloseoutInput} input
 * @returns {string}
 */
export function formatCloseoutMarkdown(input) {
  const c = classifyCloseout(input);
  const lines = [
    '## Closeout verifier',
    '',
    `- classification: ${c.classification}`,
    `- build_sha: ${input.buildSha ?? 'null'}`,
    `- origin_main_sha: ${input.originMainSha ?? 'null'}`,
    `- remote_main_sha: ${input.remoteMainSha ?? 'null'}`,
    `- remote_main_source: ${input.remoteMainSource ?? 'unknown'}`,
    `- health_ok: ${input.healthOk}`,
    `- health_freshness: ${input.freshnessState ?? 'unknown'}`,
    `- build_matches_origin: ${c.buildMatchesOrigin}`,
    `- origin_matches_remote_tip: ${c.originMatchesRemoteTip}`,
  ];
  if (c.failures.length > 0) {
    lines.push('', `**Escalation:** ${c.escalation}`, '', `Failures: ${c.failures.join('; ')}`);
  }
  return lines.join('\n');
}
