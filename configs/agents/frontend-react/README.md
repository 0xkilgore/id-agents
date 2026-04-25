# frontend-react

React frontend developer avatar. Claude-native shape. Ships to Claude Code, Cursor (2.4+), and Codex at `~/.claude/skills/`, `.cursor/skills/`, or `.agents/skills/` respectively.

## Bundled skills

| Skill | Author | Source | License |
|-------|--------|--------|---------|
| `react-best-practices` | vercel-labs | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) | MIT (declared in repo README; no standalone LICENSE file upstream) |
| `frontend-design` | anthropics | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Apache-2.0 |
| `webapp-testing` | anthropics | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) | Apache-2.0 |
| `test-driven-development` | obra | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/test-driven-development) | MIT |

LICENSE text is stored verbatim at `skills/<name>/LICENSE`.

## License posture (whole avatar)

**MIT-clean.** All bundled skills are MIT or Apache-2.0, both permissive. Persona CLAUDE.md and this README are MIT (operator-authored). This avatar can be redistributed as part of an MIT or Apache templated product without copyleft concerns.

## Safety review notes

- `webapp-testing` bundles `scripts/with_server.py` (server lifecycle) and three `examples/*.py` files. All are local Playwright usage, no network calls outside localhost.
- `react-best-practices` bundles 70+ `rules/*.md` files plus `metadata.json`. Pure markdown, no scripts.
- `test-driven-development` bundles `testing-anti-patterns.md`. Pure markdown, no scripts.
- `frontend-design` is pure markdown.
- No skill lists unrestricted `allowed-tools: Bash`. Anthropics skills do not set `allowed-tools` (defaults apply). `react-best-practices` and `test-driven-development` do not set it either.
- No hardcoded credentials, no `curl | sh` patterns, no unexpected external endpoints observed.

## Cursor + skills — supported

Cursor CLI 2.4+ supports skills natively at `.cursor/skills/<name>/SKILL.md`. Same format as Claude Code and Codex.
