# copywriter

Conversion copywriter. Writes new marketing copy from scratch. Hands drafts to the `editor` agent for polish.

## Bundled skills

- `copywriting` — page-by-page conversion copywriting framework with formulas for headlines, CTAs, and section flow.
  - Source: https://github.com/coreyhaines31/marketingskills (`skills/copywriting/`)
  - Author: Corey Haines
  - License: MIT (`skills/copywriting/LICENSE`)

The upstream LICENSE file is preserved next to the SKILL.md with the original copyright line intact, per MIT redistribution requirements.

## Persona

See `CLAUDE.md`. The copywriter writes new copy. It does not edit existing copy — that's the `editor` agent's job.

## Pair with `editor`

This agent is designed to be paired with `editor` in a team. Workflow:

1. Operator asks for new page copy
2. Copywriter drafts (above-the-fold + core sections, with headline variants)
3. Editor runs seven-sweep + humanizer passes on the draft
4. Final copy delivered

The team YAML at `configs/editorial-team-v2.yaml` wires the pair.

## License

Persona MIT (operator-authored). Bundled `copywriting` skill MIT with the original copyright preserved at `skills/copywriting/LICENSE`.
