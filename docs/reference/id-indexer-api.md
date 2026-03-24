# ID Indexer API Reference

Complete API documentation for the ID Networks Indexer - tracking Agent Registry and Smart Credentials systems.

## Current Deployment Status

**🟢 PRODUCTION**: https://id-indexer.onrender.com  
**🟢 LOCAL**: `http://localhost:42069`

### Indexed Contracts (Sepolia Testnet)

#### Agent Registry System
| Contract | Address | Start Block |
|----------|---------|-------------|
| **AgentRegistryFactory** | `0x86a5139cBA9AB0f588aeFA3A7Ea3351E62C18563` | `9926000` |
| **Registry Implementation** | `0xa8cb0672E978Ff311412477c4D6732d80e074b20` | - |
| **Registrar Implementation** | `0xb5E3Dcc8cc881c95Cd66D03fd0A4B3C07eA2fDCc` | - |

#### Smart Credentials System
| Contract | Address | Start Block |
|----------|---------|-------------|
| **AgentProjectsFactory** | `0x4EC7776636f664E3AbBD700fB4BF745FC9E6c0DC` | `9912000` |
| **AgentProjects Implementation** | `0x867990E9bec0B52067d5f5ce80f26096896d09c8` | - |

### Architecture
- **🌐 Multi-Chain Ready**: Sepolia active, Base/Mainnet ready
- **Database**: PGLite (Local development) / PostgreSQL (Production)
- **Factory Pattern**: Dynamic discovery of registry, registrar, and credential clones via events
- **Standards**: ERC-6909 (tokens), ERC-8048 (token metadata), ERC-8049 (contract metadata), Smart Credentials

### Key Features

#### Agent Registry
- ✅ **Registry Tracking**: All AgentRegistry clones deployed by the factory
- ✅ **Registrar Tracking**: All AgentRegistrar clones with mint state
- ✅ **Agent Registration**: Track all registered agents via `Registered` events
- ✅ **Ownership Transfers**: Track ERC-6909 `Transfer` events
- ✅ **Token Metadata**: ERC-8048 `MetadataSet` events
- ✅ **Contract Metadata**: ERC-8049 `ContractMetadataUpdated` events
- ✅ **Registrar State**: Open/close, price updates, supply limits, lock bits

#### Smart Credentials
- ✅ **Credentials Tracking**: All AgentProjects credential contracts deployed from factory
- ✅ **Project Metadata**: Track project metadata for agents (ERC-8048)
- ✅ **Reviews System**: Track reviews between agents
- ✅ **Credential Metadata**: Contract-level metadata (ERC-8049)
- ✅ **Ownership Tracking**: Credential ownership transfers

---

## Base URL

**Production:**
```
https://id-indexer.onrender.com
```

**Local Development:**
```
http://localhost:42069
```

---

## Authentication

Most endpoints require API key authentication.

**Public endpoints** (no API key required):
- `GET /` - Root endpoint with API overview
- `GET /api/health` - Health check
- `GET /api/agents/:chainId/:registry/:agentId/metadata` - Agent metadata (for tokenURI)
- `GET /api/registries/:chainId/:address/metadata` - Contract metadata (for contractURI)

### Headers

```
Authorization: Bearer YOUR_API_KEY
```

### Example

```bash
# Authenticated request
curl -H "Authorization: Bearer sk-id-YOUR_KEY" \
  https://id-indexer.onrender.com/api/registries

# Public request (no auth needed)
curl https://id-indexer.onrender.com/api/health
```

---

## Endpoints Overview

### Root

