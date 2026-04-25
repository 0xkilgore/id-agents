# fullstack-nextjs

Fullstack Next.js developer avatar. Claude-native shape. Ships to Claude Code, Cursor (2.4+), and Codex.

## Bundled skills

| Skill | Author | Source | License |
|-------|--------|--------|---------|
| `react-best-practices` | vercel-labs | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) | MIT (declared in repo README; no standalone LICENSE file upstream) |
| `deploy-to-vercel` | vercel-labs | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/deploy-to-vercel) | MIT (same posture as above) |
| `frontend-design` | anthropics | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 |
| `test-driven-development` | obra | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/test-driven-development) | MIT |
| `systematic-debugging` | obra | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) | MIT |

LICENSE text is stored verbatim at `skills/<name>/LICENSE`.

## License posture (whole avatar)

**MIT-clean.** All bundled skills are MIT or Apache-2.0. Persona CLAUDE.md and this README are MIT (operator-authored). Safe to redistribute under MIT or Apache templates without copyleft concerns.

## Safety review notes

- `deploy-to-vercel` bundles two shell scripts in `resources/` — `deploy.sh` and `deploy-codex.sh`. Both hit Vercel-operated HTTPS endpoints:
  - `deploy.sh` → `https://claude-skills-deploy.vercel.com/api/deploy`
  - `deploy-codex.sh` → `https://codex-deploy-skills.vercel.sh/api/deploy`
  These are the canonical Vercel "claimable deploy" endpoints advertised by the skill. No credentials are baked in. Operator should accept that running this skill will POST project files to a Vercel-operated endpoint. If that's a concern, fall back to the `vercel` CLI workflow the SKILL.md also documents.
- `systematic-debugging` bundles `find-polluter.sh` (test-bisection helper, local-only) and markdown references.
- `react-best-practices` bundles 70+ rule markdown files plus `metadata.json`. Pure documentation.
- `test-driven-development` bundles `testing-anti-patterns.md`. Pure documentation.
- `frontend-design` is pure markdown.
- No skill lists unrestricted `allowed-tools: Bash`. Anthropics / vercel-labs / obra skills in this bundle do not set `allowed-tools` (defaults apply).
- No hardcoded credentials observed.

## Cursor + skills — supported

Cursor CLI 2.4+ supports skills natively at `.cursor/skills/<name>/SKILL.md`.
