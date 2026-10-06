/**
 * 에이전트 CLI를 띄울 때 **자식의 stdin을 무엇으로 둘지** 한 곳에서 정한다.
 *
 * # 무엇이 있었나
 *
 * `codex exec`가 `Reading additional input from stdin...`에서 14분 넘게 멈춰
 * 있었다. CPU 0%, 출력 39바이트 고정, 자식 프로세스 없음 — **"진행 중"과
 * 구별되지 않았다.** 사람이 "언제 끝나냐"고 묻기 전까지 아무도 몰랐다.
 *
 * 프롬프트를 인자로 줘도 CLI는 stdin이 열려 있으면 "더 줄 것이 있나" 하고
 * 기다린다. 사람이 터미널에서 부르면 Ctrl-D로 끝낼 수 있지만, 무인 실행에서
 * 부모의 stdin은 **열려 있고 아무도 안 쓰는 파이프**라 아무 일도 일어나지 않는다.
 *
 * # 왜 TTY로 판단하지 않는가
 *
 * 첫 판은 TTY 여부로 갈랐다. 독립 리뷰가 뚫었다 — 이 저장소는 이미
 * `HARNESS_UNATTENDED=1`을 무인 실행의 권위 있는 신호로 정의하고
 * **"PTY를 가진 팩토리도 팩토리"**라고 못박아 놨다. Orca 터미널·`ssh -t`·PTY
 * 감독기 안에서 무인 루프를 돌리면 `isTTY`는 참이고, TTY 규칙은 stdin을 다시
 * 물려줘 같은 멈춤이 남는다.
 *
 * # 왜 규칙이 둘인가
 *
 * 도구마다 stdin의 **의미가 다르다.**
 *
 * - `invoke-gemini.ts`는 머리말에 `cat corpus | invoke-gemini "질문"`을 문서화한다.
 *   거기서 파이프는 버려야 할 위험이 아니라 **입력 채널**이다. 첫 판은 이것을
 *   비-TTY라는 이유로 끊어서 **문서화된 기능을 조용히 깨뜨렸다** — 리뷰가 잡았다.
 * - `invoke-codex`·`invoke-claude`·`invoke-agy`는 프롬프트를 argv로만 받는다.
 *   stdin은 입력 채널이 아니므로 사람이 보고 있을 때만 물려준다.
 *
 * 무인 실행에서는 **둘 다 끊는다.** 무인 루프가 코퍼스를 파이프로 밀어 넣는
 * 경로는 없다 — 그때는 `--input <file>`을 쓴다.
 */
import { isUnattended } from "./autonomy.ts";

type Env = NodeJS.ProcessEnv;

/** `child_process`의 stdio 첫 칸에 그대로 넣는 값. */
export type StdinMode = "inherit" | "ignore";

interface Ctx {
  env?: Env;
  /** 기본값은 실제 프로세스의 stdin. 시험에서 갈아 끼운다. */
  isTTY?: boolean;
}

const ctx = (c: Ctx = {}) => ({
  env: c.env ?? process.env,
  isTTY: c.isTTY ?? Boolean(process.stdin.isTTY),
});

/**
 * 프롬프트를 **argv로만** 받는 CLI(codex·claude·agy)의 stdin.
 *
 * 사람이 터미널에서 부를 때만 물려준다. 그 밖에는 끊는다 — 이 도구들에게
 * stdin은 입력 채널이 아니라 멈춤의 원인일 뿐이다.
 */
export function stdinForArgvPrompt(c: Ctx = {}): StdinMode {
  const { env, isTTY } = ctx(c);
  if (isUnattended(env)) return "ignore";
  return isTTY ? "inherit" : "ignore";
}

/**
 * stdin으로 **코퍼스를 받는다고 문서화한** CLI(gemini)의 stdin.
 *
 * 사람이 돌리는 동안에는 파이프를 그대로 넘긴다 — 비-TTY라는 이유로 끊으면
 * `cat corpus | invoke-gemini "질문"`이 조용히 빈 입력으로 돈다.
 * 무인 실행에서만 끊는다.
 */
export function stdinForPipedCorpus(c: Ctx = {}): StdinMode {
  return isUnattended(ctx(c).env) ? "ignore" : "inherit";
}
