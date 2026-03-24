# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ID Agents, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues by emailing the maintainer directly or by opening a private security advisory on GitHub.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- We will acknowledge receipt within 48 hours
- We will provide an initial assessment within 7 days
- We will work with you to understand and resolve the issue

## Security Considerations

ID Agents handles sensitive data and runs code as local processes. Key security areas:

### API Keys

- `ID_CONTROL_API_KEY` - Admin access to manager
- `ID_AGENT_API_KEY` - Inter-agent communication
- `ANTHROPIC_API_KEY` - LLM API access
- Client API keys issued via `/keys/issue`

**Best practices:**
- Never commit API keys to version control
- Use environment variables or `.env` files (gitignored)
- Rotate keys periodically
- Use minimal scopes for client keys

### Process Isolation

Agents run as local processes with:
- Separate working directories per agent
- Network access (required for LLM APIs)
- Shared workspace directories (be aware of cross-agent file access)

### Network Security

- Manager exposes REST API on configurable port
- Agent processes expose REST-AP endpoints
- Use firewalls to restrict access in production
- Consider TLS termination via reverse proxy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
