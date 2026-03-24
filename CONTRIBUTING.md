# Contributing to ID Agents

Thank you for your interest in contributing to ID Agents! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/id-agents.git`
3. Install dependencies: `npm install`
4. Copy environment template: `cp env.example .env`
5. Configure your `.env` file with required API keys

## Development Setup

```bash
# Build the project
npm run build

# Run in development mode (watch for changes)
npm run dev

# Start the interactive CLI
npm run id-agents

# Run tests
npm test
```

## Project Structure

```
src/
├── agent-manager-db.ts     # Manager service
├── claude-agent-server.ts  # Worker service (runs as local processes)
├── local-agent-server.ts   # Local agent process management
├── interactive-agent-cli.ts # Interactive CLI
├── db.ts                   # Database schema and migrations
├── core/                   # Shared business logic
└── harness/                # LLM runtime backends

docs/                       # Documentation
configs/                    # Example configuration files
skills/                     # Agent skill definitions
plugins/                    # Claude Code plugins
tests/                      # Test files
```

## Making Changes

### Code Style

- Use TypeScript for all new code
- Follow existing code patterns and naming conventions
- Keep functions focused and reasonably sized
- Add types for function parameters and return values

### Commits

- Write clear, concise commit messages
- Use present tense ("Add feature" not "Added feature")
- Reference issues when applicable

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run tests: `npm test`
4. Build to check for type errors: `npm run build`
5. Submit a pull request with a clear description

### Testing

- Add tests for new features
- Ensure existing tests pass
- Integration tests are in `tests/integration/`

## Areas for Contribution

- **Documentation**: Improve guides, add examples, fix typos
- **Bug fixes**: Check issues labeled `bug`
- **Features**: Check issues labeled `enhancement`
- **Tests**: Increase test coverage
- **Harnesses**: Add support for new LLM runtimes
- **Skills**: Create new agent skills

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version)
- Relevant logs or error messages

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow

## License

By contributing, you agree that your contributions will be licensed under the MIT license.

## Questions?

Open an issue for questions about contributing or the codebase.
