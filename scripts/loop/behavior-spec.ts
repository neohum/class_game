// behavior-spec.ts — 저장소가 담은 행동 스펙이 **온전한지** 본다.
//
// 게이트는 결과를 잰다. `evidence.ts` 는 카드가 무엇을 관찰했는지 묻고, ship 게이트는
// 리뷰가 붙었는지 묻는다. 둘 다 끝난 뒤의 질문이다. 그런데 에이전트가 한 카드에서
// 내리는 결정은 수백 개고, 그 대부분은 어떤 게이트도 보지 않는다 — 초록을 믿을지,
// 리뷰를 누가 할지, 못 한 것을 말할지. Agent Behavior(https://agentbehavior.dev)는
// 그 반복되는 처신을 `.agents/behaviors/<name>/BEHAVIOR.md` 에 적어 두는 형식이고,
// 이 스크립트는 그 파일들이 **사라지거나 어긋나지 않았는지** 지킨다.
//
// **규격 검증기가 아니다. 그러려다 다섯 번 실패했다.**
//
// 처음에는 frontmatter 의 YAML 을 직접 판정하려 했다. `agentbehavior` 패키지가 npm 에
// 없고(2026-08 기준 404) 이 디렉터리의 스크립트는 생성된 프로젝트에서 설치 없이
// 돌아야 해서 파서를 쓸 수 없었기 때문이다. 다섯 라운드에 걸쳐 독립 리뷰가 매번
// 새 입력을 찾아냈다 — 유효한 `yes`·`!!str`·anchor·여러 줄 값을 막고, 깨진
// `[unterminated`·`"\q"`·`[one] trailing` 을 통과시켰다. 손으로 만든 부분문법은
// 상류 파서와 같아질 수 없다. 그래서 **그 주장을 접었다.**
//
// 지금 이 도구가 검사하는 것은 YAML 이 아니라 **이 저장소의 위생**이다:
//
//   · `.agents/behaviors/<dir>/BEHAVIOR.md` 가 정식 이름으로 있는가
//   · 디렉터리가 끊어진 링크이거나, 저장소 밖을 가리키거나, 읽을 수 없지 않은가
//   · 파일이 `name: <dir>` 를 **그 디렉터리 이름 그대로** 선언하는가
//   · 비어 있지 않은 `description:` 줄이 있는가
//   · frontmatter 뒤에 본문이 있는가
//
// 이 다섯은 YAML 을 파싱하지 않고도 확실히 판정할 수 있고, 실제로 일어나는 사고를
// 잡는다: 디렉터리 이름만 바꾸기, 파일 지우기, 내용 비우기, 링크로 대체하기.
// **값의 YAML 유효성은 상류 CLI 의 일이다** — npm 에 올라오면 그것을 부른다.
//
// Usage:
//   node scripts/loop/behavior-spec.ts list  [--root <dir>]
//   node scripts/loop/behavior-spec.ts check [--root <dir>]

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 규격이 요구하는 정식 파일 이름. */
const CANONICAL_FILE = "BEHAVIOR.md";

/** 규격이 정한 이름 모양과 상한. */
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type BehaviorSpec = {
  /** 디렉터리 이름 — 규격이 말하는 안정된 식별자다. */
  name: string;
  /** `description:` 줄의 원문(따옴표를 벗기지 않는다). 표시용이다. */
  description: string;
  location: string;
  problems: string[];
};

export class BehaviorDiscoveryError extends Error {}

/**
 * frontmatter 블록의 줄들을 돌려준다. 여는 구분자 뒤의 공백은 YAML 이 허용한다.
 */
function frontmatterLines(source: string): { lines: string[] | null; body: string } {
  const text = source.replace(/^﻿/, "");
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { lines: null, body: text };
  return { lines: (match[1] ?? "").split(/\r?\n/), body: text.slice(match[0].length) };
}

/**
 * 최상위 `key:` 줄의 값을 원문 그대로 돌려준다. 들여쓴 줄은 앞선 키에 딸린 값이므로
 * 건너뛴다. **값을 해석하지 않는다** — 이 도구는 값이 무엇인지 판정하지 않는다.
 */
