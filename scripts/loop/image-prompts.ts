// image-prompts.ts — Curated image generation prompt recipes catalog and renderer.
//
// Collects, categorizes, renders, and synchronizes high-taste image generation
// prompt templates (e.g. Layered paper-cut, isometric tech vector, claymorphism, etc.)
// for use in Antigravity generate_image, UI assets, and creative design loops.
//
// Usage:
//   node scripts/loop/image-prompts.ts list
//   node scripts/loop/image-prompts.ts get layered-paper-cut
//   node scripts/loop/image-prompts.ts render layered-paper-cut --subject "a futuristic coffee shop"
//   node scripts/loop/image-prompts.ts search "paper"
//   node scripts/loop/image-prompts.ts add --id "cyber-glass" --name "Cyber Glass" --template "..."

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ImagePromptRecipe {
  id: string;
  name: string;
  category: "illustration" | "vector" | "3d" | "editorial" | "ui-asset" | "photo" | "abstract" | string;
  description: string;
  template: string;
  placeholder?: string;
  defaultSubject?: string;
  tags: string[];
  aspectRatios?: string[];
  negativePrompt?: string;
  examples?: string[];
}

export interface ImagePromptCatalog {
  version: string;
  updatedAt: string;
  description: string;
  recipes: ImagePromptRecipe[];
}

export const DEFAULT_PLACEHOLDERS = ["[subject]", "[원하는 사항 적기]", "[원하는 사항]", "[topic]"];

/** Resolves the path to image-prompts.json */
export function findCatalogPath(root = process.cwd()): string {
  const candidates = [
    join(root, "docs", "image-prompts.json"),
    join(root, ".harness", "image-prompts.json"),
    join(root, "template", "docs", "image-prompts.json"),
  ];

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return join(root, "docs", "image-prompts.json");
}

/** Loads the prompt recipes catalog from disk. */
export function loadCatalog(root = process.cwd()): ImagePromptCatalog {
  const p = findCatalogPath(root);
  if (!existsSync(p)) {
    return {
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
      description: "Image generation prompt recipes",
      recipes: [],
    };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`Warning: Failed to parse catalog at ${p}:`, err);
    return {
      version: "1.0.0",
      updatedAt: new Date().toISOString(),
      description: "Image generation prompt recipes (fallback)",
      recipes: [],
    };
  }
}

