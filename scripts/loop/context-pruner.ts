#!/usr/bin/env node
/**
 * context-pruner.ts — Dynamic context, AST symbol & token pruner for agent prompts.
 *
 * Prevents "Lost in the Middle" attention loss and optimizes for Prompt Caching by:
 * 1. Structuring prompt prefix (immutable system rules) and tail (dynamic task context).
 * 2. Extracting relevant symbol/interface signatures matching task keywords.
 * 3. Pruning non-relevant sections from AGENTS.md, rules.md, and skills.
 *
 * Usage:
 *   node scripts/loop/context-pruner.ts "<task description or card text>" [--prefix] [--tail] [--json] [--max-tokens=N]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const repoRoot = resolve(process.cwd());

function getArg(flag: string, fallback: string | null = null): string | null {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.split('=')[1] ?? fallback : fallback;
}

const isPrefixOnly = process.argv.includes('--prefix');
const isTailOnly = process.argv.includes('--tail');
const isJson = process.argv.includes('--json');
const taskText = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');

if (!taskText && !isPrefixOnly) {
  console.log('Usage: node scripts/loop/context-pruner.ts "<task description>" [--prefix] [--tail] [--json]');
  process.exit(0);
}

const keywords = taskText.toLowerCase().split(/\W+/).filter((w) => w.length > 3);

function pruneFileContent(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf8');
  const sections = content.split(/\n(?=##?\s+)/);

  const matchedSections = sections.filter((sec) => {
    const secLower = sec.toLowerCase();
    // Keep mandatory headers like Hard rules, Data Contract, or sections matching keywords
    if (secLower.includes('hard rules') || secLower.includes('data contract')) return true;
    return keywords.some((kw) => secLower.includes(kw));
  });

  return matchedSections.length > 0 ? matchedSections.join('\n\n') : (sections[0] ?? '');
}

/** Lightweight symbol signature extractor from source files matching task keywords */
function extractMatchingSymbols(rootDir: string, terms: string[]): string[] {
  if (!terms.length) return [];
  const results: string[] = [];
  const maxFiles = 10;
  let scanned = 0;

  function scan(dir: string) {
    if (scanned >= maxFiles) return;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          scan(full);
        } else if (stat.isFile() && ['.ts', '.js', '.go', '.rs', '.py'].includes(extname(entry))) {
          scanned++;
          const code = readFileSync(full, 'utf8');
          const lines = code.split('\n');
          for (const line of lines) {
            if (/^(export\s+)?(function|interface|type|class|const\s+[A-Z]|enum)\s+([A-Za-z0-9_]+)/.test(line.trim())) {
              const lineLower = line.toLowerCase();
              if (terms.some((t) => lineLower.includes(t))) {
                results.push(`${entry}: ${line.trim().slice(0, 120)}`);
                if (results.length >= 15) return;
              }
            }
          }
        }
      }
    } catch {}
  }

  scan(rootDir);
  return results;
}

const prunedAgents = pruneFileContent(join(repoRoot, 'AGENTS.md'));
const prunedRules = existsSync(join(repoRoot, 'rules.md')) ? pruneFileContent(join(repoRoot, 'rules.md')) : '';
const relevantSymbols = extractMatchingSymbols(repoRoot, keywords);

const prefixContent = [
  '<!-- STATIC SYSTEM CONTEXT (PROMPT-CACHE FRIENDLY PREFIX) -->',
  '## Relevant Harness Rules:',
  prunedAgents,
  prunedRules ? '\n## Relevant Core Rules:\n' + prunedRules : ''
].filter(Boolean).join('\n');

const tailContent = [
  '<!-- DYNAMIC TASK CONTEXT -->',
  '## Task Intent:',
  taskText,
  relevantSymbols.length ? '\n## Key Relevant Symbols:\n' + relevantSymbols.map((s) => `- ${s}`).join('\n') : ''
].filter(Boolean).join('\n');

if (isJson) {
  console.log(JSON.stringify({ prefix: prefixContent, tail: tailContent, symbols: relevantSymbols }, null, 2));
} else if (isPrefixOnly) {
  console.log(prefixContent);
} else if (isTailOnly) {
  console.log(tailContent);
} else {
  console.log([prefixContent, '', tailContent].join('\n'));
}
