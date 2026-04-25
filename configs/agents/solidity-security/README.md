# solidity-security

Adversarial security reviewer for Solidity / Foundry codebases. Claude-native shape.

## Shape

Claude-native. `CLAUDE.md` in this folder is the persona.

## Bundled content

Two skills bundled under `skills/`:

- `solidity-auditor` — on-the-fly security review of Solidity code, triggered by "audit", "check this contract", "review for security". Extracted from the production `contracts` agent on the idchain team.
- `x-ray` — pre-audit readiness report generator (threat model, invariants, integrations, test analysis, developer/git history). Same source.

Intentionally NOT bundled: `wallet` (agent-level signing ability; out of scope for an audit persona), Trail of Bits' static-analysis pack (CC-BY-SA-4.0, would contaminate this MIT entry).

## Recommended companion skills

For Foundry test writing and style work during an audit, install the foundry-dev skills separately under `/configs/skills/` and list them in the team YAML's `skills:` field.

## Non-scope

- Writing new features.
- Style-only complaints.
- Performance optimization.

Those live in the `foundry-dev` agent.

## License

MIT.
