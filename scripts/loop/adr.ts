#!/usr/bin/env node
/**
 * adr.ts — Architecture Decision Record manager for autonomous agent harness.
 *
 * Usage:
 *   node scripts/loop/adr.ts list
 *   node scripts/loop/adr.ts add "Title of Decision" [--status=accepted|proposed]
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const adrDir = join(repoRoot, 'docs', 'adr');

if (!existsSync(adrDir)) {
  mkdirSync(adrDir, { recursive: true });
}

const command = process.argv[2] || 'list';

if (command === 'list') {
  const files = readdirSync(adrDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  if (files.length === 0) {
    console.log('No ADRs found in docs/adr/. Use "node scripts/loop/adr.ts add <title>" to record decisions.');
    process.exit(0);
  }
  console.log('Architecture Decision Records (ADR):\n');
  for (const file of files) {
    const content = readFileSync(join(adrDir, file), 'utf8');
    const firstLine = content.split('\n')[0] || file;
    console.log(`- [${file}] ${firstLine.replace(/^#\s*/, '')}`);
  }
} else if (command === 'add') {
  const title = process.argv[3];
  if (!title) {
    console.error('Error: Title is required for adding an ADR.');
    process.exit(1);
  }
  const existingFiles = readdirSync(adrDir).filter((f) => /^\d{4}-/.test(f));
  const nextId = String(existingFiles.length + 1).padStart(4, '0');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const fileName = `${nextId}-${slug}.md`;
  const filePath = join(adrDir, fileName);

  const adrTemplate = `# ${nextId}. ${title}

Date: ${new Date().toISOString().split('T')[0]}
Status: Accepted

## Context
Describe the background and problem that required this architectural decision.

## Decision
Describe the chosen solution and architectural changes.

## Consequences
Describe the trade-offs, positive/negative outcomes, and operational constraints.
`;

  writeFileSync(filePath, adrTemplate, 'utf8');
  console.log(`Created ADR: ${filePath}`);
} else {
  console.log('Unknown command. Available commands: list, add');
}