**GET /**

Get API information and available endpoints.

**Response:**
```json
{
  "message": "ID Networks Indexer API",
  "version": "2.2.0",
  "description": "Indexer for Agent Registry (ERC-6909 + ERC-8048 + ERC-8049) and Smart Credentials systems",
  "endpoints": {
    "GET /api/health": "Health check (public)",
    "GET /api/registries": "List all registries",
    "GET /api/registries/:chainId/:address": "Get registry details",
    "GET /api/registries/:chainId/:address/metadata": "Get registry metadata - contractURI (public)",
    "GET /api/registrars": "List all registrars",
    "GET /api/registrars/:chainId/:address": "Get registrar details",
    "GET /api/agents": "List all agents",
    "GET /api/agents/:chainId/:registry/:agentId": "Get agent details",
    "GET /api/agents/:chainId/:registry/:agentId/metadata": "Get agent metadata - tokenURI (public)",
    "GET /api/agents/by-owner/:address": "Get agents by owner",
    "GET /api/credentials": "List all Smart Credentials",
    "GET /api/credentials/:chainId/:address": "Get credential details",
    "GET /api/credentials/:chainId/:address/metadata": "Get credential metadata",
    "GET /api/credentials/:chainId/:address/projects": "Get all projects for a credential",
    "GET /api/credentials/:chainId/:address/reviews": "Get all reviews for a credential",
    "GET /api/projects/:chainId/:credentialAddress/:agentId": "Get project details for an agent",
    "GET /api/reviews/:chainId/:credentialAddress/:reviewerId/:reviewedId": "Get review details",
    "GET /api/contracts/:chainId/:address/metadata": "Get contract metadata (detailed)",
    "GET /api/stats": "Get global statistics"
  },
  "auth": "API key required (Bearer token) - except for endpoints marked (public)",
  "documentation": "https://github.com/nxt3d/id-indexer/blob/main/API_REFERENCE.md"
}
```

---

## Health Check

**GET /api/health** 🔓 **PUBLIC**

Check API health status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-12-19T12:00:00.000Z",
  "service": "id-indexer",
  "stats": {
    "registries": 0,
    "agents": 0
  }
}
```

---

## Registries

### List Registries

**GET /api/registries**

List all AgentRegistry clones deployed by the factory.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |
| `chainId` | number | - | Filter by chain ID |

**Example:**
```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://id-indexer.onrender.com/api/registries?limit=10&chainId=11155111"
```

**Response:**
```json
{
  "registries": [
    {
      "address": "0xabc123...",
      "chainId": 11155111,
      "chainName": "sepolia",
      "admin": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
      "totalAgents": "25",
      "registrarAddress": "0xdef456...",
      "deployedAt": {
        "block": "9873500",
        "timestamp": "1734600000",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

### Get Registry

**GET /api/registries/:chainId/:address**

Get detailed information about a specific registry.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID (e.g., `11155111` for Sepolia) |
| `address` | Registry contract address |

**Example:**
```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://id-indexer.onrender.com/api/registries/11155111/0xabc123...
```

**Response:**
```json
{
  "address": "0xabc123...",
  "chainId": 11155111,
  "chainName": "sepolia",
  "admin": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
  "totalAgents": "25",
  "registrarAddress": "0xdef456...",
  "deployedAt": {
    "block": "9873500",
    "timestamp": "1734600000",
    "txHash": "0x..."
  },
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

## Registrars

### List Registrars

**GET /api/registrars**

List all AgentRegistrar clones deployed by the factory.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |
| `chainId` | number | - | Filter by chain ID |

**Response:**
```json
{
  "registrars": [
    {
      "address": "0xdef456...",
      "chainId": 11155111,
      "chainName": "sepolia",
      "registryAddress": "0xabc123...",
      "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
      "mintPrice": "10000000000000000",
      "maxSupply": "10000",
      "totalMinted": "25",
      "status": {
        "open": true,
        "lockedOpenClose": false,
        "lockedMintPrice": false,
        "lockedMaxSupply": false
      },
      "deployedAt": {
        "block": "9873500",
        "timestamp": "1734600000",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

### Get Registrar

**GET /api/registrars/:chainId/:address**

Get detailed information about a specific registrar.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID |
| `address` | Registrar contract address |

**Response:**
```json
{
  "address": "0xdef456...",
  "chainId": 11155111,
  "chainName": "sepolia",
  "registryAddress": "0xabc123...",
  "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
  "mintPrice": "10000000000000000",
  "maxSupply": "10000",
  "totalMinted": "25",
  "remainingSupply": "9975",
  "status": {
    "open": true,
    "lockedOpenClose": false,
    "lockedMintPrice": false,
    "lockedMaxSupply": false
  },
  "deployedAt": {
    "block": "9873500",
    "timestamp": "1734600000",
    "txHash": "0x..."
  },
  "recentActivity": [
    {
      "type": "opened",
      "block": "9873550",
      "timestamp": "1734601000",
      "txHash": "0x..."
    }
  ],
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

### Registrar Lock Bits

Registrars have configurable lock bits for permanent settings:

| Lock Bit | Value | Description |
|----------|-------|-------------|
| `LOCK_OPEN_CLOSE` | 1 | Minting open state cannot be changed |
| `LOCK_MINT_PRICE` | 2 | Mint price cannot be changed |
| `LOCK_MAX_SUPPLY` | 4 | Max supply cannot be changed |

---

## Agents

### List Agents

**GET /api/agents**

List all registered agents.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |
| `chainId` | number | - | Filter by chain ID |
| `registry` | string | - | Filter by registry address |
| `owner` | string | - | Filter by owner address |

**Response:**
```json
{
  "agents": [
    {
      "id": "11155111:0xabc123...:1",
      "agentId": "1",
      "registryAddress": "0xabc123...",
      "chainId": 11155111,
      "chainName": "sepolia",
      "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
      "endpointType": "mcp",
      "endpoint": "https://agent.example.com/mcp",
      "agentAccount": "0x...",
      "mintNumber": "1",
      "registeredAt": {
        "block": "9873600",
        "timestamp": "1734602000",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

### Get Agent

**GET /api/agents/:chainId/:registry/:agentId**

Get details about a specific agent.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID |
| `registry` | Registry contract address |
| `agentId` | Agent token ID |

**Response:**
```json
{
  "agentId": "1",
  "registryAddress": "0xabc123...",
  "chainId": 11155111,
  "chainName": "sepolia",
  "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
  "endpointType": "mcp",
  "endpoint": "https://agent.example.com/mcp",
  "agentAccount": "0x...",
  "mintNumber": "1",
  "registrarAddress": "0xdef456...",
  "registeredAt": {
    "block": "9873600",
    "timestamp": "1734602000",
    "txHash": "0x..."
  },
  "metadata": {
    "name": {
      "value": "0x4d79204167656e74",
      "valueAsString": "My Agent"
    },
    "description": {
      "value": "0x...",
      "valueAsString": "An AI agent"
    }
  },
  "transferHistory": [
    {
      "type": "mint",
      "from": "0x0000000000000000000000000000000000000000",
      "to": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
      "block": "9873600",
      "timestamp": "1734602000",
      "txHash": "0x..."
    }
  ],
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

### Get Agent Metadata (ERC-8004 Format)

**GET /api/agents/:chainId/:registry/:agentId/metadata** 🔓 **PUBLIC**

Returns ERC-8004 compliant agent metadata. This endpoint is **public** (no API key required) for use as `tokenURI`.

**Response:**
```json
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "My Agent",
  "description": "An AI agent on Ethereum",
  "image": "https://example.com/agent-image.png",
  "endpoints": [
    {
      "name": "mcp",
      "endpoint": "https://agent.example.com/mcp"
    },
    {
      "name": "agentWallet",
      "endpoint": "eip155:11155111:0x9a704664009d615a90dddf9345b6b8b2a214cfb2"
    }
  ],
  "registrations": [
    {
      "agentId": "eip155:11155111:1",
      "agentRegistry": "eip155:11155111:0xabc123..."
    }
  ]
}
```

**Metadata Mapping:**

| JSON Field | Onchain Metadata Key | Notes |
|------------|---------------------|-------|
| `name` | `name` | Agent name |
| `description` | `description` | Agent description |
| `image` | `image` | Agent image URL |
| `endpoints[0].name` | `endpoint_type` | e.g., "mcp", "a2a" |
| `endpoints[0].endpoint` | `endpoint` | Endpoint URL |
| `agentWallet` | `agent_account` | Agent's wallet address |

---

### Get Agents by Owner

**GET /api/agents/by-owner/:address**

Get all agents owned by a specific wallet address.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `address` | Owner wallet address |

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 100 | Max results (max: 1000) |
| `offset` | number | 0 | Pagination offset |
| `chainId` | number | - | Filter by chain ID |

**Response:**
```json
{
  "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
  "agents": [
    {
      "id": "11155111:0xabc123...:1",
      "agentId": "1",
      "registryAddress": "0xabc123...",
      "chainId": 11155111,
      "chainName": "sepolia",
      "endpointType": "mcp",
      "endpoint": "https://agent.example.com/mcp",
      "agentAccount": "0x...",
      "registeredAt": {
        "block": "9873600",
        "timestamp": "1734602000"
      }
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-19T12:00:00.000Z"
}
```

---

## Contract Metadata (ERC-8049)

### Get Registry Metadata (contractURI)

**GET /api/registries/:chainId/:address/metadata** 🔓 **PUBLIC**

Returns contract-level metadata for a registry. This endpoint is **public** (no API key required) for use as `contractURI`.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID (e.g., `11155111` for Sepolia) |
| `address` | Registry contract address |

**Example:**
```bash
# No auth needed - public endpoint
curl "https://id-indexer.onrender.com/api/registries/11155111/0xd0a3f7ec49522a0ce71dc765cb3bc98dbdf0cb93/metadata"
```

**Response:**
```json
{
  "name": "Network 1",
  "description": "A registry for AI agents",
  "image": "https://example.com/registry-image.png",
  "external_link": "https://myregistry.xyz"
}
```

This returns all ERC-8049 metadata keys as a flat JSON object, with values decoded from hex to UTF-8 strings.

---

### Get Contract Metadata (Detailed)

**GET /api/contracts/:chainId/:address/metadata**

Get detailed contract-level metadata with timestamps and raw values.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID |
| `address` | Contract address |

**Example:**
```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://id-indexer.onrender.com/api/contracts/11155111/0xd0a3f7ec49522a0ce71dc765cb3bc98dbdf0cb93/metadata"
```

**Response:**
```json
{
  "contractAddress": "0xd0a3f7ec49522a0ce71dc765cb3bc98dbdf0cb93",
  "chainId": 11155111,
  "metadata": [
    {
      "key": "name",
      "value": "0x4e6574776f726b2031",
      "valueAsString": "Network 1",
      "setAt": {
        "block": "9877076",
        "timestamp": "1734665844",
        "txHash": "0xbdef802f13882dfcee226f188fb5ca8fdfa499abbc1841860fbacf819ade875d"
      },
      "lastUpdate": {
        "block": "9877076",
        "timestamp": "1734665844"
      }
    }
  ],
  "total": 1,
  "timestamp": "2025-12-20T03:40:00.000Z"
}
```

---

## Smart Credentials

### List Credentials

**GET /api/credentials**

List all Smart Credentials (AgentProjects) deployed from the factory.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |
| `chainId` | number | - | Filter by chain ID |

**Response:**
```json
{
  "credentials": [
    {
      "address": "0x123...",
      "chainId": 11155111,
      "chainName": "sepolia",
      "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
      "agentRegistryAddress": "0xabc...",
      "name": "My Agent Projects",
      "totalProjects": "15",
      "totalReviews": "42",
      "deployedAt": {
        "block": "9912800",
        "timestamp": "1734933200",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Credential Details

**GET /api/credentials/:chainId/:address**

Get detailed information about a specific Smart Credential.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID (e.g., `11155111` for Sepolia) |
| `address` | Credential contract address |

**Response:**
```json
{
  "address": "0x123...",
  "chainId": 11155111,
  "chainName": "sepolia",
  "owner": "0x9a704664009d615a90dddf9345b6b8b2a214cfb2",
  "agentRegistryAddress": "0xabc...",
  "name": "My Agent Projects",
  "totalProjects": "15",
  "totalReviews": "42",
  "deployedAt": {
    "block": "9912800",
    "timestamp": "1734933200",
    "txHash": "0x..."
  },
  "lastActivity": {
    "block": "9913000",
    "timestamp": "1734935000"
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Credential Metadata

**GET /api/credentials/:chainId/:address/metadata**

Get all contract-level metadata for a credential (ERC-8049).

**Response:**
```json
{
  "credentialAddress": "0x123...",
  "chainId": 11155111,
  "metadata": [
    {
      "key": "name",
      "value": "0x4d79204167656e742050726f6a65637473",
      "valueAsString": "My Agent Projects",
      "setAt": {
        "block": "9912800",
        "timestamp": "1734933200",
        "txHash": "0x..."
      }
    }
  ],
  "total": 1,
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Projects for Credential

**GET /api/credentials/:chainId/:address/projects**

Get all projects tracked by a credential.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "credentialAddress": "0x123...",
  "chainId": 11155111,
  "projects": [
    {
      "agentId": "1",
      "metadata": [
        {
          "key": "project-name",
          "value": "0x4d792050726f6a656374",
          "valueAsString": "My Project"
        },
        {
          "key": "description",
          "value": "0x...",
          "valueAsString": "Project description"
        }
      ],
      "setAt": {
        "block": "9912850",
        "timestamp": "1734933250",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Reviews for Credential

**GET /api/credentials/:chainId/:address/reviews**

Get all reviews submitted through a credential.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Max results (max: 100) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "credentialAddress": "0x123...",
  "chainId": 11155111,
  "reviews": [
    {
      "reviewerId": "1",
      "reviewedId": "2",
      "reviewData": "0x73636f72653a203935207265766965773a206578...",
      "reviewDataAsString": "score: 95 review: excellent work",
      "submittedAt": {
        "block": "9912900",
        "timestamp": "1734933300",
        "txHash": "0x..."
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Project by Agent ID

**GET /api/projects/:chainId/:credentialAddress/:agentId**

Get project metadata for a specific agent in a credential.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID |
| `credentialAddress` | Credential contract address |
| `agentId` | Agent ID |

**Response:**
```json
{
  "credentialAddress": "0x123...",
  "chainId": 11155111,
  "agentId": "1",
  "metadata": [
    {
      "key": "project-name",
      "value": "0x4d792050726f6a656374",
      "valueAsString": "My Project"
    }
  ],
  "setAt": {
    "block": "9912850",
    "timestamp": "1734933250",
    "txHash": "0x..."
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

### Get Review

**GET /api/reviews/:chainId/:credentialAddress/:reviewerId/:reviewedId**

Get a specific review between two agents.

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `chainId` | Chain ID |
| `credentialAddress` | Credential contract address |
| `reviewerId` | Reviewer agent ID |
| `reviewedId` | Reviewed agent ID |

**Response:**
```json
{
  "credentialAddress": "0x123...",
  "chainId": 11155111,
  "reviewerId": "1",
  "reviewedId": "2",
  "reviewData": "0x73636f72653a203935...",
  "reviewDataAsString": "score: 95 review: excellent work",
  "submittedAt": {
    "block": "9912900",
    "timestamp": "1734933300",
    "txHash": "0x..."
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

## Statistics

### Get Global Stats

**GET /api/stats**

Get global statistics about the ID ecosystem.

**Response:**
```json
{
  "registries": {
    "total": 5,
    "byChain": {
      "sepolia": 5
    }
  },
  "registrars": {
    "total": 5,
    "open": 3,
    "closed": 2,
    "totalMinted": "150"
  },
  "agents": {
    "total": 150,
    "uniqueOwners": 45,
    "byChain": {
      "sepolia": 150
    }
  },
  "credentials": {
    "total": 3,
    "totalProjects": 45,
    "totalReviews": 127,
    "byChain": {
      "sepolia": 3
    }
  },
  "timestamp": "2025-12-25T12:00:00.000Z"
}
```

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "Invalid address format"
}
```

### 401 Unauthorized
```json
{
  "error": "Missing or invalid Authorization header"
}
```

### 404 Not Found
```json
{
  "error": "Registry not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to fetch registries",
  "details": "Error message"
}
```

---

## Data Types

| Type | Format | Example |
|------|--------|---------|
| Address | Lowercase hex (42 chars) | `0xabc123...` |
| Numbers (uint256) | String | `"10000000000000000"` |
| Timestamps | Unix seconds (string) | `"1734600000"` |
| Transaction Hash | Hex (66 chars) | `"0xd3648e09..."` |
| Chain ID | Number | `11155111` |

---

## Event Types Indexed

### Factory Events - Agent Registry
| Event | Description |
|-------|-------------|
| `RegistryDeployed` | New AgentRegistry clone deployed |
| `RegistrarDeployed` | New AgentRegistrar clone deployed |
| `RegistryAndRegistrarDeployed` | Both deployed together |

### Factory Events - Smart Credentials
| Event | Description |
|-------|-------------|
| `AgentProjectsCreated` | New AgentProjects credential deployed |

### Registry Events (ERC-6909 + ERC-8048 + ERC-8049)
| Event | Description |
|-------|-------------|
| `Transfer` | Agent ownership transferred |
| `Approval` | Agent approval granted |
| `OperatorSet` | Operator status changed |
| `Registered` | New agent registered |
| `MetadataSet` | Agent metadata updated (ERC-8048) |
| `ContractMetadataUpdated` | Contract metadata updated (ERC-8049) |

### Registrar Events
| Event | Description |
|-------|-------------|
| `MintingOpened` | Minting enabled |
| `MintingClosed` | Minting disabled |
| `MintPriceUpdated` | Price changed |
| `MaxSupplyUpdated` | Supply limit changed |
| `LockBitSet` | Lock bit activated |
| `AgentMinted` | Agent minted via registrar |
| `Withdrawn` | ETH withdrawn |

### Smart Credentials Events
| Event | Description |
|-------|-------------|
| `ReviewSubmitted` | Review submitted between agents |
| `MetadataSet` | Project metadata set (ERC-8048) |
| `ContractMetadataUpdated` | Credential metadata updated (ERC-8049) |
| `OwnershipTransferred` | Credential ownership transferred |
| `AgentRegistryUpdated` | Associated agent registry changed |

---

## Quick Start for dApp Integration

### 1. Set your API key

```javascript
const API_KEY = 'sk-id-YOUR_KEY';
const BASE_URL = 'https://id-indexer.onrender.com';
// For local development: const BASE_URL = 'http://localhost:42069';

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};
```

### 2. Fetch registries

```javascript
const response = await fetch(`${BASE_URL}/api/registries`, { headers });
const data = await response.json();
console.log(data.registries);
```

### 3. Get agents for a user

```javascript
const ownerAddress = '0x...';
const response = await fetch(
  `${BASE_URL}/api/agents/by-owner/${ownerAddress}`, 
  { headers }
);
const data = await response.json();
console.log(data.agents);
```

### 4. Use public metadata endpoint (no auth)

```javascript
// For tokenURI - no API key needed
const chainId = 11155111;
const registry = '0xabc123...';
const agentId = 1;
const metadataUrl = `${BASE_URL}/api/agents/${chainId}/${registry}/${agentId}/metadata`;
const response = await fetch(metadataUrl);
const metadata = await response.json();
```

---

## Support

- **GitHub**: https://github.com/nxt3d/id-indexer
- **Production URL**: https://id-indexer.onrender.com
- **Local Logs**: Check terminal running `pnpm dev`
