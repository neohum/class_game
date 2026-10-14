/**
 * 브루너(Bruner) EIS 표상 이론, 인지 부하 이론 기반 동적 비계(Dynamic Scaffolding),
 * 가네(Gagné) 9가지 수업 사태(Nine Events of Instruction) 루프를 통합 관리하는 교수설계 엔진.
 */

export type EISStage = 'enactive' | 'iconic' | 'symbolic';

export type ScaffoldLevel = 0 | 1 | 2 | 3;

export type HintType =
  | 'none'
  | 'number_bond'
  | 'number_line'
  | 'carry_borrow'
  | 'place_value'
  | 'fraction_part'
  | 'factor_multiple'
  | 'clock_hands'
  | 'phoneme_rule'
  | 'conceptual_nudge';

export type VisualAidType =
  | 'none'
  | 'ten-frame'
  | 'number-line'
  | 'base-ten-blocks'
  | 'fraction-bar'
  | 'clock-hands'
  | 'syllable-blocks';

export type GagneEventId =
  | 'gain_attention'
  | 'inform_objectives'
  | 'stimulate_recall'
  | 'present_stimulus'
  | 'provide_guidance'
  | 'elicit_performance'
  | 'provide_feedback'
  | 'assess_performance'
  | 'enhance_retention';

export interface GagneEventDescriptor {
  order: number;
  id: GagneEventId;
  titleKo: string;
  descriptionKo: string;
}

export const GAGNE_NINE_EVENTS: readonly GagneEventDescriptor[] = [
  {
    order: 1,
    id: 'gain_attention',
    titleKo: '주의 집중',
    descriptionKo: '시각·청각 훅과 호기심 질문으로 학습자의 주의를 집중시킵니다.',
  },
  {
    order: 2,
    id: 'inform_objectives',
    titleKo: '목표 제시',
    descriptionKo: '이번 스테이지에서 달성할 핵심 성취기준과 목표를 안내합니다.',
  },
  {
    order: 3,
    id: 'stimulate_recall',
    titleKo: '선수학습 회상',
    descriptionKo: '이전 학년·단원에서 배운 기초 개념과 감각을 환기합니다.',
  },
  {
    order: 4,
    id: 'present_stimulus',
    titleKo: '자극 제시',
    descriptionKo: '브루너 EIS 표상 단계(구체물·영상·기호)에 맞춰 문제를 제시합니다.',
  },
  {
    order: 5,
    id: 'provide_guidance',
    titleKo: '학습 안내',
    descriptionKo: '학생의 비계 레벨에 따라 수모형·수직선 등 시각 보조선을 제공합니다.',
  },
  {
    order: 6,
    id: 'elicit_performance',
    titleKo: '수행 유도',
    descriptionKo: '학생이 직접 조작하거나 선택하여 개념 원리를 수행하도록 유도합니다.',
  },
  {
    order: 7,
    id: 'provide_feedback',
    titleKo: '형성적 피드백',
    descriptionKo: '정오답 여부뿐 아니라 오개념 원인을 교정하는 즉각적 시각 피드백을 제공합니다.',
  },
  {
    order: 8,
    id: 'assess_performance',
    titleKo: '수행 평가',
    descriptionKo: '연속 정답 스트림과 응답 정확도를 분석해 개념 숙달 여부를 평가합니다.',
  },
  {
    order: 9,
    id: 'enhance_retention',
    titleKo: '파지 및 전이',
    descriptionKo: '오류 찾기(Error Analysis) 챌린지와 인쇄용 맞춤 학습지로 학습 전이를 강화합니다.',
  },
] as const;

export interface MisconceptionHint {
  hintType: HintType;
  visualGuideOn: boolean;
  visualAidType: VisualAidType;
  message: string;
  scaffoldLevel: ScaffoldLevel;
  eisStage: EISStage;
}

export interface AnswerInput {
  correct: boolean;
  grade?: number;
  domain?: 'math' | 'hangul' | 'clock' | 'logic' | 'general';
  questionTag?: string;
  expectedAnswer?: number | string;
  submittedAnswer?: number | string;
  misconceptionCode?: HintType;
}

export interface PedagogyState {
  grade: number;
  eisStage: EISStage;
  scaffoldLevel: ScaffoldLevel;
  visualGuideOn: boolean;
  visualAidType: VisualAidType;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  totalAttempts: number;
  totalCorrect: number;
  gagneStageIndex: number;
  currentGagneEvent: GagneEventDescriptor;
  completedGagneEvents: GagneEventId[];
  history: boolean[];
}

