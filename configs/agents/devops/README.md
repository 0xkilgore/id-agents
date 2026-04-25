# devops

DevOps engineer avatar. Claude-native shape. Ships to Claude Code, Cursor (2.4+), and Codex.

## Bundled skills

| Skill | Author | Source | License |
|-------|--------|--------|---------|
| `iac-terraform` | ahmedasmar | [ahmedasmar/devops-claude-skills](https://github.com/ahmedasmar/devops-claude-skills/tree/main/iac-terraform) | MIT (declared in repo README; no standalone LICENSE file upstream) |
| `k8s-troubleshooter` | ahmedasmar | [ahmedasmar/devops-claude-skills](https://github.com/ahmedasmar/devops-claude-skills/tree/main/k8s-troubleshooter) | MIT (same posture as above) |
| `ci-cd` | ahmedasmar | [ahmedasmar/devops-claude-skills](https://github.com/ahmedasmar/devops-claude-skills/tree/main/ci-cd) | MIT (same posture as above) |
| `systematic-debugging` | obra | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) | MIT |

LICENSE text is stored verbatim at `skills/<name>/LICENSE`.

## License posture (whole avatar)

**MIT-clean.** All bundled skills are MIT. Persona CLAUDE.md and this README are MIT (operator-authored). Safe to redistribute under MIT or Apache templates.

Caveat: three of the four skills (the `ahmedasmar/devops-claude-skills` set) declare MIT only in the upstream README, not via a standalone `LICENSE` file. The LICENSE file in each bundled skill records this posture explicitly. If upstream ever changes its license, operators should re-check before redistributing.

## Safety review notes

- `iac-terraform/scripts/init_module.py` and `validate_module.py` — pure local file I/O, no network, no shell-out to untrusted commands.
- `k8s-troubleshooter/scripts/check_namespace.py` — wraps `kubectl` via `subprocess.run` with `capture_output=True`. Reads cluster state read-only (`get`, `describe`, `logs`). Does not mutate.
- `ci-cd/scripts/pipeline_analyzer.py` — local YAML analysis, uses `subprocess` only in a performance-recommendations code path (does not execute pipelines).
- `systematic-debugging/find-polluter.sh` — local test bisection, no network.
- Template files under `iac-terraform/assets/` and `ci-cd/assets/` are sample YAML/HCL. Review before copying into production; they are starting points, not blessed configs.
- No skill sets `allowed-tools` in frontmatter, so harness defaults apply.
- No `curl | sh` patterns. No hardcoded credentials. No unexpected external endpoints.

One thing to hold explicitly: **any skill that tells you to run `kubectl`, `terraform apply`, or `helm` will, by nature, interact with real systems**. The persona's rule is to show a plan / dry-run output before any mutating action and to escalate to the operator for production changes. Keep that discipline.

## Cursor + skills — supported

Cursor CLI 2.4+ supports skills natively at `.cursor/skills/<name>/SKILL.md`.
