# frontend

Frontend designer + builder. Claude-native shape, **cursor-runtime intended**.

## Bundled skills

- `frontend-design` — Anthropic's frontend design skill, copied from the `web` agent's working directory. License: complete terms in `frontend-design/LICENSE.txt`.

## Cursor + skills — supported

Cursor CLI (2.4+) supports skills natively at `.cursor/skills/<name>/SKILL.md`, same format as Claude Code's `.claude/skills/` and Codex's `.agents/skills/`. All three runtimes converged on the open agent skills standard.

When this agent deploys to a cursor-cli target, the library's `skills/<name>/` folder lands at `<workspace>/.cursor/skills/<name>/` and Cursor auto-discovers it at session start. No format conversion needed.

## License

Persona MIT (operator-authored). Bundled skill: see `skills/frontend-design/LICENSE.txt`.