function declaredValue(lines: string[], key: string): string | null {
  // **아직 닫히지 않은 flow 안의 줄은 최상위가 아니다.** 들여쓰기만 보던 판은
  // `future: {` 다음 줄의 `name: 다른것,` 을 최상위 `name` 으로 읽어, 진짜 이름이
  // 없거나 달라도 통과시켰다 — 독립 리뷰가 재현했다.
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opened = depth;
    depth += flowDelta(line);
    if (depth < 0) depth = 0;
    if (opened > 0) continue;
    if (/^\s/.test(line)) continue;
    // **키는 "콜론+공백" 에서 끝난다.** YAML 의 평문 키는 콜론을 품을 수 있어서
    // `description:extension: value` 의 키는 `description:extension` 이다. 첫
    // 콜론에서 자르던 판은 그것을 `description` 으로 읽어, 진짜 `description` 이
    // 없어도 통과시켰다 — 독립 리뷰가 짚었다.
    const separator = line.search(/:(\s|$)/);
    if (separator <= 0) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1).trim();
    // 블록 스칼라는 **토큰이 아니라 이어지는 줄들이 값이다.** `description: |-` 를
    // 값으로 세던 판은 실제 내용이 비어도 "비어 있지 않다" 고 봤다.
    if (/^[|>][-+]?\d*[-+]?$/.test(value)) {
      const collected: string[] = [];
      for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
        const next = lines[ahead] ?? "";
        if (next.trim() === "") {
          collected.push("");
          continue;
        }
        if (!/^\s/.test(next)) break;
        collected.push(next.trim());
      }
      return collected.join(value.startsWith(">") ? " " : "\n").trim();
    }
    return value;
  }
  return null;
}

/** 따옴표 한 겹만 벗긴다. 값 해석이 아니라 **선언한 이름과의 대조**를 위해서다. */
/** 따옴표 밖의 `{[` 만 세어 flow 깊이 변화를 낸다. */
function flowDelta(line: string): number {
  let delta = 0;
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#") break;
    else if (character === "[" || character === "{") delta += 1;
    else if (character === "]" || character === "}") delta -= 1;
  }
  return delta;
}

/**
 * 값에서 **따옴표 밖의 주석을 먼저 자르고**, 그 뒤에 따옴표 한 겹을 벗긴다.
 *
 * 순서를 뒤집으면 `name: "이름" # 주석` 이 따옴표째 남아 디렉터리 이름과 어긋난다 —
 * 독립 리뷰가 짚었다.
 */
function unquoteOnce(value: string): string {
  let quote = "";
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      end = index;
      break;
    }
  }
  const withoutComment = value.slice(0, end).trim();
  const match = withoutComment.match(/^(["'])([\s\S]*)\1$/);
  return match ? (match[2] ?? "") : withoutComment;
}

/**
 * `.agents/behaviors/` 아래의 스펙을 전부 찾는다.
 *
 * **손상은 "스펙 없음" 이 아니다.** 읽을 수 없는 것을 빈 목록으로 돌려주던 판에서는
 * 배포되는 스펙을 지워도 검사와 health 가 초록이었다.
 */
export function discover(root: string): BehaviorSpec[] {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot)) throw new BehaviorDiscoveryError(`루트가 없다: ${absoluteRoot}`);
  requireReadableDirectory(join(absoluteRoot, ".agents"), ".agents", true);
  const base = join(absoluteRoot, ".agents", "behaviors");
  if (!requireReadableDirectory(base, ".agents/behaviors", true)) return [];

  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    throw new BehaviorDiscoveryError(".agents/behaviors 를 읽을 수 없다");
  }
  const specs: BehaviorSpec[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(base, entry.name);
    if (entry.isDirectory()) {
      specs.push(inspect(base, entry.name, absoluteRoot));
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    // 링크는 Git 에 mode 120000 으로만 들어간다 — 가리키는 바이트는 배포되지 않는다.
    specs.push({
      name: entry.name,
      description: "",
      location: relative(absoluteRoot, path).split(/[\\/]/).join("/"),
      problems: [existsSync(path) ? "링크다 — 스펙은 이 저장소 안의 실제 디렉터리여야 한다" : "끊어진 링크다"],
    });
  }
  return specs;
}