export interface AnswerTransitionResult {
  state: PedagogyState;
  hint: MisconceptionHint;
  transition: 'promoted_eis' | 'reduced_scaffold' | 'restored_scaffold' | 'steady';
  gagneEvent: GagneEventDescriptor;
}

export interface PedagogyEngineOptions {
  grade?: number;
  initialEisStage?: EISStage;
  initialScaffoldLevel?: ScaffoldLevel;
  initialVisualGuideOn?: boolean;
  domain?: 'math' | 'hangul' | 'clock' | 'logic' | 'general';
}

const EIS_ORDER: readonly EISStage[] = ['enactive', 'iconic', 'symbolic'];

export function clampGrade(grade: number = 1): number {
  if (!Number.isFinite(grade)) return 1;
  return Math.max(1, Math.min(6, Math.round(grade)));
}

/**
 * GAME_PRINCIPLES.md 원칙 4: 학년에 따른 세로 배치 기준 비율 보간
 * 1학년(1.0, 화면 최하단) -> 6학년(0.5, 화면 세로 중앙)
 */
export function calculateVerticalAnchor(grade: number): number {
  const g = clampGrade(grade);
  return Number((1.0 - (g - 1) * 0.1).toFixed(2));
}

/**
 * 학년별 브루너 EIS 권장 비중 반환
 * 초등 저학년(1~2학년)은 E·I 비중 80% 이상 배치, 고학년일수록 S 단계 비중 확대
 */
export function getRecommendedEisRatio(grade: number): {
  enactive: number;
  iconic: number;
  symbolic: number;
  enactiveIconicCombined: number;
} {
  const g = clampGrade(grade);
  if (g <= 2) {
    return { enactive: 0.5, iconic: 0.35, symbolic: 0.15, enactiveIconicCombined: 0.85 };
  }
  if (g <= 4) {
    return { enactive: 0.25, iconic: 0.4, symbolic: 0.35, enactiveIconicCombined: 0.65 };
  }
  return { enactive: 0.15, iconic: 0.3, symbolic: 0.55, enactiveIconicCombined: 0.45 };
}

function getDefaultEisForGrade(grade: number): EISStage {
  const g = clampGrade(grade);
  if (g <= 2) return 'enactive';
  if (g <= 4) return 'iconic';
  return 'symbolic';
}

function getDefaultScaffoldForStage(stage: EISStage): ScaffoldLevel {
  if (stage === 'enactive') return 3;
  if (stage === 'iconic') return 2;
  return 0;
}

function resolveVisualAidType(
  grade: number,
  stage: EISStage,
  visualGuideOn: boolean,
  domain: string = 'math',
  hintType: HintType = 'none'
): VisualAidType {
  if (!visualGuideOn && stage === 'symbolic') {
    return 'none';
  }
  if (domain === 'clock' || hintType === 'clock_hands') return 'clock-hands';
  if (domain === 'hangul' || hintType === 'phoneme_rule') return 'syllable-blocks';
  if (hintType === 'fraction_part') return 'fraction-bar';
  if (grade <= 1 || stage === 'enactive' || hintType === 'number_bond') {
    return 'ten-frame';
  }
  if (grade === 2 || hintType === 'carry_borrow' || hintType === 'place_value') {
    return 'base-ten-blocks';
  }
  return 'number-line';
}

