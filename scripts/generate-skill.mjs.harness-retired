import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node generate-skill.mjs <skill-name> "<description>" "<markdown_content_or_filepath>"');
  process.exit(1);
}

const skillName = args[0].trim();
const description = args[1].trim();
let content = args[2].trim();

// If the content parameter is a path to a file, read its content
if (fs.existsSync(content)) {
  content = fs.readFileSync(content, 'utf8');
}

// Ensure the content doesn't double-define the YAML frontmatter
if (content.startsWith('---')) {
  // Strip existing frontmatter if present to avoid nesting
  const parts = content.split('---');
  if (parts.length >= 3) {
    content = parts.slice(2).join('---').trim();
  }
}

const skillTemplate = `---
name: ${skillName}
description: ${description}
---

${content}
`;

// 1. Write to local project (.agents/skills)
const localSkillDir = path.resolve(`.agents/skills/${skillName}`);
fs.mkdirSync(localSkillDir, { recursive: true });
const localSkillPath = path.join(localSkillDir, 'SKILL.md');
fs.writeFileSync(localSkillPath, skillTemplate, 'utf8');
console.log(`[Local] Created skill "${skillName}" at ${localSkillPath}`);

try {
  execSync(`git add "${localSkillPath}"`, { stdio: 'inherit' });
  console.log(`[Local] Successfully added to git`);
} catch (e) {
  console.warn(`[Local] Failed to git add: ${e.message}`);
}

// 2. Write to create-agent-harness template (if directory exists in the same parent directory)
// In our structure: E:\works\project\edulinker and E:\works\project\create-agent-harness
const harnessPath = path.resolve('../create-agent-harness');
if (fs.existsSync(harnessPath)) {
  const harnessSkillDir = path.join(harnessPath, `template/.agents/skills/${skillName}`);
  fs.mkdirSync(harnessSkillDir, { recursive: true });
  const harnessSkillPath = path.join(harnessSkillDir, 'SKILL.md');
  fs.writeFileSync(harnessSkillPath, skillTemplate, 'utf8');
  console.log(`[Harness] Created skill "${skillName}" template at ${harnessSkillPath}`);

  try {
    execSync(`git -C "${harnessPath}" add "${harnessSkillPath}"`, { stdio: 'inherit' });
    console.log(`[Harness] Successfully added to git`);
  } catch (e) {
    console.warn(`[Harness] Failed to git add: ${e.message}`);
  }
} else {
  console.log(`[Harness] create-agent-harness project not found at: ${harnessPath}`);
}

console.log('Skill generation & sync process finished.');
