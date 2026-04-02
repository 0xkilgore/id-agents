# Agent Harnesses Reference

Harnesses are pluggable LLM execution backends that allow ID Agents to use different AI coding tools. Each harness wraps a specific CLI or SDK and produces a unified message format for REST-AP compatibility.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Server                              │
│                  (claude-agent-server.ts)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │    Harness Factory    │
              │   createHarness(type) │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
      ┌───────────────┐       ┌───────────────┐
      │ Claude Agent  │       │  Claude Code  │
      │  SDK Harness  │       │  CLI Harness  │
      └───────────────┘       └───────────────┘
              │                       │
              ▼                       ▼
      ┌───────────────┐       ┌───────────────┐
      │ Claude Agent  │       │  Claude Code  │
      │     SDK       │       │     CLI       │
      └───────────────┘       └───────────────┘
```

All harnesses produce `HarnessMessage` objects that map to REST-AP responses.

## Available Harnesses

| Harness | CLI/SDK | Provider | Use Case |
|---------|---------|----------|----------|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic | Primary runtime, full tool access (uses ANTHROPIC_API_KEY) |
| `claude-code-cli` | Claude Code CLI | Anthropic | Uses Max plan subscription |

## Claude Agent SDK Harness

The primary harness using Anthropic's official Claude Agent SDK.

### Features

- Full tool access (file operations, bash, etc.)
- Session persistence and resumption
- Plugin support for extensibility
- Permission management

### Models

```typescript
const CLAUDE_MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',   // Fast, efficient
  SONNET: 'claude-sonnet-4-20250514',   // Balanced
  OPUS: 'claude-opus-4-20250514'        // Most capable
};
```

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: claude-agent-sdk
    model: claude-sonnet-4-20250514
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `CLAUDE_MODEL` | No | Default model override |

### Plugin Support

The Claude Agent SDK harness supports plugins:

```yaml
agents:
  - name: my-agent
    runtime: claude-agent-sdk
    skills: [identity, inter-agent, catalog]
```

Skills are deployed to the agent's `.claude/skills/` directory at deploy time.

---

## Claude Code CLI Harness

Uses the Claude Code CLI as a harness. This runtime uses your Max plan subscription instead of an API key.

### Features

- Uses Max plan subscription (no ANTHROPIC_API_KEY needed)
- Session persistence
- Full tool access

### Configuration

```yaml
agents:
  - name: my-agent
    runtime: claude-code-cli
```

---

## Harness Interface

All harnesses implement the `AgentHarness` interface:

```typescript
interface AgentHarness {
  readonly type: HarnessType;

  run(
    prompt: string,
    options: HarnessOptions
  ): AsyncGenerator<HarnessMessage>;
}

type HarnessType = 'claude-agent-sdk' | 'claude-code-cli';

interface HarnessOptions {
  model?: string;
  workingDirectory?: string;
  plugins?: PluginConfig[];
  allowedTools?: string[];
  resume?: string;
  env?: Record<string, string | undefined>;
}
```

## Message Format

All harnesses produce unified `HarnessMessage` objects:

```typescript
interface HarnessMessage {
  type: 'system' | 'tool_use' | 'result' | 'error' | 'progress' | 'thinking';
  subtype?: string;
  content?: string;
  result?: string;
  session_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
}
```

### Message Types

| Type | Description |
|------|-------------|
| `system` | System messages (init, status) |
| `tool_use` | Tool invocation notification |
| `result` | Final result from the agent |
| `error` | Error message |
| `progress` | Progress update |
| `thinking` | Agent reasoning (if available) |

---

## Usage

### Specifying Runtime

**Via CLI:**
```bash
/deploy local-agent my-agent
```

**Via YAML Config:**
```yaml
defaults:
  runtime: claude-agent-sdk

agents:
  - name: agent-a
    runtime: claude-agent-sdk
  - name: agent-b
    runtime: claude-code-cli
```

**Via Remote API:**
```bash
curl -X POST http://localhost:4100/remote \
  -H "Content-Type: application/json" \
  -d '{"command": "/deploy local-agent my-agent"}'
```

### Checking Available Harnesses

```typescript
import { getAvailableHarnesses, isValidHarnessType } from './harness';

const harnesses = getAvailableHarnesses();
// ['claude-agent-sdk', 'claude-code-cli']

isValidHarnessType('claude-agent-sdk'); // true
isValidHarnessType('invalid');          // false
```

---

## Creating Custom Harnesses

To add a new harness:

1. **Create harness file** in `src/harness/`:

```typescript
// src/harness/my-harness.ts
import { AgentHarness, HarnessOptions, HarnessMessage, HarnessType } from './types.js';

export class MyHarness implements AgentHarness {
  readonly type: HarnessType = 'my-harness' as HarnessType;

  async *run(prompt: string, options: HarnessOptions): AsyncGenerator<HarnessMessage> {
    yield { type: 'system', subtype: 'init', content: 'Starting my harness' };

    // Your implementation here...

    yield { type: 'result', result: 'Agent response' };
  }
}
```

2. **Update types** in `src/harness/types.ts`:

```typescript
export type HarnessType = 'claude-agent-sdk' | 'claude-code-cli' | 'my-harness';
```

3. **Register in factory** in `src/harness/index.ts`:

```typescript
import { MyHarness } from './my-harness.js';

export function createHarness(type: HarnessType): AgentHarness {
  switch (type) {
    // ...
    case 'my-harness':
      return new MyHarness();
    // ...
  }
}
```

---

## Best Practices

1. **Choose the right harness:**
   - `claude-agent-sdk` - When you need full Anthropic integration and plugin support (uses API key)
   - `claude-code-cli` - When you want to use your Max plan subscription

2. **Model selection:**
   - Use Haiku for fast, simple tasks
   - Use Sonnet for balanced workloads
   - Use Opus for complex reasoning

3. **Session management:**
   - Pass `resume` option to continue conversations
   - Sessions persist context and reduce token usage

4. **Error handling:**
   - Harnesses yield error messages, don't throw
   - Check message type for `error` to handle failures