function inferMisconceptionHint(
  input: AnswerInput,
  state: PedagogyState
): MisconceptionHint {
  if (input.correct) {
    return {
      hintType: 'none',
      visualGuideOn: state.visualGuideOn,
      visualAidType: state.visualAidType,
      message:
        state.consecutiveCorrect >= 3
          ? '3회 연속 정답! 시각 보조선을 줄이고 기호·수식 단계로 한 걸음 나아갑니다.'
          : '정확해요! 개념 원리를 잘 이해하고 있어요.',
      scaffoldLevel: state.scaffoldLevel,
      eisStage: state.eisStage,
    };
  }

  let hintType: HintType = input.misconceptionCode || 'conceptual_nudge';
  const tag = (input.questionTag || '').toLowerCase();

  if (!input.misconceptionCode) {
    if (input.domain === 'clock' || tag.includes('시계') || tag.includes('시각')) {
      hintType = 'clock_hands';
    } else if (input.domain === 'hangul' || tag.includes('받침') || tag.includes('글자')) {
      hintType = 'phoneme_rule';
    } else if (tag.includes('분수') || tag.includes('소수')) {
      hintType = 'fraction_part';
    } else if (tag.includes('약수') || tag.includes('배수') || tag.includes('공약수') || tag.includes('공배수')) {
      hintType = 'factor_multiple';
    } else if (
      typeof input.expectedAnswer === 'number' &&
      typeof input.submittedAnswer === 'number'
    ) {
      const diff = Math.abs(input.expectedAnswer - input.submittedAnswer);
      if (diff === 10 || diff === 100) {
        hintType = 'carry_borrow';
      } else if (state.grade === 1 || input.expectedAnswer <= 20) {
        hintType = 'number_bond';
      } else if (diff <= 3) {
        hintType = 'number_line';
      } else {
        hintType = 'place_value';
      }
    } else if (state.grade <= 1) {
      hintType = 'number_bond';
    } else if (state.grade === 2) {
      hintType = 'carry_borrow';
    } else {
      hintType = 'number_line';
    }
  }

  const messages: Record<HintType, string> = {
    none: '',
    number_bond:
      '10칸 상자(수모형)에 구슬을 먼저 채워 10을 만든 뒤 남은 수를 세어 보세요.',
    number_line:
      '수직선에서 시작 숫자를 찾고 화살표만큼 한 칸씩 이동해 위치를 확인해 보세요.',
    carry_borrow:
      '일의 자리 합이 10이 넘거나 뺄 수 없을 때 십 모형 1개와 낱개 10개를 받아올림·받아내림하여 바꾸었는지 확인해 보세요.',
    place_value:
      '백 모형, 십 모형, 일 모형의 자릿값을 나란히 맞추어 계산했는지 다시 살펴보세요.',
    fraction_part:
      '전체를 똑같이 나눈 조각 수(분모)와 색칠한 조각 수(분자)를 분수 막대로 비교해 보세요.',
    factor_multiple:
      '수를 같은 크기의 묶음으로 나누어떨어지게 묶을 수 있는지 배열 모형으로 확인해 보세요.',
    clock_hands:
      '짧은바늘(시침)은 숫자를 읽고, 긴바늘(분침)은 작은 눈금(5분 단위)으로 읽어야 해요.',
    phoneme_rule:
      '첫소리(초성)·가운뎃소리(중성)·끝소리(종성) 블록을 천천히 소리 내어 이어 읽어 보세요.',
    conceptual_nudge:
      '조급해하지 말고 아래 시각 보조선과 그림 모형을 보며 차근차근 다시 풀어 보세요.',
  };

  const visualAidType = resolveVisualAidType(
    state.grade,
    state.eisStage,
    state.visualGuideOn,
    input.domain || 'math',
    hintType
  );

  return {
    hintType,
    visualGuideOn: state.visualGuideOn,
    visualAidType,
    message: messages[hintType] || messages.conceptual_nudge,
    scaffoldLevel: state.scaffoldLevel,
    eisStage: state.eisStage,
  };
}

export class PedagogyEngine {
  private state: PedagogyState;
  private domain: 'math' | 'hangul' | 'clock' | 'logic' | 'general';

  constructor(options: PedagogyEngineOptions = {}) {
    const grade = clampGrade(options.grade ?? 1);
    const eisStage = options.initialEisStage ?? getDefaultEisForGrade(grade);
    const scaffoldLevel =
      options.initialScaffoldLevel ?? getDefaultScaffoldForStage(eisStage);
    const visualGuideOn =
      options.initialVisualGuideOn ?? (eisStage !== 'symbolic' || scaffoldLevel > 0);
    this.domain = options.domain ?? 'math';

    this.state = {
      grade,
      eisStage,
      scaffoldLevel,
      visualGuideOn,
      visualAidType: resolveVisualAidType(grade, eisStage, visualGuideOn, this.domain),
      consecutiveCorrect: 0,
      consecutiveWrong: 0,
      totalAttempts: 0,
      totalCorrect: 0,
      gagneStageIndex: 0,
      currentGagneEvent: GAGNE_NINE_EVENTS[0],
      completedGagneEvents: ['gain_attention'],
      history: [],
    };
  }

  public getState(): PedagogyState {
    return {
      ...this.state,
      completedGagneEvents: [...this.state.completedGagneEvents],
      history: [...this.state.history],
    };
  }