/** 존재하면 읽을 수 있는 디렉터리여야 한다. 없으면 false(그리고 그것은 오류가 아니다). */
function requireReadableDirectory(path: string, label: string, allowMissing: boolean): boolean {
  // **링크는 Git 에 mode 120000 으로만 들어간다.** 살아 있는 링크라도 가리키는
  // 바이트는 배포되지 않으므로, 이 게이트가 검증한 것과 clone 이 받는 것이 다르다.
  // `statSync` 는 링크를 따라가서 이것을 못 본다 — 독립 리뷰가 짚었다.
  try {
    if (lstatSync(path).isSymbolicLink()) throw new BehaviorDiscoveryError(`${label} 가 링크다 — 실제 디렉터리여야 한다`);
  } catch (error) {
    if (error instanceof BehaviorDiscoveryError) throw error;
    // 없으면 아래 statSync 가 판정한다.
  }
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new BehaviorDiscoveryError(`${label} 를 읽을 수 없다`);
    // ENOENT 인데 항목 자체는 있으면 끊어진 링크다.
    try {
      lstatSync(path);
    } catch {
      if (allowMissing) return false;
      throw new BehaviorDiscoveryError(`${label} 가 없다`);
    }
    throw new BehaviorDiscoveryError(`${label} 가 끊어진 링크다`);
  }
  if (!stat.isDirectory()) throw new BehaviorDiscoveryError(`${label} 가 디렉터리가 아니다`);
  return true;
}

function inspect(base: string, directory: string, root: string): BehaviorSpec {
  const directoryPath = join(base, directory);
  const problems: string[] = [];

  let names: string[];
  try {
    names = readdirSync(directoryPath);
  } catch {
    return { name: directory, description: "", location: relative(root, directoryPath).split(/[\\/]/).join("/"), problems: [...problems, "디렉터리를 읽을 수 없다"] };
  }

  // **파일시스템이 판정을 바꾸지 않게 한다.** `existsSync(BEHAVIOR.md)` 는 대소문자를
  // 무시하는 파일시스템에서 `behavior.md` 에도 성공해, 같은 checkout 이 macOS 에서는
  // 통과하고 Linux 에서는 실패했다. 실제 항목 이름으로 판정한다.
  const actual = names.includes(CANONICAL_FILE)
    ? CANONICAL_FILE
    : names.find((name) => name.toLowerCase() === CANONICAL_FILE.toLowerCase());
  const location = relative(root, join(directoryPath, actual ?? CANONICAL_FILE)).split(/[\\/]/).join("/");
  if (actual === undefined) return { name: directory, description: "", location, problems: [...problems, `${CANONICAL_FILE} 이 없다`] };
  if (actual !== CANONICAL_FILE) problems.push(`파일 이름이 ${actual} 다 — 이식성을 위해 ${CANONICAL_FILE} 를 쓴다`);

  if (directory.length > MAX_NAME_LENGTH) problems.push(`디렉터리 이름이 ${MAX_NAME_LENGTH}자를 넘는다`);
  if (!NAME_PATTERN.test(directory)) {
    problems.push("디렉터리 이름은 소문자·숫자·하이픈만 쓰고 하이픈으로 시작하거나 끝나지 않는다");
  }

  // 파일 자체가 링크여도 Git 에는 mode 120000 만 들어간다 — 디렉터리와 같은 이유다.
  try {
    if (lstatSync(join(directoryPath, actual)).isSymbolicLink()) {
      return { name: directory, description: "", location, problems: [...problems, `${CANONICAL_FILE} 이 링크다 — 실제 파일이어야 한다`] };
    }
  } catch {
    return { name: directory, description: "", location, problems: [...problems, "읽을 수 없다"] };
  }

  let source: string;
  try {
    source = readFileSync(join(directoryPath, actual), "utf8");
  } catch {
    return { name: directory, description: "", location, problems: [...problems, "읽을 수 없다"] };
  }

  const { lines, body } = frontmatterLines(source);
  if (lines === null) return { name: directory, description: "", location, problems: [...problems, "YAML frontmatter가 없다"] };

  // **디렉터리 이름이 식별자다.** 파일은 그것을 그대로 선언해야 한다 — 값을 해석하지
  // 않고 대조만 한다. 디렉터리만 바꾸고 파일을 두는 사고가 여기서 잡힌다.
  const declaredName = declaredValue(lines, "name");
  if (declaredName === null || declaredName === "") {
    problems.push("frontmatter `name:` 이 없다");
  } else if (unquoteOnce(declaredName) !== directory) {
    problems.push(`\`name:\` (${declaredName}) 이 디렉터리 이름(${directory})과 다르다`);
  }

  const declaredDescription = declaredValue(lines, "description");
  if (declaredDescription === null || unquoteOnce(declaredDescription).trim() === "") {
    problems.push("frontmatter `description:` 이 없거나 비어 있다");
  } else if (unquoteOnce(declaredDescription).length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`\`description:\` 이 ${MAX_DESCRIPTION_LENGTH}자를 넘는다`);
  }

  if (!body.trim()) problems.push("본문이 비어 있다 — 어떤 행동인지 적지 않았다");

  return { name: directory, description: unquoteOnce(declaredDescription ?? ""), location, problems };
}

