// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

describe('team delete safety check', () => {
  function checkTeamDeletable(agentCount: number, teamName: string): { allowed: boolean; error?: string } {
    if (teamName === 'default') {
      return { allowed: false, error: 'Cannot delete the "default" team — it is the fallback for all unscoped requests' };
    }
    if (agentCount > 0) {
      return {
        allowed: false,
        error: `Team "${teamName}" still has ${agentCount} agent(s). Run /delete --team ${teamName} first to remove agents, then /team delete ${teamName} to remove the team.`
      };
    }
    return { allowed: true };
  }

  it('refuses to delete a team with agents', () => {
    const result = checkTeamDeletable(3, 'staging');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('still has 3 agent(s)');
    expect(result.error).toContain('/delete --team staging');
  });

  it('allows deletion of an empty team', () => {
    const result = checkTeamDeletable(0, 'staging');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('refuses to delete the default team', () => {
    const result = checkTeamDeletable(0, 'default');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('default');
  });

  it('error message includes both required steps', () => {
    const result = checkTeamDeletable(5, 'production');
    expect(result.error).toContain('/delete --team production');
    expect(result.error).toContain('/team delete production');
  });
});
