# security

Application security reviewer avatar. Claude-native shape. Ships to Claude Code, Cursor (2.4+), and Codex.

## ⚠ License warning — read first

**This avatar is packaged under CC-BY-SA-4.0.** The bundled Trail of Bits skills are CC-BY-SA-4.0, a viral share-alike license. Anything that incorporates the Trail of Bits SKILL.md content (or derivatives of it) inherits that license.

**Do not bundle this avatar's content into a template that distributes under MIT, Apache-2.0, or another permissive license without legal review.** The share-alike clause applies to the skill content. You cannot relabel it as MIT in a downstream product.

The persona `CLAUDE.md` and this `README.md` are **also CC-BY-SA-4.0** for the same reason: they reference and direct the use of Trail of Bits skills, and keeping the whole avatar under one license removes ambiguity when redistributing.

Bottom line: ship this avatar as a standalone CC-BY-SA-4.0 component, not as a hidden dependency inside an MIT template.

## Bundled skills

| Skill | Author | Source | License |
|-------|--------|--------|---------|
| `static-analysis` (codeql + semgrep + sarif-parsing sub-skills) | trailofbits | [trailofbits/skills](https://github.com/trailofbits/skills/tree/main/plugins/static-analysis) | CC-BY-SA-4.0 |
| `insecure-defaults` | trailofbits | [trailofbits/skills](https://github.com/trailofbits/skills/tree/main/plugins/insecure-defaults) | CC-BY-SA-4.0 |
| `differential-review` | trailofbits | [trailofbits/skills](https://github.com/trailofbits/skills/tree/main/plugins/differential-review) | CC-BY-SA-4.0 |
| `supply-chain-risk-auditor` | trailofbits | [trailofbits/skills](https://github.com/trailofbits/skills/tree/main/plugins/supply-chain-risk-auditor) | CC-BY-SA-4.0 |

Full LICENSE text (CC-BY-SA-4.0) is stored verbatim at `skills/<name>/LICENSE`.

## License posture (whole avatar)

**CC-BY-SA-4.0 (share-alike).** See the warning above. This avatar cannot be rebundled under MIT/Apache without legal review. It can be redistributed standalone under CC-BY-SA-4.0.

## Safety review notes

Each Trail of Bits skill declares `allowed-tools:` in its frontmatter. Review:

- `insecure-defaults` → `Read`, `Grep`, `Glob`, `Bash`. Scans files. Bash is expected for `grep`/`find` shell-outs. No network.
- `differential-review` → `Read`, `Write`, `Grep`, `Glob`, `Bash`. Reads git, writes report. Bash is expected for `git log`, `git diff`. No network.
- `supply-chain-risk-auditor` → `Read`, `Write`, `Bash`, `Glob`, `Grep`. Reads manifests, writes report. Bash is expected. No network required by the SKILL.md itself, though dependency research may call package registries in follow-up.
- `static-analysis/codeql` → `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, plus harness-specific tools (`AskUserQuestion`, `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskGet`, `TodoRead`, `TodoWrite`). Invokes the `codeql` CLI. Requires CodeQL installed locally. No remote script execution.
- `static-analysis/semgrep` → `Bash`, `Read`, `Glob`, `Task`, plus harness tools. Invokes the `semgrep` CLI. Ships `scripts/merge_sarif.py` — local SARIF merging via `subprocess` to the semgrep CLI only. No remote script execution.
- `static-analysis/sarif-parsing` → `Bash`, `Read`, `Glob`, `Grep`. Ships `resources/sarif_helpers.py` (local JSON parsing, no network) and `resources/jq-queries.md`.

**Bash is present across all these skills because the upstream tools are CLI scanners.** This is expected for a security-review avatar. Red flag would be `Bash` with no scanner context — that's not the case here.

No `curl | sh` patterns observed. No hardcoded credentials. No unexpected external endpoints (SARIF schema URLs in output are just JSON Schema references, not fetched).

## Cursor + skills — supported

Cursor CLI 2.4+ supports skills natively at `.cursor/skills/<name>/SKILL.md`. CC-BY-SA-4.0 terms apply regardless of runtime target.