/** 검사한다. 문제가 하나라도 있으면 false. */
export function check(root: string): { specs: BehaviorSpec[]; ok: boolean } {
  const specs = discover(root);
  return { specs, ok: specs.every((spec) => spec.problems.length === 0) };
}

/**
 * `--root <dir>` 와 동사 하나를 읽는다.
 *
 * 처음에는 `--root` 의 값을 인덱스로 걸러냈는데, 플래그가 없으면 그 인덱스가
 * `-1 + 1 = 0` 이라 **동사 자신을 값으로 보고 버렸다** — `list` 가 조용히 `check` 로
 * 떨어졌다. 그래서 순회하며 플래그와 값을 함께 소비한다.
 */
export function parseArguments(argv: string[]): { action: string; root: string; error?: string } {
  let root = ".";
  let action = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { action, root, error: "--root 에 디렉터리가 없다" };
      root = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) return { action, root, error: `모르는 플래그: ${argument}` };
    if (action) return { action, root, error: `동사는 하나만 받는다: ${action}, ${argument}` };
    action = argument;
  }
  return { action: action || "check", root };
}

export function main(argv: string[]): number {
  const parsed = parseArguments(argv);
  if (parsed.error) {
    console.error(parsed.error);
    console.error("usage: behavior-spec.ts list|check [--root <dir>]");
    return 2;
  }
  if (parsed.action !== "list" && parsed.action !== "check") {
    console.error("usage: behavior-spec.ts list|check [--root <dir>]");
    return 2;
  }
  let specs: BehaviorSpec[];
  try {
    specs = discover(resolve(parsed.root));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const broken = specs.filter((spec) => spec.problems.length > 0);
  if (parsed.action === "list") {
    // **온전하지 않은 스펙을 정상 레코드로 내보내지 않는다.** 목록을 읽는 도구가
    // 그것을 유효한 것으로 적재하면, 이 게이트가 잡은 문제가 아래로 새어 나간다.
    for (const spec of specs.filter((entry) => entry.problems.length === 0)) {
      console.log(`${spec.name}\t${spec.location}\t${spec.description}`);
    }
    for (const spec of broken) {
      for (const problem of spec.problems) console.error(`${spec.location}: ${problem}`);
    }
    if (specs.length === 0) console.log("행동 스펙 없음 (.agents/behaviors/)");
    return broken.length > 0 ? 1 : 0;
  }

  for (const spec of broken) {
    for (const problem of spec.problems) console.error(`${spec.location}: ${problem}`);
  }
  if (broken.length > 0) {
    console.error(`행동 스펙 검사 실패 (${specs.length}개 중 ${broken.length}개)`);
    return 1;
  }
  console.log(`행동 스펙: ok (${specs.length}개)`);
  return 0;
}

// **경로를 실경로로 맞춰 비교한다.** `import.meta.url` 은 심볼릭 링크를 푼 경로를
// 주는데 `process.argv[1]` 은 사용자가 친 그대로다. macOS 의 `/tmp` → `/private/tmp`
// 처럼 한쪽만 풀리면 이 블록이 통째로 건너뛰어져, CLI 가 아무것도 하지 않고 종료
// 코드 0 으로 끝난다 — 게이트가 사라지는데 아무도 모른다.
if (process.argv[1]) {
  const entry = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  const same = entry === invoked || (() => {
    try {
      return realpathSync(entry) === realpathSync(invoked);
    } catch {
      return false;
    }
  })();
  if (same) process.exit(main(process.argv.slice(2)));
}
