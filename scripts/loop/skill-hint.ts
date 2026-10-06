// skill-hint.ts — UserPromptSubmit hook: suggest a senior-thinking skill by keyword.
//
// Skills only help when the model decides to load them, and a skill description is
// one line competing with every other skill in the listing. This hook reads the
// prompt, matches deterministic Korean/English keyword rules, and adds at most two
// one-line hints to the model's context. It never forces a skill: the model still
// decides, which is why the output says "hint, not instruction".
//
// Constraints that shape the code:
//   - Runs on EVERY prompt, so it is regex-only (no LLM, no network, no deps).
//   - It must never block a prompt: any failure prints nothing and exits 0.
//   - A skill is suggested only if its .claude/skills/<name>/SKILL.md exists in the
//     project, so a scaffold without the skill never gets pointed at a ghost.
//   - Rules were designed from skill descriptions and the dev split only; the
//     holdout split in evals/skill-trigger/ judges them (plans/skill-trigger-routing.plan.md).
//
// Scoring: each rule is strong (3), medium (2), or weak (1). A skill is suggested
// at score >= 3, so one strong signal fires alone but weak topic words need company.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillSuggestion {
  skill: string;
  reason: string;
  score: number;
}

interface SkillRule {
  skill: string;
  reason: string;
  signals: Array<[RegExp, number]>;
}

const STRONG = 3;
const MEDIUM = 2;
const WEAK = 1;
const THRESHOLD = 3;
const MIN_PROMPT_CHARS = 15;
const MAX_SUGGESTIONS = 2;