  public setGrade(grade: number): PedagogyState {
    const clamped = clampGrade(grade);
    const eisStage = getDefaultEisForGrade(clamped);
    const scaffoldLevel = getDefaultScaffoldForStage(eisStage);
    const visualGuideOn = eisStage !== 'symbolic';
    this.state = {
      ...this.state,
      grade: clamped,
      eisStage,
      scaffoldLevel,
      visualGuideOn,
      visualAidType: resolveVisualAidType(clamped, eisStage, visualGuideOn, this.domain),
      consecutiveCorrect: 0,
      consecutiveWrong: 0,
    };
    return this.getState();
  }

  public advanceGagneStage(targetEventId?: GagneEventId): GagneEventDescriptor {
    if (targetEventId) {
      const idx = GAGNE_NINE_EVENTS.findIndex((e) => e.id === targetEventId);
      if (idx >= 0) {
        this.state.gagneStageIndex = idx;
      }
    } else {
      this.state.gagneStageIndex =
        (this.state.gagneStageIndex + 1) % GAGNE_NINE_EVENTS.length;
    }
    const current = GAGNE_NINE_EVENTS[this.state.gagneStageIndex];
    this.state.currentGagneEvent = current;
    if (!this.state.completedGagneEvents.includes(current.id)) {
      this.state.completedGagneEvents.push(current.id);
    }
    return current;
  }

  public recordAnswer(input: AnswerInput): AnswerTransitionResult {
    if (input.grade !== undefined) {
      this.state.grade = clampGrade(input.grade);
    }
    if (input.domain) {
      this.domain = input.domain;
    }

    this.state.totalAttempts += 1;
    this.state.history.push(input.correct);
    if (this.state.history.length > 20) {
      this.state.history.shift();
    }

    let transition: AnswerTransitionResult['transition'] = 'steady';

    if (input.correct) {
      this.state.totalCorrect += 1;
      this.state.consecutiveCorrect += 1;
      this.state.consecutiveWrong = 0;

      // 3회 연속 정답 시 비계 레벨 완화 및 EIS 단계(enactive -> iconic -> symbolic) 승격
      if (this.state.consecutiveCorrect > 0 && this.state.consecutiveCorrect % 3 === 0) {
        const currentIdx = EIS_ORDER.indexOf(this.state.eisStage);
        if (this.state.scaffoldLevel > 0) {
          this.state.scaffoldLevel = Math.max(0, this.state.scaffoldLevel - 1) as ScaffoldLevel;
          transition = 'reduced_scaffold';
        }
        if (currentIdx < EIS_ORDER.length - 1) {
          this.state.eisStage = EIS_ORDER[currentIdx + 1];
          transition = 'promoted_eis';
        }
        this.state.visualGuideOn = false;
        this.advanceGagneStage('assess_performance');
      } else {
        this.advanceGagneStage('elicit_performance');
      }
    } else {
      this.state.consecutiveWrong += 1;
      this.state.consecutiveCorrect = 0;

      // 2회 연속 오답 시 구체물/시각 보조선 자동 복구 및 EIS 단계 하향 지원
      if (this.state.consecutiveWrong >= 2) {
        this.state.visualGuideOn = true;
        this.state.scaffoldLevel = Math.min(3, Math.max(2, this.state.scaffoldLevel + 1)) as ScaffoldLevel;
        const currentIdx = EIS_ORDER.indexOf(this.state.eisStage);
        if (currentIdx > 0) {
          this.state.eisStage = EIS_ORDER[currentIdx - 1];
        }
        transition = 'restored_scaffold';
        this.advanceGagneStage('provide_guidance');
      } else {
        this.advanceGagneStage('provide_feedback');
      }
    }

    this.state.visualAidType = resolveVisualAidType(
      this.state.grade,
      this.state.eisStage,
      this.state.visualGuideOn,
      this.domain,
      input.misconceptionCode
    );

    const hint = inferMisconceptionHint(input, this.state);
    this.state.visualAidType = hint.visualAidType;

    return {
      state: this.getState(),
      hint,
      transition,
      gagneEvent: this.state.currentGagneEvent,
    };
  }

  public reset(options: PedagogyEngineOptions = {}): PedagogyState {
    const fresh = new PedagogyEngine({
      grade: options.grade ?? this.state.grade,
      initialEisStage: options.initialEisStage,
      initialScaffoldLevel: options.initialScaffoldLevel,
      initialVisualGuideOn: options.initialVisualGuideOn,
      domain: options.domain ?? this.domain,
    });
    this.state = fresh.getState();
    return this.getState();
  }
}
