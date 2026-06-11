---
description: "Coding standards, conventions, and architectural patterns for this project"
priority: 1
---
# Project Conventions

## Code Style
- Use 2-space indentation (or whatever the project uses)
- Prefer async/await over raw promises
- Use TypeScript strict mode where possible
- Name functions and variables descriptively

## Architecture
- Pi extension entry point: package.json's "pi.extensions" field → src/index.ts
- Pi loads TypeScript directly via node --experimental-strip-types (no build step)
- Dev test command: pi --no-session
- Key modules and their responsibilities
- Data flow patterns
- API design principles

## Testing
- (Document testing conventions)
- Test framework and commands
- Coverage expectations
- Mock/stub patterns

## Git
- Branch naming conventions
- Commit message format
- PR checklist
