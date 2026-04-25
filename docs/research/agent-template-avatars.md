# Agent Template Research — Software Developer Avatars

Research date: 2026-04-23. Target use case: agent templates for software development on the id-agents platform. This is desk research only. Nothing was installed or executed.

## Methodology

**Popularity sources for avatars.** Avatar selection was anchored in three widely cited developer-demographic datasets, all with 2025 editions.

- Stack Overflow Developer Survey 2025 (49,000+ developers, 177 countries). Confirmed JavaScript, Python, HTML/CSS, SQL as the most-used languages. Python jumped 7 points year-over-year. Rust is the most admired language.
- JetBrains State of Developer Ecosystem 2025 (24,534 developers, 194 countries). Confirmed TypeScript, Rust, Go as highest-growth "promise" languages. React at 46.9% is the most-used frontend. Node.js at 49.1% leads backend.
- GitHub Octoverse 2025. TypeScript overtook Python and JavaScript as the most-used language on GitHub in August 2025. Top six (TS, Python, JS, Java, C++, C#) cover ~80% of new repositories.

I used these to weight avatars toward TypeScript-heavy web work (frontend, full-stack), Python AI/data, and the growing typed-systems audience (Rust/Go). Mobile, DevOps, smart contracts, and security were kept because they are high-revenue specialist tracks that consistently show up in JetBrains's role segmentation even if the absolute language shares are smaller.

**Sources for skills.** Three layers.

1. **skills.sh** — the public Claude Skills leaderboard. Visible signals include install counts (e.g. find-skills 1.2M installs, frontend-design 332.7K, skill-creator 166.1K). The leaderboard is author/install-ranked, not category-filtered, so coverage for DevOps/blockchain/security required falling back to GitHub.
2. **Anthropic first-party** — `github.com/anthropics/skills` (123k stars) for reference skills, plus the spec and templates.
3. **GitHub search and awesome-lists** — `hesreallyhim/awesome-claude-code` (11.7k stars), `VoltAgent/awesome-claude-code-subagents` (18.2k stars), `travisvn/awesome-claude-skills`, and direct repo lookups for trail-of-bits, obra/superpowers, dbt-labs, expo, etc.

**Reputation ranking.** I preferred, in order: (a) skills published by the vendor behind the tool (dbt-labs, Expo, Anthropic, Trail of Bits), (b) high GitHub star counts on the hosting repo, (c) install counts from skills.sh when visible, (d) recent commits (last ~3 months). When no clear reputation signal was available I noted "signal unclear" rather than guess.

## Avatars

### 1. Frontend developer (React / TypeScript)
- Description: Builds browser UIs with React and increasingly Next.js, using TypeScript for type safety. Works daily with component libraries (shadcn, Tailwind), bundler config, accessibility, and visual-polish tasks.
- Primary stack: TypeScript, React, Tailwind CSS, shadcn/ui, Vite or Next.js, Playwright for e2e.

### 2. Full-stack developer (Next.js / TypeScript)
- Description: Ships end-to-end features across a single TypeScript codebase. Lives in Next.js App Router, server actions, Postgres/Supabase, and auth. Often the first-hire developer at a small company.
- Primary stack: TypeScript, Next.js, React, Postgres/Supabase, Vercel, shadcn, Playwright.

### 3. Backend developer (Python or Node.js)
- Description: Designs HTTP and RPC services, database schemas, background jobs, and third-party integrations. Python (FastAPI/Django) dominates AI-adjacent backends; Node.js remains the JetBrains-measured #1 backend runtime.
- Primary stack: Python 3.12 + FastAPI/Django OR Node.js + Express/NestJS, Postgres, Redis, Docker, OpenAPI.

### 4. Mobile developer (iOS / React Native)
- Description: Native iOS with Swift/SwiftUI, or cross-platform with React Native and Expo. Cares about simulator/device testing, App Store signing, and platform idiosyncrasies.
- Primary stack: Swift + SwiftUI + Xcode, or TypeScript + React Native + Expo + EAS.

### 5. DevOps / SRE
- Description: Owns infrastructure as code, CI/CD, observability, and incident response. Spends the day in Terraform, Kubernetes, GitHub Actions, Prometheus/Grafana, and cloud consoles.
- Primary stack: Terraform/OpenTofu, Kubernetes, AWS or GCP, GitHub Actions, ArgoCD, Prometheus.

### 6. Data / analytics engineer
- Description: Builds batch pipelines and the semantic layer on top of a warehouse. dbt is dominant. Python for ingestion, SQL everywhere, occasional Spark for big jobs.
- Primary stack: dbt, Snowflake/BigQuery/Postgres, Python, SQL, Airflow or Dagster.

### 7. ML engineer
- Description: Trains, fine-tunes, and deploys models. PyTorch is the dominant research framework; production-ready training and MLOps round out the day.
- Primary stack: Python, PyTorch, HuggingFace Transformers, CUDA, Docker, MLflow or Weights & Biases.

### 8. Systems / Rust engineer
- Description: Writes low-level services, parsers, embedded firmware, or performance-critical libraries in Rust (or C/C++). Cares about ownership, zero-cost abstractions, and cargo-based project hygiene.
- Primary stack: Rust, cargo, clippy, tokio, possibly embedded HAL crates, occasional C/C++ interop.

### 9. Smart contract / Web3 developer
- Description: Writes Solidity contracts, tests with Foundry/Hardhat, audits for reentrancy and ERC-20 weirdness, and deploys to EVM chains. Security-adjacent by necessity.
- Primary stack: Solidity, Foundry (forge/cast), Hardhat, OpenZeppelin, EVM chains (Ethereum, Base, Arbitrum).

### 10. Security / AppSec engineer
- Description: Reviews code for vulnerabilities, configures static analysis, runs pen-tests, and investigates supply-chain risk. Crosses into smart-contract auditing and cryptographic review.
- Primary stack: Semgrep, CodeQL, ffuf, Burp Suite, language-specific static analyzers, SARIF tooling.

## Skills per avatar

Links below point to the source of truth the operator can inspect: GitHub repo, skills.sh listing, or Anthropic docs. Star counts and install counts are reported as of 2026-04-23 based on the fetched pages.

### Frontend developer (React / TypeScript)

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| frontend-design | anthropics | Anthropic first-party; 332.7K installs on skills.sh; parent repo 123k stars | https://github.com/anthropics/skills/tree/main/skills/frontend-design | Design guidance that pushes past generic aesthetics using React + Tailwind | Core taste/defaults for any React UI work |
| web-artifacts-builder | anthropics | First-party; parent repo 123k stars | https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder | Build complex HTML artifacts with React, Tailwind, shadcn/ui | Matches the exact React+Tailwind+shadcn stack most frontend devs use |
| vercel-react-best-practices | vercel-labs | 345.7K installs on skills.sh (vendor-published) | https://skills.sh (vercel-labs/agent-skills) | Vercel's own React best-practices checklist | Vendor authority on React/Next patterns |
| web-design-guidelines | vercel-labs | 275.3K installs on skills.sh | https://skills.sh (vercel-labs/agent-skills) | Visual and layout guidelines for modern web apps | Pairs with frontend-design for polish |
| shadcn/ui skill | shadcn | Published by shadcn directly; documented in shadcn/ui official docs | https://ui.shadcn.com/docs/skills | Component pattern enforcement for shadcn/ui | shadcn is the most-cited component library in 2025 |
| webapp-testing | anthropics | Anthropic first-party | https://github.com/anthropics/skills/tree/main/skills/webapp-testing | Playwright-driven UI verification for local webapps | Closes the loop on visual correctness |

### Full-stack developer (Next.js / TypeScript)

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| vercel-react-best-practices | vercel-labs | 345.7K installs on skills.sh | https://skills.sh | Vercel-authored Next.js/React patterns | Next.js is Vercel's product, so this is definitive |
| agent-browser | vercel-labs | 209.4K installs on skills.sh | https://skills.sh (vercel-labs/agent-browser) | Browser automation harness for agents | Useful for scraping and e2e against own site |
| Supabase PostgreSQL best practices | (Supabase / community) | Featured on skills.sh | https://skills.sh (search "supabase") | Postgres and Supabase guidance | Supabase is the de-facto full-stack DB tier |
| webapp-testing | anthropics | First-party | https://github.com/anthropics/skills/tree/main/skills/webapp-testing | Playwright e2e | Standard for Next.js e2e |
| superpowers (TDD + git worktrees) | obra (Jesse Vincent) | 166k stars on parent repo; actively released v5.0.7 March 2026 | https://github.com/obra/superpowers | Battle-tested collection: TDD, systematic debugging, git worktrees, writing-plans, executing-plans | General software-engineering hygiene the full-stack dev will use on every feature |
| frontend-design | anthropics | First-party, 332.7K installs | https://github.com/anthropics/skills/tree/main/skills/frontend-design | UI taste and defaults | Full-stack devs need this more than specialist frontend devs because they rarely have a designer |

### Backend developer (Python / Node.js)

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| mcp-builder | anthropics | First-party | https://github.com/anthropics/skills/tree/main/skills/mcp-builder | Build MCP servers that wrap external APIs | Backends increasingly expose MCP surfaces; vendor-authored |
| read-only-postgres | jawwadfirdousi | Featured in awesome-claude-code; signal: listed but star count not shown | https://github.com/hesreallyhim/awesome-claude-code (entry) | Safe PostgreSQL query execution with read-only constraints | Prevents destructive DB actions during exploration |
| superpowers (TDD, debugging, code review) | obra | 166k stars, very active | https://github.com/obra/superpowers | Core TDD and debugging rituals | Language-agnostic, applies to FastAPI, Django, Node |
| Fullstack Dev Skills | jeffallan | 65 skills, author maintains a visible catalog | https://jeffallan.github.io/claude-skills/ | Broad set covering full-stack frameworks incl. backend | Breadth for mixed backends; signal quality medium |
| monitoring-observability | ahmedasmar/devops-claude-skills | 131 stars on parent repo | https://github.com/ahmedasmar/devops-claude-skills | Metrics, alerts, SLOs, dashboards | Backend devs end up owning observability for their services |

Gap: no standout "FastAPI-specific" or "Django-specific" skill with a clear reputation signal turned up. The mcpmarket.com listings exist but have no verifiable star/install counts.

### Mobile developer (iOS / React Native)

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| ios-simulator-skill | conorluddy | 832 stars, v1.4.0 released April 12 2026 | https://github.com/conorluddy/ios-simulator-skill | 22 Python/shell scripts wrapping xcodebuild + simulator with accessibility-API navigation | Removes the biggest iOS agent pain point: noisy xcodebuild output |
| Expo skills (official) | Expo team | 1.8k stars, vendor-published | https://github.com/expo/skills | Official Expo skills: building-ui, data-fetching, deployment, EAS flows | Vendor authority for the dominant RN toolchain |
| vercel-labs React Native skill | vercel-labs | Listed on skills.sh | https://skills.sh (search "react native") | React Native guidance | Cross-references Expo |
| webapp-testing | anthropics | First-party | https://github.com/anthropics/skills/tree/main/skills/webapp-testing | Playwright; applies to RN-web builds | Partial fit — only the web surface of RN |

Gap: no high-reputation native Android/Kotlin skill surfaced. `DroidconKotlin` is mentioned in awesome-claude-code without clear reputation signals. "No high-reputation skill found for native Android/Kotlin" is the honest read.

### DevOps / SRE

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| iac-terraform | ahmedasmar/devops-claude-skills | 131 stars on parent; MIT | https://github.com/ahmedasmar/devops-claude-skills | Terraform + Terragrunt workflows, state inspection | Terraform is still the default IaC per JetBrains 2025 |
| k8s-troubleshooter | ahmedasmar/devops-claude-skills | Same repo, 131 stars | https://github.com/ahmedasmar/devops-claude-skills | Pod/cluster/incident-response playbooks | Structured runbooks beat "ask Claude about k8s" |
| ci-cd | ahmedasmar/devops-claude-skills | Same repo | https://github.com/ahmedasmar/devops-claude-skills | GitHub Actions, GitLab CI patterns | CI/CD is universal |
| gitops-workflows | ahmedasmar/devops-claude-skills | Same repo | https://github.com/ahmedasmar/devops-claude-skills | ArgoCD + Flux + secrets management | Matches modern GitOps adoption |
| aws-cost-optimization | ahmedasmar/devops-claude-skills | Same repo | https://github.com/ahmedasmar/devops-claude-skills | FinOps automation scripts | Underserved area; concrete scripts, not just advice |
| microsoft-foundry / azure-kubernetes / azure-observability | microsoft | Vendor-published; 245.7K installs (microsoft-foundry) on skills.sh | https://skills.sh (microsoft/azure-skills) | Azure-specific infra, observability, cost | Vendor-authoritative for Azure shops |
| devops-skills (Terraform/OpenTofu for AWS) | lgbarn | Signal unclear; awesome-list referenced | https://github.com/lgbarn/devops-skills | Safety-first IaC practices | Alternative to ahmedasmar for AWS-focused teams |

### Data / analytics engineer

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| dbt-agent-skills | dbt-labs | Vendor-published (dbt Labs themselves); referenced in dbt's own developer blog | https://github.com/dbt-labs/dbt-agent-skills | Analytics-engineering workflows: build models, write tests, explore sources, semantic layer, dbt Mesh, troubleshoot jobs | Canonical for dbt work |
| read-only-postgres | jawwadfirdousi | Awesome-list entry; star count not visible | https://github.com/hesreallyhim/awesome-claude-code | Safe Postgres queries | Exploration without destructive writes |
| Altimate Skills (dbt + Snowflake) | altimate | Blog-reported 19% task improvement; signal: vendor blog, not independent | (via altimate.ai blog) | dbt + Snowflake analytics-engineer workflows | Snowflake-specific complement to dbt-labs skills |
| Claude Scientific Skills (data analysis subset) | K-Dense-AI | 19.3k stars, 133 skills, actively released v2.37.1 in April 2026 | https://github.com/K-Dense-AI/claude-scientific-skills | Polars, Dask, GeoPandas, NetworkX, viz (Matplotlib/Seaborn) | Overlaps data engineering when working with large/geospatial data |

### ML engineer

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| Claude Scientific Skills (ML subset) | K-Dense-AI | 19.3k stars, 133 skills, v2.37.1 April 2026 | https://github.com/K-Dense-AI/claude-scientific-skills | PyTorch Lightning, Transformers, scikit-learn, PyMC, Torch Geometric, TimesFM | Broadest ML coverage with clear reputation |
| claude-d3js-skill | chrisvoncsefalvay | Awesome-list entry; signal moderate | https://github.com/chrisvoncsefalvay/claude-d3js-skill | d3.js data visualizations | For model-output visualization |
| mcp-builder | anthropics | First-party | https://github.com/anthropics/skills/tree/main/skills/mcp-builder | MCP server authoring | ML engineers increasingly expose models via MCP |
| superpowers (TDD, systematic-debugging) | obra | 166k stars | https://github.com/obra/superpowers | Engineering discipline: TDD, four-phase debugging | ML code is notoriously under-tested; this rewires habits |

Gap: no standout "PyTorch-specific" or "HuggingFace Transformers-specific" skill with a clear independent reputation signal. Scientific-skills covers it but as part of a larger bundle.

### Systems / Rust engineer

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| rust-skills | actionbook | Signal: GitHub repo, star count not captured | https://github.com/actionbook/rust-skills | Meta-problem-driven Rust knowledge index | Closest to a general Rust coding skill |
| Trail of Bits: constant-time-analysis | trailofbits | 4.8k stars on trailofbits/skills | https://github.com/trailofbits/skills/tree/main/plugins/constant-time-analysis | Detect compiler-induced timing side-channels in crypto code (C/C++/Rust) | High-value for anyone writing crypto primitives |
| Trail of Bits: zeroize-audit | trailofbits | Same repo, 4.8k stars | https://github.com/trailofbits/skills/tree/main/plugins/zeroize-audit | Detect missing/eliminated zeroization of secrets in C/C++/Rust | Systems engineers handling secrets |
| Trail of Bits: static-analysis | trailofbits | Same repo | https://github.com/trailofbits/skills/tree/main/plugins/static-analysis | CodeQL + Semgrep + SARIF toolkit | Language-agnostic, essential for systems work |
| superpowers (debugging, code review) | obra | 166k stars | https://github.com/obra/superpowers | Systematic debugging, verification-before-completion | Rust is compiler-tight but runtime bugs still need structure |

Gap: no vendor-published "Rust Foundation" skill. rust-skills/actionbook and various mcpmarket.com listings exist but star counts are low or not clearly shown. Treat this category as "one solid community skill plus Trail of Bits for crypto-adjacent work".

### Smart contract / Web3 developer

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| building-secure-contracts | trailofbits | 4.8k stars on parent repo; Trail of Bits is the reference auditor in the space | https://github.com/trailofbits/skills/tree/main/plugins/building-secure-contracts | Smart-contract vulnerability scanners for 6 chains | Highest-reputation Web3 security skill available |
| entry-point-analyzer | trailofbits | Same repo | https://github.com/trailofbits/skills/tree/main/plugins/entry-point-analyzer | Identify state-changing entry points for audit | Pairs with building-secure-contracts |
| Claude-Solidity-Skills (test-foundry, test-hardhat, gas-optimize, audit) | max-taylor | 3 stars (low reputation); useful feature set | https://github.com/max-taylor/Claude-Solidity-Skills | Hardhat + Foundry test generation, gas optimization, 115-item audit checklist with SWC + weird-ERC20 | Best-scoped Foundry/Hardhat test-gen skill found; low stars mean treat as "use with review" |
| AVS Vibe Developer Guide | Layr-Labs | Vendor-published by EigenLayer; signal moderate | https://github.com/hesreallyhim/awesome-claude-code (entry) | EigenLayer AVS development workflow | Only relevant for AVS/restaking developers |

Gap: the high-install skills on skills.sh skew toward web/design/cloud and do not cover Solidity. Web3 remains a long-tail category. The operator should probably sponsor or curate a Foundry skill rather than rely on the 3-star community version.

### Security / AppSec engineer

| Skill | Author | Reputation | Link | Description | Fit |
|---|---|---|---|---|---|
| Trail of Bits Security Skills (whole suite) | trailofbits | 4.8k stars; Trail of Bits is a top-tier security firm | https://github.com/trailofbits/skills | 15+ skills: static-analysis, semgrep-rule-creator, insecure-defaults, sharp-edges, supply-chain-risk-auditor, differential-review, fp-check, agentic-actions-auditor, yara-authoring, burpsuite-project-parser | Best single source for AppSec skills |
| ffuf-web-fuzzing | jthack | 147 stars; defensive-only framing | https://github.com/jthack/ffuf_claude_skill | ffuf-driven web fuzzing for dir/subdomain/API discovery | Standard web pentest primitive |
| security-review (built-in) | anthropics | First-party Claude Code command | Anthropic Claude Code docs | PR-level security review of pending changes | Already on the platform, low-effort default |
| Dippy (safe-bash-AST) | Lily Dayton | Awesome-list entry; signal moderate | https://github.com/hesreallyhim/awesome-claude-code (entry) | AST-based approval of bash commands | Reduces blast radius of agent tool calls |
| superpowers (systematic-debugging, code review) | obra | 166k stars | https://github.com/obra/superpowers | Rigorous review and debugging discipline | Reviewers need structured workflows |

## Open questions / gaps

- **Native Android / Kotlin**: no high-reputation skill surfaced. `DroidconKotlin` is in the awesome-list but without clear stars/installs. Recommend flagging this as a template the operator may want to commission.
- **Specific Python web frameworks (FastAPI, Django)**: high-reputation skill was not found. Generic backend skills cover it, but a framework-specific skill with strong reputation seems to be missing from the market.
- **PyTorch-specific**: K-Dense-AI's scientific-skills covers PyTorch inside a 133-skill bundle. There is no top-tier standalone PyTorch skill. For an ML-engineer template this is acceptable but worth noting.
- **Solidity / Foundry**: only one community skill (max-taylor, 3 stars) directly targets Foundry/Hardhat test generation. Trail of Bits covers audit side well but not the day-to-day dev loop. This is a real gap.
- **Rust general coding**: actionbook/rust-skills exists but did not surface a star count in the fetched page. Treat as medium-reputation pending manual inspection.
- **skills.sh categorization**: the leaderboard has no category filter visible. Navigation is by publisher or trending/hot/all-time. Finding DevOps/security/blockchain skills required GitHub search. If the operator plans to use skills.sh programmatically, plan for search-driven discovery, not category browsing.
- **Install-count vs quality**: skills.sh install counts lean heavily toward first-party publishers (Vercel, Microsoft, Anthropic). This does not mean community skills are low-quality, but it does mean install count alone is a biased proxy for reputation.
- **Last-commit recency**: I captured recent release dates where visible (superpowers v5.0.7 March 2026, ios-simulator-skill v1.4.0 April 2026, scientific-skills v2.37.1 April 2026). For others (trailofbits/skills, ahmedasmar/devops-claude-skills) the last-commit date was not surfaced in the fetched content. Operator should verify before committing to a template.

## Sources

Popularity data (avatars):

- Stack Overflow Developer Survey 2025 — https://survey.stackoverflow.co/2025
- Stack Overflow Developer Survey 2025: Technology — https://survey.stackoverflow.co/2025/technology/
- JetBrains State of Developer Ecosystem 2025 — https://devecosystem-2025.jetbrains.com/
- JetBrains SoDE 2025 blog announcement — https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/
- GitHub Octoverse 2025 — https://octoverse.github.com/
- GitHub Octoverse 2025 blog — https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/

Skills sources:

- skills.sh leaderboard — https://skills.sh/
- Anthropic first-party skills — https://github.com/anthropics/skills (123k stars)
- Awesome Claude Code (hesreallyhim) — https://github.com/hesreallyhim/awesome-claude-code (11.7k stars)
- Awesome Claude Skills (travisvn) — https://github.com/travisvn/awesome-claude-skills
- Awesome Claude Code Subagents (VoltAgent) — https://github.com/VoltAgent/awesome-claude-code-subagents (18.2k stars)
- Superpowers (obra) — https://github.com/obra/superpowers (166k stars)
- Trail of Bits skills — https://github.com/trailofbits/skills (4.8k stars)
- dbt-labs/dbt-agent-skills — https://github.com/dbt-labs/dbt-agent-skills
- Expo skills — https://github.com/expo/skills (1.8k stars)
- K-Dense-AI scientific skills — https://github.com/K-Dense-AI/claude-scientific-skills (19.3k stars)
- ahmedasmar/devops-claude-skills — https://github.com/ahmedasmar/devops-claude-skills (131 stars)
- conorluddy/ios-simulator-skill — https://github.com/conorluddy/ios-simulator-skill (832 stars)
- jthack/ffuf_claude_skill — https://github.com/jthack/ffuf_claude_skill (147 stars)
- max-taylor/Claude-Solidity-Skills — https://github.com/max-taylor/Claude-Solidity-Skills (3 stars)
- shadcn/ui skills docs — https://ui.shadcn.com/docs/skills
- jeffallan claude-skills catalog — https://jeffallan.github.io/claude-skills/

## Round 2

Second-pass research date: 2026-04-23. Repo metadata was pulled from the GitHub REST API where accessible (unauthenticated). Stars, pushed-at timestamps, and SPDX licenses below are as-of that fetch unless otherwise noted.

### 2.1 Gap re-attack

Round 1 flagged four gaps. Second-pass vectors used: GitHub topic search, `pushed:>2026-01-01` recency filter, awesome-list entries, Anthropic ecosystem blogs, and HuggingFace's own skill marketplace.

#### Gap A — Native Android / Kotlin / Jetpack Compose
Status: **gap closed.** Several credible repos emerged on the second pass.

| Repo | Stars | Last pushed | License | Notes |
|---|---|---|---|---|
| aldefy/compose-skill | 409 | 2026-04-15 | NOASSERTION (custom) | Single `compose-expert` skill with androidx source-code receipts; author maintains actively |
| dpconde/claude-android-skill | 184 | 2025-12-07 | MIT | One skill, based on Google's NowInAndroid reference architecture; no commits in ~4.5 months — borderline stale |
| hamen/compose_skill | 195 | 2026-04-22 | none (unlicensed) | Strict, evidence-based Compose audit skill; very recent commits but no LICENSE file means unclear redistribution |
| new-silvermoon/awesome-android-agent-skills | 754 | 2026-03-28 | Apache-2.0 | Curated list/guide; not a skills pack itself — links to .github/skills/ in the reader's own project layout |
| Drjacky/claude-android-ninja | 45 | 2026-04-19 | MIT (per repo file) | Comprehensive: Compose, Hilt, Room 3, Paging 3, Navigation3, DataStore, Gradle, testing, i18n, crashlytics, StrictMode, Detekt — broadest coverage found |

Pick for the template: **aldefy/compose-skill** (409 stars, most active, focused) plus **Drjacky/claude-android-ninja** (broadest architectural coverage, MIT). aldefy's "NOASSERTION" license means the operator should read the LICENSE file manually before redistributing.

#### Gap B — FastAPI / Django-specific Python web frameworks
Status: **gap closed.** `Jeffallan/claude-skills` (8.5k stars, MIT, pushed 2026-04-21) contains standalone `fastapi-expert`, `django-expert`, `nestjs-expert`, `spring-boot-engineer`, `rails-expert`, `laravel-specialist`, and 60+ other framework specialists. Verified first-hand: `skills/fastapi-expert/SKILL.md` covers Pydantic V2, async SQLAlchemy, JWT, WebSockets, OpenAPI. `skills/django-expert/SKILL.md` covers DRF, ORM optimization, JWT, admin customization.

Alternative: `kjnez/claude-code-django` (123 stars, MIT, pushed 2026-03-20) is Django-only with 15 skills covering models, forms, HTMX, Celery — more focused if the project is Django-pure.

#### Gap C — Standalone PyTorch / HuggingFace Transformers
Status: **gap closed by vendor.** `huggingface/skills` (10.3k stars, Apache-2.0, pushed 2026-04-23) is the official HuggingFace skill pack. Skills include `huggingface-llm-trainer` (TRL SFT/DPO/GRPO training on HF Jobs, no local GPU needed), `huggingface-vision-trainer`, `huggingface-local-models`, `huggingface-datasets`, `huggingface-gradio`, `huggingface-paper-publisher`, `huggingface-tool-builder`, `huggingface-trackio`, `huggingface-community-evals`, `huggingface-best`, `hf-cli`, `transformers-js`, `huggingface-papers`. This is vendor-authored and displaces the scientific-skills bundle for ML-engineer templates where the focus is model training and deployment rather than research tooling.

Secondary: `Orchestra-Research/AI-research-SKILLs` (7.3k stars, MIT) has 22 topic-indexed research skills (fine-tuning, RLHF, interpretability, distributed training, MLOps, evaluation, RAG, multimodal). Good complement for research-heavy ML engineers.

#### Gap D — General-purpose Foundry / Solidity
Status: **still a gap.** No new repo passed the >50 stars + ≤90-day activity filter for day-to-day Solidity/Foundry development (test gen, local dev, deploy). `max-taylor/Claude-Solidity-Skills` remains at 3 stars (unchanged, last push 2026-02-19). `sangrokjung/claude-forge` (660 stars, MIT, pushed 2026-04-24) is a general "oh-my-zsh for Claude Code" plugin framework, not Solidity-specific. Trail of Bits's `building-secure-contracts` covers the audit surface but not the dev loop.

Two shortlist candidates the operator could fork:
1. **max-taylor/Claude-Solidity-Skills** — small (3 stars) but already encodes Hardhat + Foundry test generation, gas optimization with 7 categories, and a 115-item audit checklist tagged to SWC vulnerability IDs. Cleanest starting point despite low stars. No LICENSE file — operator would need to contact the author or fork under a permissive license of their choosing.
2. **trailofbits/skills `building-secure-contracts` subfolder** — has 11 vulnerability-scanner skills across Algorand, Cairo, Cosmos, Solana, Substrate, TON, plus audit-prep-assistant, code-maturity-assessor, guidelines-advisor, secure-workflow-guide, token-integration-analyzer. CC-BY-SA-4.0. Operator could fork the subfolder and layer day-to-day dev skills (forge test gen, deploy scripts) on top.

Recommendation: commission or fork. Solidity remains the clearest template-bootstrapping opportunity for the operator.

### 2.2 Vendor pack internals

Inspected by fetching directory listings and sampling SKILL.md frontmatter directly.

#### dbt-labs/dbt-agent-skills (428 stars, Apache-2.0, pushed 2026-04-23)
Nine skills in `skills/dbt/skills/`, plus `dbt-extras` and `dbt-migration` subpacks.
- `using-dbt-for-analytics-engineering` — core skill. Frontmatter declares `allowed-tools: "Bash(dbt *), Bash(jq *), Read, Write, Edit, Glob, Grep"`. Behavior change: enforces DRY ("Before adding a new model, always check if the same logic is defined elsewhere"), ref()/source() over hardcoded names, CTEs over subqueries, YAML doc reading before modification. Includes 7 reference guides (planning, discovering-data, writing-tests, debugging, impact-evaluation, docs, packages).
- `running-dbt-commands` — scopes `dbt` CLI invocations. Explicit rules: always `dbt build` instead of `dbt run`, always `--quiet` + `--warn-error-options` for selector-typo catching, always `--select`. Differentiates between dbt Core, dbt Fusion, and dbt Cloud CLI.
- `adding-dbt-unit-test` — unit-test authoring workflow.
- `answering-natural-language-questions-with-dbt` — semantic-layer queries.
- `building-dbt-semantic-layer` — MetricFlow metrics, dimensions, semantic models.
- `configuring-dbt-mcp-server` — setup of the dbt MCP surface.
- `fetching-dbt-docs` — pull live docs into context.
- `troubleshooting-dbt-job-errors` — dbt Cloud job failure diagnosis.
- `working-with-dbt-mesh` — multi-project refs, model governance.

Surface area of behavior change: forces software-engineering discipline on SQL work (DRY, CTEs, testing), changes default from `dbt run` to `dbt build`, teaches the agent the difference between three dbt CLIs and when to escalate to human. Frontmatter `user-invocable: false` means skills activate from prompt match, not slash command.

#### expo/skills (1.78k stars, MIT, pushed 2026-04-23)
Thirteen skills under `plugins/expo/skills/`.
- `building-native-ui` — the core Expo Router + UI skill. Consults 15 reference files (animations, controls, form-sheet, gradients, icons, media, route-structure, search, storage, tabs, toolbar-and-headers, visual-effects, webgpu-three, zoom-transitions). Behavior rule: "Always try Expo Go first before creating custom builds" — prevents unnecessary native-build overhead.
- `expo-ui-jetpack-compose` and `expo-ui-swift-ui` — native-UI bridging.
- `native-data-fetching` — RN-idiomatic fetch patterns.
- `expo-api-routes` — serverless API routes inside Expo.
- `expo-cicd-workflows` — EAS build/submit CI patterns.
- `expo-deployment` and `eas-update-insights` — production deploy + OTA update monitoring.
- `expo-dev-client` — custom dev client setup.
- `expo-module` — authoring native modules.
- `expo-tailwind-setup` — NativeWind / Tailwind integration.
- `upgrading-expo` — SDK upgrade playbook.
- `use-dom` — DOM components in RN.

Surface area: covers the entire Expo dev lifecycle (start → UI → API → CI/CD → deploy → update → upgrade). Very complete; operator can adopt as a single bundle.

#### trailofbits/skills (4.77k stars, CC-BY-SA-4.0, pushed 2026-04-24)
Thirty-eight plugins at top level. Key subpacks:
- **building-secure-contracts** (plugin) contains 11 sub-skills: `algorand-vulnerability-scanner`, `audit-prep-assistant`, `cairo-vulnerability-scanner`, `code-maturity-assessor`, `cosmos-vulnerability-scanner`, `guidelines-advisor`, `secure-workflow-guide`, `solana-vulnerability-scanner`, `substrate-vulnerability-scanner`, `token-integration-analyzer`, `ton-vulnerability-scanner`. Sampled `audit-prep-assistant/SKILL.md`: structured 1-2 week preparation workflow with goal-setting, static analysis, coverage, dead code, accessibility, documentation generation (flowcharts, user stories, inline comments).
- **static-analysis** (plugin) contains `codeql`, `sarif-parsing`, `semgrep` sub-skills. Sampled `semgrep/SKILL.md`: declares `allowed-tools: Bash, Read, Glob, Task, AskUserQuestion, TaskCreate/List/Update`. Behavior rules: always `--metrics=off` (prevents telemetry during audits), hard gate on user approval of scan plan, mandates third-party rulesets (Trail of Bits, 0xdea, Decurity) beyond the official registry. Spawns parallel Task subagents for multi-language codebases.
- Other high-signal plugins: `semgrep-rule-creator`, `insecure-defaults`, `sharp-edges`, `supply-chain-risk-auditor`, `differential-review`, `agentic-actions-auditor`, `constant-time-analysis`, `zeroize-audit`, `yara-authoring`, `burpsuite-project-parser`, `firebase-apk-scanner`, `mutation-testing`, `property-based-testing`, `dwarf-expert`, `variant-analysis`, `spec-to-code-compliance`, `fp-check` (false-positive verification), `trailmark`.

Surface area: this is the single largest professional security-audit pack on GitHub. CC-BY-SA-4.0 is **important for redistribution**: derivative works must use the same license and attribute Trail of Bits. Operator cannot relicense as MIT.

#### vercel-labs/agent-skills (25.6k stars, MIT, pushed 2026-04-20)
Six skills at top level in `skills/`.
- `react-best-practices` — 70 rules across 8 priority categories: eliminating waterfalls (CRITICAL), bundle size (CRITICAL), server-side performance, client-side data fetching, re-render optimization, rendering, JS performance, advanced patterns. Frontmatter declares `author: vercel`. Behavior change: refactoring/generation trigger on any React/Next.js file.
- `web-design-guidelines` — 100+ rules for accessibility, performance, UX.
- `react-native-guidelines` — 16 rules across 7 sections.
- `react-view-transitions` — View Transitions API + Next.js.
- `composition-patterns` — React component architecture (prop proliferation, inversion).
- `deploy-to-vercel` — deploys preview by default, runs `git remote`, `.vercel/project.json`, `vercel whoami`, `vercel teams list` as checks. Tries to move user into "linked-to-Vercel with git-push deploys" state.

Surface area: primarily opinionated rule catalogs plus one deploy workflow. All six are MIT and cleanly redistributable.

#### obra/superpowers (166k stars, MIT, pushed 2026-04-24)
Fourteen skills in `skills/`. Inspected two key ones.
- `test-driven-development` — **The Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.** If code is written before test, delete it. Explicit exceptions require asking the human. The skill is short and rule-based, not reference-heavy.
- `systematic-debugging` — **Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.** Four-phase workflow. Applies to test failures, prod bugs, perf issues, build failures. Specifically warns against time-pressure rationalization.
- Full skill list: `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`.

Surface area: behavioral, not technical. No tool exposure. These skills change the agent's process discipline — when it's allowed to write code, when it must get review, how it tracks work, how it moves between subagents. Directly complementary to any language-specific skill.

### 2.3 Minimum viable stack per avatar

Top 2-4 starter skills per avatar, ranked. Rationale explains why each is in the starter set vs the long tail.

**Frontend (React / TypeScript)**
1. `vercel-labs/agent-skills/react-best-practices` — vendor-owned, 70 prioritized rules, covers the exact React/Next.js scope most frontend devs use.
2. `anthropics/skills/frontend-design` — Anthropic-authored taste/direction skill, prevents generic AI UI output.
3. `anthropics/skills/webapp-testing` — Playwright loop, closes the verification gap.
4. `vercel-labs/agent-skills/composition-patterns` — prop-proliferation and inversion patterns; underappreciated but high-value.

**Full-stack (Next.js / TypeScript)**
1. `vercel-labs/agent-skills/react-best-practices` — Next.js is Vercel's product, this is canonical.
2. `vercel-labs/agent-skills/deploy-to-vercel` — removes the deploy-to-prod friction.
3. `obra/superpowers/test-driven-development` + `systematic-debugging` — full-stack devs do both frontend and backend work; process discipline pays off across both.
4. `anthropics/skills/frontend-design` — full-stack devs rarely have a designer.

**Backend (Python / Node.js)**
1. `Jeffallan/claude-skills/fastapi-expert` OR `django-expert` (pick by stack) — framework-specific with clear rules and Pydantic V2 / DRF patterns.
2. `anthropics/skills/mcp-builder` — increasingly, backends expose MCP surfaces; vendor-authored.
3. `obra/superpowers/test-driven-development` + `systematic-debugging` — language-agnostic process discipline.
4. `ahmedasmar/devops-claude-skills/monitoring-observability` — backend devs end up owning observability.

**Mobile (iOS / React Native)**
1. For iOS: `conorluddy/ios-simulator-skill` — 22 scripts wrapping xcodebuild + simctl + accessibility APIs.
2. For RN: `expo/skills` (adopt as a whole bundle) — vendor-owned, covers full lifecycle.
3. `Drjacky/claude-android-ninja` — if the team also does native Android; broadest Kotlin/Compose coverage.
4. `obra/superpowers/test-driven-development` — mobile code is historically under-tested.

**DevOps / SRE**
1. `ahmedasmar/devops-claude-skills/iac-terraform` — Terraform is still the default IaC.
2. `ahmedasmar/devops-claude-skills/k8s-troubleshooter` — structured runbooks beat generic k8s advice.
3. `ahmedasmar/devops-claude-skills/ci-cd` — universal.
4. `trailofbits/skills/agentic-actions-auditor` — audits GitHub Actions for agent-specific vulns; underappreciated in DevOps bundles.

**Data / analytics engineer**
1. `dbt-labs/dbt-agent-skills` (adopt the whole pack) — vendor-owned, nine skills covering the entire dbt workflow.
2. `obra/superpowers/test-driven-development` — analytics engineers historically skip testing; this flips the default.
3. `anthropics/skills/xlsx` — for stakeholder deliverables outside the warehouse.

**ML engineer**
1. `huggingface/skills/huggingface-llm-trainer` — vendor-owned, TRL-based training on HF Jobs without local GPU.
2. `huggingface/skills/huggingface-vision-trainer` or `huggingface-datasets` — depending on modality.
3. `Orchestra-Research/AI-research-SKILLs` (selective install: fine-tuning, evaluation, distributed-training) — research-grade complement to the HF training skills.
4. `obra/superpowers/systematic-debugging` — ML bugs are notoriously slippery; root-cause discipline helps.

**Systems / Rust**
1. `actionbook/rust-skills` — 1056 stars, active, three-layer meta-cognition framework, covers idiomatic Rust + ownership + unsafe checking.
2. `trailofbits/skills/constant-time-analysis` + `zeroize-audit` — high-value when Rust touches crypto or secrets.
3. `obra/superpowers/systematic-debugging` — Rust's borrow checker catches some bugs but runtime issues (async deadlocks, unsafe, FFI) need process.

**Smart contract / Web3**
1. `trailofbits/skills/building-secure-contracts` — 11 chain-specific vulnerability scanners + audit prep + token integration analysis. This is the highest-reputation Web3 skill available.
2. `trailofbits/skills/entry-point-analyzer` — pairs directly with #1.
3. `max-taylor/Claude-Solidity-Skills` (with caveats) — only Foundry/Hardhat test generation skill found; 3 stars, no LICENSE; use with review.
4. `obra/superpowers/test-driven-development` — critical for smart contracts where deployment is irreversible.

**Security / AppSec**
1. `trailofbits/skills/static-analysis` (includes codeql, sarif-parsing, semgrep) — industry-standard tooling wrapped with hard gates (approval before scan, metrics-off).
2. `trailofbits/skills/insecure-defaults` + `sharp-edges` + `supply-chain-risk-auditor` — the triage trio.
3. `trailofbits/skills/differential-review` — PR-level security review with git-history analysis.
4. `jthack/ffuf_claude_skill` — web fuzzing for active testing (with permission).

### 2.4 License audit for minimum viable stacks

| Skill | License | Redistribution notes |
|---|---|---|
| anthropics/skills (frontend-design, webapp-testing, mcp-builder, xlsx) | Source-available, NOT open source (docx/pdf/pptx/xlsx are explicitly source-available; others ship with `license: Complete terms in LICENSE.txt` in frontmatter, no LICENSE file at repo root) | Operator **cannot** redistribute as part of a product without checking Anthropic's terms. Safe for internal agent use. Flag for legal. |
| vercel-labs/agent-skills (all 6 skills) | MIT | Clean. Redistribute freely with attribution. |
| obra/superpowers (all 14 skills) | MIT | Clean. |
| dbt-labs/dbt-agent-skills (all 9+ skills) | Apache-2.0 | Clean. Attribution and NOTICE file preservation required. |
| expo/skills (all 13 skills) | MIT | Clean. |
| huggingface/skills (all 13 skills) | Apache-2.0 | Clean. |
| trailofbits/skills (all 38 plugins) | **CC-BY-SA-4.0** | **Viral license.** Derivative works must be CC-BY-SA-4.0 and attribute Trail of Bits. Cannot relicense as MIT. Operator must decide if template distribution under CC-BY-SA-4.0 is acceptable. |
| Jeffallan/claude-skills (fastapi-expert, django-expert) | MIT | Clean. |
| kjnez/claude-code-django | MIT | Clean. |
| ahmedasmar/devops-claude-skills (all 6 skills) | MIT | Clean. |
| conorluddy/ios-simulator-skill | MIT | Clean. |
| Drjacky/claude-android-ninja | MIT | Clean. |
| aldefy/compose-skill | NOASSERTION (custom terms; needs manual read) | **Flag.** GitHub couldn't classify the LICENSE. Operator must read before bundling. |
| hamen/compose_skill | **No LICENSE file** | **Flag.** Unlicensed content is "all rights reserved" by default. Do not redistribute without contacting author. |
| actionbook/rust-skills | MIT (per README badge; no LICENSE file at repo root as of last fetch) | **Flag.** Badge claims MIT but LICENSE fetch returned 404. Verify manually before redistribution. |
| max-taylor/Claude-Solidity-Skills | **No LICENSE file** | **Flag.** Same "all rights reserved" issue. Fork only after contacting author. |
| Orchestra-Research/AI-research-SKILLs | MIT | Clean. |
| K-Dense-AI/claude-scientific-skills | MIT (repo-level), but individual skills may carry their own license | Read per-skill SKILL.md before redistribution. |
| jthack/ffuf_claude_skill | MIT (per README; LICENSE file not directly verified in fetch) | Verify before redistribution. |

**Three license hot-spots** the operator must decide before shipping templates:
1. **Anthropic skills** are source-available; if the operator's id-agents templates are public/commercial, get legal review.
2. **Trail of Bits skills (CC-BY-SA-4.0)** force the entire derived template to be CC-BY-SA-4.0 if bundled.
3. **Unlicensed community skills** (hamen/compose_skill, max-taylor/Claude-Solidity-Skills) cannot be safely redistributed.

### 2.5 Freshness re-check

Every minimum-viable-stack skill, with the last `pushed_at` fetched from GitHub API. Stale threshold = 180 days before 2026-04-23 = before 2025-10-25.

| Skill / repo | Last pushed | Status |
|---|---|---|
| anthropics/skills | 2026-04-23 | fresh |
| vercel-labs/agent-skills | 2026-04-20 | fresh |
| obra/superpowers | 2026-04-24 | fresh |
| dbt-labs/dbt-agent-skills | 2026-04-23 | fresh |
| expo/skills | 2026-04-23 | fresh |
| huggingface/skills | 2026-04-23 | fresh |
| trailofbits/skills | 2026-04-24 | fresh |
| Jeffallan/claude-skills | 2026-04-21 | fresh |
| kjnez/claude-code-django | 2026-03-20 | fresh |
| ahmedasmar/devops-claude-skills | 2026-04-11 | fresh |
| conorluddy/ios-simulator-skill | 2026-04-17 | fresh |
| Drjacky/claude-android-ninja | 2026-04-19 | fresh |
| aldefy/compose-skill | 2026-04-15 | fresh |
| actionbook/rust-skills | 2026-03-21 | fresh |
| Orchestra-Research/AI-research-SKILLs | 2026-04-13 | fresh |
| max-taylor/Claude-Solidity-Skills | 2026-02-19 | fresh (~64 days) |
| jthack/ffuf_claude_skill | **2025-10-16** | **STALE — verify before use (≈190 days since last push)** |
| lackeyjb/playwright-skill | **2025-12-19** | fresh but borderline (~125 days) — monitor |
| chrisvoncsefalvay/claude-d3js-skill | **2025-10-18** | **STALE — verify before use (~188 days)** |
| dpconde/claude-android-skill | **2025-12-07** | fresh but borderline (~137 days) — monitor |
| K-Dense-AI/claude-scientific-skills | unable to fetch via API (rate-limited); WebFetch reports v2.37.1 released 2026-04-13 | assume fresh, re-verify |

Two skills in the extended catalog are explicitly stale: **jthack/ffuf_claude_skill** (Gap D security tool) and **chrisvoncsefalvay/claude-d3js-skill** (long-tail visualization). Neither is in a minimum-viable stack, but both appear in the Round 1 tables — flag before templating.

### 2.6 Sources added in Round 2

- huggingface/skills — https://github.com/huggingface/skills (10.3k stars, Apache-2.0)
- Orchestra-Research/AI-research-SKILLs — https://github.com/Orchestra-Research/AI-research-SKILLs (7.3k stars, MIT)
- Jeffallan/claude-skills — https://github.com/Jeffallan/claude-skills (8.5k stars, MIT)
- kjnez/claude-code-django — https://github.com/kjnez/claude-code-django (123 stars, MIT)
- Drjacky/claude-android-ninja — https://github.com/Drjacky/claude-android-ninja (45 stars, MIT)
- aldefy/compose-skill — https://github.com/aldefy/compose-skill (409 stars, NOASSERTION)
- dpconde/claude-android-skill — https://github.com/dpconde/claude-android-skill (184 stars, MIT)
- hamen/compose_skill — https://github.com/hamen/compose_skill (195 stars, unlicensed)
- new-silvermoon/awesome-android-agent-skills — https://github.com/new-silvermoon/awesome-android-agent-skills (754 stars, Apache-2.0)
- actionbook/rust-skills — https://github.com/actionbook/rust-skills (1056 stars, claims MIT)
- sangrokjung/claude-forge — https://github.com/sangrokjung/claude-forge (660 stars, MIT) — noted but not a Solidity-specific solution
- vercel-labs/agent-skills — https://github.com/vercel-labs/agent-skills (25.6k stars, MIT)