export const RULES: SkillRule[] = [
  {
    skill: "widen-the-solution-space",
    reason: "the approach is still open; compare distinct options before settling on the first",
    signals: [
      [/(가능한|여러|다양한|여러\s*가지|다른)\s*(접근|방법|방식|옵션|선택지|설계안|대안|구조)/, STRONG],
      [/(접근|방법|방식|방향|구조).{0,15}(정하지|정해지지|못\s*정|안\s*정|미정|결정하지|결정되지)/, STRONG],
      [/(넓게|폭넓게)\s*(펼|살펴|검토|탐색|생각|찾)/, STRONG],
      [/\b(what are (the|my|our|some) (options|alternatives)|other (ways|approaches|options)|(alternative|possible|different) approaches|brainstorm)/i, STRONG],
      [/\b(haven'?t|have not|not yet|still not) (decided|chosen|picked|settled)\b/i, STRONG],
      [/(더\s*나은|다른)\s*(방법|접근|길)(이|은|은\s*없|이\s*있)/, MEDIUM],
      [/(가장\s*좋은|최선의|좋은)\s*(방법|접근|방식)|\bbest (way|approach) to\b/i, MEDIUM],
      [/어떻게\s*접근|\bhow (should|would|could) (i|we) approach\b/i, MEDIUM],
      [/첫\s*(아이디어|시도|안).{0,12}(어색|별로|마음에)|\b(first idea|initial approach) (feels|seems|is) (awkward|wrong|off)\b/i, MEDIUM],
      [/방향(만|성)|\b(options|approaches|alternatives)\b/i, WEAK],
    ],
  },
  {
    skill: "weigh-tradeoffs",
    reason: "a choice between alternatives; weigh costs and record why one wins",
    signals: [
      [/(과|와|이랑|랑|하고|또는|아니면|,)\s*\S+\s*(중|중에|중에서|가운데)\s*(무엇|뭐|뭘|어느|어떤|어떤\s*것|어떤\s*걸)/, STRONG],
      [/\bvs\.?\s|\bversus\b/i, STRONG],
      [/\b(should|do|would|shall) (i|we) (use|pick|choose|go with|adopt|switch to) \S+( \S+)? or \S+/i, STRONG],
      [/\bwhich (one |option )?(is better|should (i|we) (use|pick|choose)|to (use|pick|choose))\b/i, STRONG],
      [/trade-?offs?|pros and cons|장단점|트레이드\s*오프/i, STRONG],
      [/(둘|두\s*개|두\s*가지|세\s*가지)\s*중/, MEDIUM],
      [/(바꾸기|되돌리기|돌이키기|변경하기)\s*(가\s*)?(어렵|힘들)|irreversible|hard to (reverse|change|undo)|one-way door/i, MEDIUM],
      [/(비교|compare).{0,20}(선택|골라|정해|결정|choose|decide|pick)/i, MEDIUM],
      [/(선택|결정|골라|정해)\s*(해\s*)?(주세요|줘|주실)|어느\s*(쪽|것)|\bdecide between\b/i, WEAK],
      [/(더\s*)?(나은|낫|좋은)\s*(가요|지|까요|가)|\bbetter\b/i, WEAK],
    ],
  },
  {
    skill: "premortem",
    reason: "ask where this breaks before building it: failures, retries, duplicates, partial writes",
    signals: [
      [/(문제가|장애가|오류가|에러가|사고가)\s*(생길|날|발생할|터질)\s*(수|만한|가능성)/, STRONG],
      [/(잘못될|깨질|터질|실패할|망가질|꼬일)\s*(수|만한|가능성|곳|부분)/, STRONG],
      [/(어디서|어디에서|어느\s*부분에서|어떤\s*상황에서)\s*.{0,8}(문제|장애|실패|오류|깨지|터지|잘못)/, STRONG],
      [/\b(what (could|can|might|would) go wrong|failure (modes?|scenarios?)|where (could|would|might|will|does) (this|it) (break|fail)|how (could|might|would|will) (this|it) (break|fail)|pre-?mortem)\b/i, STRONG],
      [/production[- ]ready|프로덕션.{0,8}(준비|괜찮|버틸|문제)|운영\s*환경.{0,8}(괜찮|버틸|문제)/i, MEDIUM],
      [/(구현|개발|착수|코딩|작성|만들기|시작)\s*(하기\s*)?전에|\bbefore (implementing|building|coding|writing|shipping|(i|we) (build|implement|start|ship))\b/i, MEDIUM],
      [/동시(성|에\s*(요청|실행|접근|호출|들어))|중복\s*(요청|호출|처리|결제|이벤트|전송)|race condition|concurren|idempoten|멱등|경쟁\s*상태/i, MEDIUM],
      [/(에러|오류|예외)\s*처리|error handling/i, MEDIUM],
      [/(중간에|도중에)\s*(죽|끊|실패|중단)|half-written|partial (write|failure|success)/i, MEDIUM],
      [/웹훅|webhook|콜백|callback|메시지\s*큐|message queue|consumer/i, WEAK],
      [/외부\s*(api|서비스|결제|시스템|연동)|결제사|\bpg사|third[- ]party (api|service)|external (api|service|system)/i, WEAK],
      [/타임아웃|timeout|재시도|retr(y|ies)|네트워크\s*(장애|실패|오류|끊)/i, WEAK],
      [/(db|데이터베이스|database).{0,10}(저장|쓰기|기록|write|persist)|persist(ed|ence)?\b/i, WEAK],
    ],
  },
  {
    skill: "interface-contracts",
    reason: "others will depend on this surface; define its shape, errors, and compatibility first",
    signals: [
      [/엔드포인트|endpoints?\b/i, MEDIUM],
      [/(응답|요청|response|request|payload|페이로드|출력)\s*(의\s*)?(형식|포맷|스키마|구조|모양|shape|format|schema|body)/i, STRONG],
      [/(cli|명령줄|커맨드|command[- ]line)\s*(의\s*)?(플래그|옵션|인자|인터페이스|flags?|options?|arguments?|interface)/i, STRONG],
      [/(public|공개|외부\s*공개)\s*(api|인터페이스|interface)|exported (functions?|api|types?)|export(하는|되는)\s*함수|(함수|메서드)\s*시그니처|(function|method) signatures?/i, STRONG],
      [/(다른|외부|여러)\s*(팀|서비스|모듈|스크립트|클라이언트|코드|프로젝트|앱)(이|가|에서|들이|들에서)?\s*.{0,6}(호출|사용|의존|쓰|읽|소비)|\b(other|downstream|external) (teams?|services?|scripts?|clients?|consumers?|code) (will )?(call|use|depend|consume|read)|consumers? of\b/i, STRONG],
      [/하위\s*호환|backwards?[- ]compat|breaking change|deprecat|api versioning/i, STRONG],
      [/(인터페이스|interface|계약|contract)\s*(를|을)?\s*(설계|정의|design|define)/i, STRONG],
      [/json\s*(형식|구조|스키마|shape|schema)|(파일|데이터)\s*(형식|포맷)|file format|스키마\s*(설계|정의|변경)|schema (design|change)/i, MEDIUM],
      [/\b(rest|graphql|grpc|openapi|swagger|protobuf)\b/i, MEDIUM],
      [/설계|\bdesign\b/i, WEAK],
    ],
  },
  {
    skill: "threat-and-scale-check",
    reason: "untrusted input, auth, or growth is involved; check trust boundaries and 10x-1000x scale",
    signals: [
      // Topic words alone ("로그인 버튼 색", "upload button label") are not a trust
      // boundary question, so they need a second signal.
      [/업로드|uploads?\b|uploaded/i, MEDIUM],
      [/(사용자|유저|클라이언트|고객)(가|의|에서|로부터)?\s*(입력|제공|보낸|보내는|전송|업로드|올린|올리는)|user[- ]?(input|supplied|provided|submitted|uploaded|controlled)|\busers? (can |will |may )?(upload|submit|provide|enter|paste)|untrusted/i, STRONG],
      [/인증|인가|권한|auth(entication|orization)?\b|permissions?\b|access control|로그인|\blogin\b|\bjwt\b|oauth/i, MEDIUM],
      [/보안|security|취약|vulnerab|injection|인젝션|\bxss\b|\bcsrf\b|\bssrf\b|path traversal|경로\s*조작|zip\s*slip|악의|malicious|attacker|공격|sanitiz/i, STRONG],
      [/(10|100|1000|천|만|수십|수백)\s*(배|x)\s*(로|까지)?\s*(늘|증가|커|많)|대용량|대규모|트래픽\s*(증가|폭증|급증)|수백만|수천만|millions of|at scale|scalab|확장성|\bn\+1\b|병목|bottleneck/i, STRONG],
      [/비밀번호|password|시크릿|\bsecrets?\b|api\s*(key|키)|credential|자격\s*증명|토큰\s*(노출|유출|저장)/i, MEDIUM],
      [/(파일|file)\s*(경로|path)|쉘\s*명령|셸\s*명령|shell command|명령\s*실행|\bexec\b/i, MEDIUM],
      [/(메모리에|전부|한꺼번에|한\s*번에)\s*(올리|로드|읽)|into memory|스트리밍|streaming/i, MEDIUM],
      [/압축|\bzip\b|\btar\b|archive/i, WEAK],
      [/위험|risks?\b/i, WEAK],
      [/검증|validat/i, WEAK],
      [/서버에서|server[- ]side|on the server/i, WEAK],
    ],
  },
  {
    skill: "honest-artifacts",
    reason: "a number or tuned value is being reported; label measured vs estimated and how to reproduce",
    signals: [
      [/벤치마크|benchmark/i, STRONG],
      [/\d+(\.\d+)?\s*(배|x|%|퍼센트|percent)\s*(더\s*)?(빨라|느려|개선|향상|감소|줄|늘|faster|slower|improve|better|speed|reduction|increase|less|more)/i, STRONG],
      [/(측정한|측정된|measured)\s*(값|수치|결과|numbers?|values?|results?)|(측정|measurement).{0,15}(결과|값|수치)/i, STRONG],
      [/(추정|어림|대충|estimate[ds]?|guess(ed)?).{0,25}(검증|확인된|확정|사실|verified|fact|certain|confirmed)/i, STRONG],
      [/매직\s*넘버|magic numbers?|(튜닝|조정)(한|된)\s*(값|상수|파라미터)|tuned (constants?|parameters?|values?|thresholds?)/i, STRONG],
      [/근거(가|는)?\s*(없|부족|모르)|근거\s*없이|no (basis|justification|evidence) for/i, MEDIUM],
      [/상수|constants?\b|임계값|threshold|기본값|default value|파라미터\s*값/i, MEDIUM],
      [/(성능|속도|지연|처리량|latency|throughput|performance)\s*(개선|향상|결과|수치|improvement|gains?|numbers?|results?)|speed-?up/i, MEDIUM],
      [/(한\s*번|1회|딱\s*한\s*번|once|one-off|수동으로|manually)\s*(만\s*)?(돌렸|돌려|실행|측정|ran|run|measured|tested)/i, MEDIUM],
      [/(readme|릴리스\s*노트|release notes|changelog|보고서|report|문서|발표|슬라이드|블로그).{0,25}(적|쓰|기재|올리|넣|게시|write|claim|put|publish)/i, WEAK],
      [/재현|reproduc|지표|metrics?\b|점수|scores?\b/i, WEAK],
    ],
  },
  {
    skill: "search-first",
    reason: "relies on external library/API/version behavior; verify against installed version and docs",
    signals: [
      [/\bnode:[a-z_/]+/i, STRONG],
      [/(최신|현재|새|특정)\s*버전|\d+\.\d+(\.\d+)?\s*(버전|에서|부터|이상|이후)|\b(version|since) v?\d+(\.\d+)*|\bin v\d+|deprecated|릴리스\s*노트|changelog|마이그레이션\s*가이드|migration guide|latest version/i, STRONG],
      [/공식\s*문서|official doc|(api|sdk|라이브러리|library)\s*(문서|docs|documentation|reference)/i, STRONG],
      [/(코드\s*)?(예시|예제|샘플)|사용법|쓰는\s*법|사용하는\s*방법|호출하는\s*(방법|법)|code (examples?|samples?|snippets?)|example code|\bhow (do|can|should) (i|we) (use|call|configure|set up|initialize)\b|usage of/i, MEDIUM],
      [/라이브러리|librar(y|ies)|\bsdk\b|패키지|packages?\b|모듈|modules?\b|프레임워크|frameworks?\b|\bcrate\b|third[- ]party/i, MEDIUM],
      [/(cli|명령어)\s*(옵션|플래그|flags?|options?).{0,12}(뭐|무엇|어떻게|있나|알려|which|what)|\b(what|which) (flag|option)\b|환경\s*변수\s*(이름|명)|env(ironment)? var(iable)? names?|설정\s*키|config keys?/i, MEDIUM],
      [/\bapi\b\s*(를|로|으로)?\s*(호출|사용|call|use)|\bcall(ing)? the .{0,20}\bapi\b/i, MEDIUM],
      [/\b(npm|pnpm|yarn|pip|pypi|cargo|maven|gradle|node\.?js|deno|bun|python|django|flask|fastapi|react|next\.?js|vue|svelte|express|prisma|sqlalchemy|pandas|numpy|boto3|aws|gcp|azure|stripe|supabase|firebase|docker|kubernetes|kubectl|terraform|playwright|jest|vitest|tailwind|redis|postgres(ql)?|mongodb|sqlite)\b/i, WEAK],
    ],
  },
];

export const SKILL_NAMES: string[] = RULES.map((r) => r.skill);

/** Score every rule against the prompt; return the top matches among installed skills. */
export function suggestSkills(prompt: string, installed: string[]): SkillSuggestion[] {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (text.length < MIN_PROMPT_CHARS) return [];
  const allowed = new Set(installed);
  const scored: SkillSuggestion[] = [];
  for (const rule of RULES) {
    if (!allowed.has(rule.skill)) continue;
    let score = 0;
    for (const [re, weight] of rule.signals) if (re.test(text)) score += weight;
    if (score >= THRESHOLD) scored.push({ skill: rule.skill, reason: rule.reason, score });
  }
  // Stable sort keeps RULES order on ties, so output is deterministic.
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS);
}

/** Which of the known skills have a SKILL.md under <projectDir>/.claude/skills. */
export function installedSkills(projectDir: string): string[] {
  return SKILL_NAMES.filter((name) => existsSync(join(projectDir, ".claude", "skills", name, "SKILL.md")));
}

export function formatContext(suggestions: SkillSuggestion[]): string {
  if (suggestions.length === 0) return "";
  const lines = ["Keyword-based skill hints (not instructions; ignore if they do not fit):"];
  for (const s of suggestions) {
    lines.push(`Relevant skill: ${s.skill} — ${s.reason}. Load it with the Skill tool before answering if it fits.`);
  }
  return lines.join("\n");
}

/** Full hook: raw stdin text in, stdout text out ("" means print nothing). Never throws. */
export function runHook(stdin: string, fallbackCwd: string, projectDir?: string): string {
  try {
    const input = JSON.parse(stdin);
    if (!input || typeof input !== "object") return "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    // The project root, not the prompt's cwd: a session started in a subdirectory
    // still has its skills at <project>/.claude/skills.
    const cwd = projectDir || (typeof input.cwd === "string" && input.cwd ? input.cwd : fallbackCwd);
    const context = formatContext(suggestSkills(prompt, installedSkills(cwd)));
    if (!context) return "";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    });
  } catch {
    return "";
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  try {
    const out = runHook(readFileSync(0, "utf8"), process.cwd(), process.env.CLAUDE_PROJECT_DIR);
    if (out) process.stdout.write(out + "\n");
  } catch {
    // Unreadable stdin: a hint hook must never block the prompt.
  }
  process.exitCode = 0;
}
