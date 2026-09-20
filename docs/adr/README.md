# Architecture Decision Records (ADR)

This directory contains Architecture Decision Records for classgame.
ADRs document significant architectural decisions, trade-offs, and historical context.

## Usage

Agents MUST check existing ADRs before performing structural refactoring or changing core technology choices.

To create a new ADR:
```bash
node scripts/loop/adr.ts add "Title of the Decision"
```

To list all ADRs:
```bash
node scripts/loop/adr.ts list
```