/** Saves the prompt catalog to disk. */
export function saveCatalog(catalog: ImagePromptCatalog, root = process.cwd()): void {
  const p = findCatalogPath(root);
  catalog.updatedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

/** Lists prompt recipes with optional filtering. */
export function listRecipes(
  filter: { category?: string; tag?: string; query?: string } = {},
  root = process.cwd(),
): ImagePromptRecipe[] {
  const catalog = loadCatalog(root);
  let res = catalog.recipes;

  if (filter.category) {
    const cat = filter.category.toLowerCase();
    res = res.filter((r) => r.category.toLowerCase() === cat);
  }

  if (filter.tag) {
    const t = filter.tag.toLowerCase();
    res = res.filter((r) => r.tags.some((tag) => tag.toLowerCase() === t));
  }

  if (filter.query) {
    const q = filter.query.toLowerCase();
    res = res.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.template.toLowerCase().includes(q) ||
        r.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  return res;
}

/** Retrieves a single prompt recipe by ID. */
export function getRecipe(id: string, root = process.cwd()): ImagePromptRecipe | undefined {
  const catalog = loadCatalog(root);
  const targetId = id.trim().toLowerCase();
  return catalog.recipes.find((r) => r.id.toLowerCase() === targetId);
}

/**
 * Renders a prompt template by replacing the subject placeholder.
 */
export function renderPrompt(
  idOrRecipe: string | ImagePromptRecipe,
  subject?: string,
  root = process.cwd(),
): { prompt: string; negativePrompt?: string; recipe: ImagePromptRecipe } {
  const recipe = typeof idOrRecipe === "string" ? getRecipe(idOrRecipe, root) : idOrRecipe;
  if (!recipe) {
    throw new Error(`Prompt recipe not found: ${idOrRecipe}`);
  }

  const actualSubject = subject && subject.trim().length > 0 ? subject.trim() : recipe.defaultSubject || "modern digital workspace";

  let rendered = recipe.template;
  const placeholders = recipe.placeholder
    ? [recipe.placeholder, ...DEFAULT_PLACEHOLDERS]
    : DEFAULT_PLACEHOLDERS;

  for (const ph of placeholders) {
    if (rendered.includes(ph)) {
      rendered = rendered.split(ph).join(actualSubject);
    }
  }

  return {
    prompt: rendered,
    negativePrompt: recipe.negativePrompt,
    recipe,
  };
}

/** Adds or updates a prompt recipe in the catalog. */
export function addRecipe(
  recipe: ImagePromptRecipe,
  options: { root?: string; overwrite?: boolean } = {},
): ImagePromptRecipe {
  const root = options.root || process.cwd();
  const catalog = loadCatalog(root);
  const existingIdx = catalog.recipes.findIndex((r) => r.id.toLowerCase() === recipe.id.toLowerCase());

  if (existingIdx >= 0) {
    if (options.overwrite !== false) {
      catalog.recipes[existingIdx] = recipe;
    } else {
      throw new Error(`Recipe with id '${recipe.id}' already exists.`);
    }
  } else {
    catalog.recipes.push(recipe);
  }

  saveCatalog(catalog, root);
  return recipe;
}

export function formatRecipeDetails(recipe: ImagePromptRecipe): string {
  const lines: string[] = [];
  lines.push("==================================================");
  lines.push(`🎨 ${recipe.name} [${recipe.id}]`);
  lines.push("==================================================");
  lines.push(`Category:      ${recipe.category}`);
  lines.push(`Tags:          ${recipe.tags.join(", ")}`);
  if (recipe.aspectRatios && recipe.aspectRatios.length > 0) {
    lines.push(`Aspect Ratios: ${recipe.aspectRatios.join(", ")}`);
  }
  lines.push(`Description:   ${recipe.description}`);
  lines.push("--------------------------------------------------");
  lines.push("TEMPLATE:");
  lines.push(`"${recipe.template}"`);
  lines.push("--------------------------------------------------");
  if (recipe.defaultSubject) {
    lines.push(`Default Subject: "${recipe.defaultSubject}"`);
  }
  if (recipe.negativePrompt) {
    lines.push(`Negative Prompt: "${recipe.negativePrompt}"`);
  }
  if (recipe.examples && recipe.examples.length > 0) {
    lines.push("--------------------------------------------------");
    lines.push("EXAMPLES:");
    for (const ex of recipe.examples) {
      lines.push(`- "${ex}"`);
    }
  }
  lines.push("==================================================");
  return lines.join("\n");
}

export function runImagePromptsCli(args = process.argv.slice(2), root = process.cwd()): number {
  const cmd = args[0] || "list";

  if (cmd === "--help" || cmd === "-h") {
    console.log("Usage: image-prompts.ts <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  list, ls                 List all prompt recipes (--category, --tag, --json)");
    console.log("  get <id>                 Display full details of a specific recipe");
    console.log("  render <id> [--subject]  Render a prompt template with subject filled in");
    console.log("  search <query>           Search recipes by text or tag");
    console.log("  add                      Add or update a recipe in the catalog");
    console.log("");
    console.log("Examples:");
    console.log('  node scripts/loop/image-prompts.ts list');
    console.log('  node scripts/loop/image-prompts.ts render layered-paper-cut --subject "a cat coding"');
    console.log('  node scripts/loop/image-prompts.ts search paper');
    return 0;
  }

  if (cmd === "list" || cmd === "ls") {
    let category: string | undefined;
    let tag: string | undefined;
    let isJson = false;

    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (!a) continue;
      if (a === "--json") isJson = true;
      else if (a === "--category" && i + 1 < args.length) {
        const next = args[++i];
        if (next) category = next;
      } else if (a === "--tag" && i + 1 < args.length) {
        const next = args[++i];
        if (next) tag = next;
      }
    }

    const recipes = listRecipes({ category, tag }, root);

    if (isJson) {
      console.log(JSON.stringify(recipes, null, 2));
      return 0;
    }

    console.log(`\n🎨 Image Generation Prompt Catalog (${recipes.length} recipes):`);
    console.log("--------------------------------------------------------------------------------");
    for (const r of recipes) {
      console.log(`- [${r.id.padEnd(28)}] ${r.name.padEnd(30)} (${r.category})`);
      console.log(`  Tags: ${r.tags.slice(0, 5).join(", ")}`);
      console.log(`  Desc: ${r.description}`);
    }
    console.log("--------------------------------------------------------------------------------");
    console.log(`Use 'render <id> --subject "<subject>"' to render a complete prompt.\n`);
    return 0;
  }

  if (cmd === "get") {
    const id = args[1];
    if (!id) {
      console.error("Error: Please provide recipe ID (e.g. 'get layered-paper-cut')");
      return 2;
    }
    const recipe = getRecipe(id, root);
    if (!recipe) {
      console.error(`Error: Recipe not found: ${id}`);
      return 1;
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(recipe, null, 2));
    } else {
      console.log(formatRecipeDetails(recipe));
    }
    return 0;
  }

  if (cmd === "render") {
    const id = args[1];
    if (!id) {
      console.error("Error: Please provide recipe ID (e.g. 'render layered-paper-cut --subject \"...\"')");
      return 2;
    }

    let subject = "";
    let isJson = false;

    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (!a) continue;
      if (a === "--json") isJson = true;
      else if ((a === "--subject" || a === "-s") && i + 1 < args.length) {
        const next = args[++i];
        if (next) subject = next;
      } else if (!subject && !a.startsWith("-")) {
        subject = a;
      }
    }

    try {
      const res = renderPrompt(id, subject, root);
      if (isJson) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log("\n==================== RENDERED IMAGE PROMPT ====================");
        console.log(`Style:     ${res.recipe.name} [${res.recipe.id}]`);
        console.log(`Subject:   ${subject || "(default: " + res.recipe.defaultSubject + ")"}`);
        console.log("---------------------------------------------------------------");
        console.log(`PROMPT:\n${res.prompt}`);
        if (res.negativePrompt) {
          console.log("---------------------------------------------------------------");
          console.log(`NEGATIVE PROMPT:\n${res.negativePrompt}`);
        }
        console.log("===============================================================\n");
      }
      return 0;
    } catch (err: any) {
      console.error("Render failed:", err.message || err);
      return 1;
    }
  }

  if (cmd === "search") {
    const query = args[1] || "";
    if (!query) {
      console.error("Error: Please provide search query.");
      return 2;
    }
    const matches = listRecipes({ query }, root);
    console.log(`\n🔍 Found ${matches.length} matching prompt recipe(s) for "${query}":`);
    for (const m of matches) {
      console.log(`- [${m.id}] ${m.name} (${m.category}): ${m.description}`);
    }
    return 0;
  }

  if (cmd === "add") {
    let id = "";
    let name = "";
    let template = "";
    let category = "illustration";
    let tagsStr = "";
    let description = "";

    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (!a) continue;
      if (a === "--id" && i + 1 < args.length) { const n = args[++i]; if (n) id = n; }
      else if (a === "--name" && i + 1 < args.length) { const n = args[++i]; if (n) name = n; }
      else if (a === "--template" && i + 1 < args.length) { const n = args[++i]; if (n) template = n; }
      else if (a === "--category" && i + 1 < args.length) { const n = args[++i]; if (n) category = n; }
      else if (a === "--tags" && i + 1 < args.length) { const n = args[++i]; if (n) tagsStr = n; }
      else if (a === "--desc" && i + 1 < args.length) { const n = args[++i]; if (n) description = n; }
    }

    if (!id || !template) {
      console.error("Error: --id and --template are required to add a recipe.");
      return 2;
    }

    const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
    const recipe: ImagePromptRecipe = {
      id: id.toLowerCase().replace(/\s+/g, "-"),
      name: name || id,
      category,
      description: description || name || id,
      template,
      tags: tags.length > 0 ? tags : ["custom"],
    };

    addRecipe(recipe, { root });
    console.log(`✅ Added recipe '${recipe.id}' to catalog.`);
    return 0;
  }

  console.error(`Unknown command: ${cmd}`);
  return 2;
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("/image-prompts.ts")
);

if (isMain) {
  process.exit(runImagePromptsCli());
}
