# public-agent

Standalone public-facing REST-AP agent, shipped as a single Docker container. See `SKILL.md` for the agent's endpoint contract and human-oriented overview.

## Why this exists

The rest of id-agents is optimised for a trusted local team. `public-agent/` is the one piece of the system that is expected to be reachable from outside that boundary. It:

- serves a synchronous `/talk` over OpenRouter,
- accepts notifications from trusted callers (your local team) on `/news`,
- logs every external message into an inbox for human review,
- never initiates outbound traffic except the OpenRouter chat-completion call.

## Requirements

- Docker or Docker-compatible runtime (Docker Desktop, Podman, or [Colima](https://github.com/abiosoft/colima) on macOS).
- An [OpenRouter](https://openrouter.ai) API key.

## Colima on macOS

If you use Colima as your Docker backend:

```bash
brew install colima docker docker-compose
colima start                    # defaults are fine for v1
docker context use colima       # make colima the active Docker context
```

Verify:

```bash
docker context ls | grep '*'    # should show "colima"
docker info >/dev/null && echo ok
```

On Linux or Docker Desktop, skip the Colima step — any working Docker daemon will do.

## Setup

From this directory:

```bash
cp .env.example .env
# edit .env, at minimum set OPENROUTER_API_KEY and OPENROUTER_MODEL
```

Env vars (see `.env.example` for the canonical list):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | — | OpenRouter key for `/talk` |
| `OPENROUTER_MODEL` | yes | `openai/gpt-4o-mini` | Model slug passed to OpenRouter |
| `PUBLIC_AGENT_PORT` | no | `4200` | Host + container listen port |
| `PUBLIC_AGENT_NAME` | no | `public-agent` | Name advertised in catalog + logs |
| `PUBLIC_AGENT_AUTH_KEY` | no | unset | Shared bearer; if unset every endpoint is open |
| `MAX_TOKENS_PER_DAY` | no | `100000` | Daily LLM-token ceiling; `0` disables |
| `TALK_RATE_LIMIT_PER_MIN` | no | `10` | Per-IP cap on `POST /talk`; `0` disables |

## Run

```bash
docker compose up --build
```

Smoke test (replace `$PORT` with your `PUBLIC_AGENT_PORT`):

```bash
curl -s http://127.0.0.1:$PORT/healthz
curl -s http://127.0.0.1:$PORT/.well-known/skill.md | head -20
curl -s http://127.0.0.1:$PORT/.well-known/restap.json | jq .
```

## Development without Docker

```bash
npm install
cp .env.example .env    # then edit
PUBLIC_AGENT_DATA_DIR=./data npm run dev
```

`npm run dev` uses `tsx watch` for hot reload. Set `PUBLIC_AGENT_DATA_DIR=./data` so inbox/news writes land in the repo checkout instead of `/app/data`.

## Files that matter

```
public-agent/
├── Dockerfile                # multi-stage build; final stage runs as node user
├── docker-compose.yml        # single service; mounts ./data for persistence
├── SKILL.md                  # human + LLM-facing description (served at /.well-known/skill.md)
├── src/
│   ├── server.ts             # entrypoint
│   ├── env.ts                # env-var loader + validator
│   ├── catalog.ts            # REST-AP catalog builder
│   ├── routes/               # one file per logical surface
│   └── lib/                  # openrouter, inbox, news-log, auth, rate-limit, budget
└── data/                     # mounted volume (inbox/, news.log, budget.json)
```
