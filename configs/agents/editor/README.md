# editor

Copy editor and anti-AI-pattern editor. Claude-native shape, **codex-runtime intended** (will deploy as `AGENTS.md` + `.agents/skills/` per slice 5's runtime mapping).

## Bundled skills

- `humanizer` — strip signs of AI-generated writing.
  - Source: https://github.com/blader/humanizer
  - Author: Siqi Chen
  - License: MIT (`skills/humanizer/LICENSE`)
- `copy-editing` — seven-sweep marketing copy framework.
  - Source: https://github.com/coreyhaines31/marketingskills (`skills/copy-editing/`)
  - Author: Corey Haines
  - License: MIT (`skills/copy-editing/LICENSE`)

Both upstream LICENSE files are preserved next to their SKILL.md, with the original copyright lines intact, per MIT redistribution requirements.

## Persona

See `CLAUDE.md`. The editor knows when to lead with which skill based on the user's request phrasing.

## License

Persona MIT (operator-authored). Bundled skills MIT with their original copyright preserved in `skills/<name>/LICENSE`.
