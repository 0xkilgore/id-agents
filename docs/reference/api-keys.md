# API Key Authentication

ID Agents supports API key authentication for controlling access to agents and manager endpoints.

## Key Types

| Key Type | Environment Variable | Purpose |
|----------|---------------------|---------|
| **Control Key** | `ID_CONTROL_API_KEY` | Admin access to manager (`/remote`, `/keys/*`) |
| **Agent Key** | `ID_AGENT_API_KEY` | Inter-agent communication, key validation |
| **Client Keys** | Issued via `/keys/issue` | External client access to agents |

## Authentication Flow

```
External Client                     Agent                        Manager
     │                                │                             │
     ├── POST /talk ─────────────────►│                             │
     │   X-API-Key: sk-id-xxx         │                             │
     │                                ├── POST /keys/validate ─────►│
     │                                │   X-API-Key: ID_AGENT_KEY   │
     │                                │   body: {key: sk-id-xxx}    │
     │                                │                             │
     │                                │◄─── {valid: true/false} ────┤
     │                                │                             │
     │◄─── Process or 401 ────────────┤                             │
```

## Manager Endpoints

### POST /keys/issue

Issue a new client API key.

**Authentication:** Requires `ID_CONTROL_API_KEY`

**Request:**
```bash
curl -X POST http://localhost:4100/keys/issue \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ID_CONTROL_API_KEY" \
  -d '{
    "name": "my-client",
    "scopes": ["talk"],
    "expires_in_days": 30,
    "metadata": {"app": "my-app"}
  }'
```

**Response:**
```json
{
  "ok": true,
  "key": "sk-id-9143e134487864e8511fea4581789e810d1edd676c6ccb20",
  "prefix": "sk-id-9143e1",
  "name": "my-client",
  "scopes": ["talk"],
  "expires_at": "2024-02-15T00:00:00.000Z",
  "warning": "Save this key - it cannot be retrieved again"
}
```

**Important:** The full key is only returned once at creation. Store it securely.

### GET /keys

List all issued keys (shows prefix only, not full key).

**Authentication:** Requires `ID_CONTROL_API_KEY`

**Request:**
```bash
curl http://localhost:4100/keys \
  -H "X-API-Key: $ID_CONTROL_API_KEY"
```

**Response:**
```json
{
  "keys": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "prefix": "sk-id-9143e1",
      "name": "my-client",
      "scopes": ["talk"],
      "created_at": "2024-01-15T12:00:00.000Z",
      "expires_at": "2024-02-15T00:00:00.000Z",
      "revoked_at": null,
      "last_used_at": "2024-01-15T14:30:00.000Z",
      "status": "active"
    }
  ]
}
```

**Note:** The full secret key is never exposed. Only the prefix is shown for identification.

### POST /keys/validate

Validate a client key. Used by agents to verify incoming requests.

**Authentication:** Requires `ID_AGENT_API_KEY`

**Request:**
```bash
curl -X POST http://localhost:4100/keys/validate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ID_AGENT_API_KEY" \
  -d '{"key": "sk-id-9143e134487864e8..."}'
```

**Response (valid):**
```json
{
  "valid": true,
  "name": "my-client",
  "scopes": ["talk"]
}
```

**Response (invalid):**
```json
{
  "valid": false,
  "reason": "Key not found"
}
```

Possible reasons: `Key not found`, `Key has been revoked`, `Key has expired`

### DELETE /keys/:id

Revoke an API key.

**Authentication:** Requires `ID_CONTROL_API_KEY`

**Request:**
```bash
curl -X DELETE http://localhost:4100/keys/550e8400-e29b-41d4-a716-446655440000 \
  -H "X-API-Key: $ID_CONTROL_API_KEY"
```

**Response:**
```json
{
  "ok": true,
  "message": "Key revoked"
}
```

## Agent Authentication

Agents validate incoming API keys via the manager. The authentication middleware:

1. **Allows without auth:** `/health`, `/.well-known/restap.json`
2. **Trusted (no validation):** Requests with `ID_AGENT_API_KEY` (inter-agent)
3. **Validated via manager:** Client keys (`sk-id-xxx`)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ID_AGENT_API_KEY` | Shared key for inter-agent communication |
| `ID_REQUIRE_CLIENT_AUTH` | Set to `true` to require auth on all requests |
| `MANAGER_URL` | Manager URL for key validation |

### Strict Mode

To require authentication on all agent requests, you can either:

**1. Set environment variable:**
```bash
ID_REQUIRE_CLIENT_AUTH=true
```

**2. Use configuration file (recommended):**
```yaml
defaults:
  requireAuth: true  # Apply to all agents

agents:
  - name: protected-agent
    # Uses defaults.requireAuth = true
  - name: public-agent
    requireAuth: false  # Override for this agent
```

See [Configuration Reference](./configuration.md#agent-authentication) for full details.

Without strict mode, requests without an API key are allowed (backwards compatible).

## Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                     Key Storage                              │
├─────────────────────────────────────────────────────────────┤
│  Database stores:                                            │
│    - key_hash: SHA256(full_key) - for validation             │
│    - key_prefix: "sk-id-xxxxxx" - for identification         │
│                                                              │
│  Full key is NEVER stored, only returned once at creation    │
└─────────────────────────────────────────────────────────────┘
```

This follows industry standards (GitHub, Stripe, AWS):
- Full secret shown only at creation
- Database stores hash, not plaintext
- List endpoint shows prefix only

## Database Schema

```sql
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  key_hash text NOT NULL,        -- SHA256 hash for validation
  key_prefix text NOT NULL,      -- First 12 chars for display
  name text NOT NULL,            -- Human-readable label
  scopes jsonb DEFAULT '["talk"]',
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,        -- NULL = never expires
  revoked_at timestamptz,        -- NULL = active
  last_used_at timestamptz,
  metadata jsonb DEFAULT '{}'
);
```

## CLI Commands

The interactive CLI provides commands for API key management:

### /keys

List all API keys for the current team.

```
/keys
```

**Output:**
```
API Keys:
  Name         Prefix           Status    Created              Expires
  my-client    sk-id-9143e1     active    2024-01-15 12:00     2024-02-15
  mobile-app   sk-id-abc123     active    2024-01-16 09:30     never
```

### /keys issue

Issue a new API key.

```
/keys issue <name> [scopes] [expires_in_days]
```

**Parameters:**
- `name` - Required. Human-readable label for the key
- `scopes` - Optional. Comma-separated list (default: `talk`)
- `expires_in_days` - Optional. Days until expiration (default: never expires)

**Examples:**
```
/keys issue my-client              # Basic key, never expires
/keys issue mobile-app talk 30     # Expires in 30 days
/keys issue admin talk,admin 365   # Multiple scopes, 1 year
```

**Output:**
```
✅ API key issued successfully

  Name:   my-client
  Prefix: sk-id-9143e1
  Key:    sk-id-9143e134487864e8511fea4581789e810d1edd676c6ccb20

⚠️  Save this key - it cannot be retrieved again
```

### /keys revoke

Revoke an existing API key.

```
/keys revoke <id>
```

**Parameters:**
- `id` - The UUID of the key to revoke (shown in `/keys` output)

**Example:**
```
/keys revoke 550e8400-e29b-41d4-a716-446655440000
```

---

## Example Usage

### Issue a key for an external client

```bash
# Issue key (admin)
KEY=$(curl -s -X POST http://localhost:4100/keys/issue \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ID_CONTROL_API_KEY" \
  -d '{"name": "mobile-app"}' | jq -r '.key')

echo "Client key: $KEY"
# Output: Client key: sk-id-9143e134487864e8511fea4581789e810d1edd676c6ccb20
```

### Use the key to talk to an agent

```bash
curl -X POST http://localhost:4100/talk \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"message": "Hello, what is your name?"}'
```

### Revoke a compromised key

```bash
# Find the key ID
KEY_ID=$(curl -s http://localhost:4100/keys \
  -H "X-API-Key: $ID_CONTROL_API_KEY" | jq -r '.keys[] | select(.name=="mobile-app") | .id')

# Revoke it
curl -X DELETE "http://localhost:4100/keys/$KEY_ID" \
  -H "X-API-Key: $ID_CONTROL_API_KEY"
```
