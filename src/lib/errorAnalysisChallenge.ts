import { GAGNE_NINE_EVENTS, type GagneEventId } from './pedagogyEngine';

export type MisconceptionCategory =
  | 'carry_omission'
  | 'place_value_misalignment'
  | 'clock_hand_confusion'
  | 'hangul_liaison_error'
  | 'fraction_denominator_addition'
  | 'decimal_point_misalignment'
  | 'ten_complement_confusion';

export interface ErrorSolutionStep {
  stepNumber: number;
  expression: string;
  description: string;
  isFlawed: boolean;
}

export interface CorrectionOption {
  id: string;
  text: string;
  isCorrectReason: boolean;
  feedback: string;
}

export interface ErrorAnalysisItem {
  id: string;
  grade: number;
  domain: 'math' | 'clock' | 'hangul';
  misconceptionType: MisconceptionCategory;
  misconceptionTitleKo: string;
  characterName: string;
  characterAvatar: string;
  questionPrompt: string;
  characterWrongAnswer: string;
  correctAnswer: string;
  flawedStepNumber: number;
  steps: ErrorSolutionStep[];
  reasonOptions: CorrectionOption[];
  visualHintSvgDesc: string;
  gagneEventId: GagneEventId;
}

export interface ErrorAnalysisSubmission {
  selectedStepNumber: number;
  selectedReasonId: string;
  correctedAnswer: string | number;
}

export interface MasteryBadgeRecord {
  id: string;
  title: string;
  icon: string;
  misconceptionFixed: MisconceptionCategory;
  earnedAt: string;
}

export interface ErrorAnalysisEvaluationResult {
  passed: boolean;
  stepMatched: boolean;
  reasonMatched: boolean;
  answerMatched: boolean;
  masteryBadge: MasteryBadgeRecord | null;
  transferBonusPoints: number;
  gagneCompletedEvents: GagneEventId[];
  feedbackMessage: string;
}

export const ERROR_ANALYSIS_BANK: readonly ErrorAnalysisItem[] = [
  {
    id: 'ea-g1-ten-complement',
    grade: 1,
    domain: 'math',
    misconceptionType: 'ten_complement_confusion',
    misconceptionTitleKo: '10 가르기·모으기 보수 착오',
    characterName: '다람이',
    characterAvatar: '🐿️',
    questionPrompt: '8 + 5를 10을 만들어 계산해 보세요.',
    characterWrongAnswer: '12',
    correctAnswer: '13',
    flawedStepNumber: 2,
    steps: [
      {
        stepNumber: 1,
        expression: '8에 2를 더하면 10이 됩니다.',
        description: '8이 10이 되기 위해 필요한 수(2)를 찾았습니다.',
        isFlawed: false,
      },
      {
        stepNumber: 2,
        expression: '5를 2와 2로 가릅니다.',
        description: '5에서 2를 빌려주고 남은 수를 2라고 적었습니다.',
        isFlawed: true,
      },
      {
        stepNumber: 3,
        expression: '10 + 2 = 12',
        description: '만든 10과 남은 수를 더했습니다.',
        isFlawed: false,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '5를 2와 3으로 갈라야 하는데 2와 2로 잘못 갈랐어요.',
        isCorrectReason: true,
        feedback: '맞아요! 5 = 2 + 3이므로 10에 3을 더해 13이 되어야 합니다.',
      },
      {
        id: 'r2',
        text: '8에 3을 더해야 10이 되는데 2를 더했어요.',
        isCorrectReason: false,
        feedback: '8 + 2 = 10이므로 1단계는 바르게 풀었어요.',
      },
      {
        id: 'r3',
        text: '덧셈 대신 뺄셈을 해야 하는 문제예요.',
        isCorrectReason: false,
        feedback: '두 수를 합하는 덧셈 문제가 맞아요.',
      },
    ],
    visualHintSvgDesc: '10칸 상자에 파란 구슬 8개와 노란 구슬 2개를 채워 10을 만들고, 밖에 노란 구슬 3개가 남은 모형',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g1-hangul-liaison',
    grade: 1,
    domain: 'hangul',
    misconceptionType: 'hangul_liaison_error',
    misconceptionTitleKo: '받침 연음과 글자 표기 혼동',
    characterName: '별이',
    characterAvatar: '⭐',
    questionPrompt: '소리는 [구름이]라고 나지만 알맞은 낱말 표기는 무엇일까요? (구름 + 이)',
    characterWrongAnswer: '구르미',
    correctAnswer: '구름이',
    flawedStepNumber: 2,
    steps: [
      {
        stepNumber: 1,
        expression: '낱말 "구름" 뒤에 조사 "이"가 붙어요.',
        description: '원래 낱말의 모양인 "구름"을 확인했습니다.',
        isFlawed: false,
      },
      {
        stepNumber: 2,
        expression: '소리 나는 대로 받침 ㅁ을 옆으로 옮겨 "구르미"라고 써요.',
        description: '연음 발음 [구르미]를 그대로 글자 표기로 적었습니다.',
        isFlawed: true,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '읽을 때는 [구르미]로 소리 나도, 쓸 때는 원래 낱말 모양을 밝혀 "구름이"로 써야 해요.',
        isCorrectReason: true,
        feedback: '정확해요! 받침이 뒷글자 첫소리로 이어져 소리 나더라도 표기는 어형을 밝혀 적습니다.',
      },
      {
        id: 'r2',
        text: '받침 ㅁ 대신 ㄴ을 써서 "구른이"라고 써야 해요.',
        isCorrectReason: false,
        feedback: '원래 낱말은 "구름"이므로 ㅁ 받침을 유지해야 합니다.',
      },
      {
        id: 'r3',
        text: '조사를 빼고 무조건 "구름"만 써야 해요.',
        isCorrectReason: false,
        feedback: '문장 속에서 "구름이"처럼 조사를 붙여 쓸 수 있어요.',
      },
    ],
    visualHintSvgDesc: '음절 블록 [구][름] + [이]에서 받침 ㅁ이 소리만 옆으로 넘어가는 점선 화살표 모형',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g2-carry-omission',
    grade: 2,
    domain: 'math',
    misconceptionType: 'carry_omission',
    misconceptionTitleKo: '받아올림 누락 오류',
    characterName: '철수',
    characterAvatar: '👦',
    questionPrompt: '38 + 25를 계산해 보세요.',
    characterWrongAnswer: '53',
    correctAnswer: '63',
    flawedStepNumber: 2,
    steps: [
      {
        stepNumber: 1,
        expression: '일의 자리: 8 + 5 = 13 (십 모형 1개, 일 모형 3개)',
        description: '일의 자리 수끼리 더해 13을 구했습니다.',
        isFlawed: false,
      },
      {
        stepNumber: 2,
        expression: '십의 자리: 30 + 20 = 50',
        description: '일의 자리에서 받아올림한 10을 더하지 않고 30과 20만 더했습니다.',
        isFlawed: true,
      },
      {
        stepNumber: 3,
        expression: '합계: 50 + 3 = 53',
        description: '십의 자리와 일의 자리를 합쳤습니다.',
        isFlawed: false,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '일의 자리 8 + 5 = 13에서 받아올림한 십 모형 1개(10)를 십의 자리에 더하지 않았어요.',
        isCorrectReason: true,
        feedback: '빙고! 받아올림한 10을 더해 30 + 20 + 10 = 60, 따라서 63이 됩니다.',
      },
      {
        id: 'r2',
        text: '8 + 5는 13이 아니라 12이기 때문이에요.',
        isCorrectReason: false,
        feedback: '8 + 5 = 13이 맞아요. 1단계 계산은 정확했습니다.',
      },
      {
        id: 'r3',
        text: '십의 자리 숫자를 서로 빼야 해요.',
        isCorrectReason: false,
        feedback: '덧셈식이므로 십의 자리도 모두 더해야 합니다.',
      },
    ],
    visualHintSvgDesc: '낱개 8개와 5개가 모여 십 모형 1개로 묶여 십의 자리 칸으로 올라가는 수모형 다이어그램',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g2-clock-hands',
    grade: 2,
    domain: 'clock',
    misconceptionType: 'clock_hand_confusion',
    misconceptionTitleKo: '시계 긴바늘·짧은바늘 혼동',
    characterName: '영희',
    characterAvatar: '👧',
    questionPrompt: '짧은바늘이 4와 5 사이에 있고, 긴바늘이 숫자 6을 가리키는 시계의 시각은 몇 시 몇 분일까요? (숫자만 예: 4:30)',
    characterWrongAnswer: '6:20',
    correctAnswer: '4:30',
    flawedStepNumber: 1,
    steps: [
      {
        stepNumber: 1,
        expression: '긴바늘이 6을 가리키니까 6시예요.',
        description: '긴바늘(분침)을 시침으로 착각하여 6시라고 읽었습니다.',
        isFlawed: true,
      },
      {
        stepNumber: 2,
        expression: '짧은바늘이 4 근처에 있으니까 20분이에요.',
        description: '짧은바늘(시침)에 5를 곱해 분으로 읽었습니다.',
        isFlawed: false,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '짧은바늘이 시(4시), 긴바늘이 분(6 × 5 = 30분)을 나타내는데 두 바늘의 역할을 거꾸로 읽었어요.',
        isCorrectReason: true,
        feedback: '정확해요! 짧은바늘은 4시, 긴바늘 숫자 6은 30분을 나타내므로 4:30입니다.',
      },
      {
        id: 'r2',
        text: '긴바늘이 6을 가리키면 무조건 정각(00분)이에요.',
        isCorrectReason: false,
        feedback: '긴바늘이 12를 가리킬 때 정각이고, 6을 가리키면 30분이에요.',
      },
      {
        id: 'r3',
        text: '시계 숫자는 10씩 건너뛰어 읽어야 해요.',
        isCorrectReason: false,
        feedback: '긴바늘(분침)은 큰 눈금 하나가 5분씩 늘어납니다.',
      },
    ],
    visualHintSvgDesc: '짧은바늘(빨강, 시침)과 긴바늘(파랑, 5분 단위 바깥 눈금 표시)이 구분된 시계 모형',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g3-place-value',
    grade: 3,
    domain: 'math',
    misconceptionType: 'place_value_misalignment',
    misconceptionTitleKo: '자릿값 정렬 오류',
    characterName: '민수',
    characterAvatar: '🧒',
    questionPrompt: '24 × 13을 세로셈으로 계산해 보세요.',
    characterWrongAnswer: '96',
    correctAnswer: '312',
    flawedStepNumber: 2,
    steps: [
      {
        stepNumber: 1,
        expression: '24 × 3 = 72',
        description: '24에 일의 자리 수 3을 곱해 72를 구했습니다.',
        isFlawed: false,
      },
      {
        stepNumber: 2,
        expression: '24 × 1 = 24 (일의 자리에 맞추어 72 아래에 24를 씀)',
        description: '십의 자리 1(실제 값 10)을 곱한 값을 240이 아닌 24로 자릿값을 잘못 맞추어 적었습니다.',
        isFlawed: true,
      },
      {
        stepNumber: 3,
        expression: '72 + 24 = 96',
        description: '두 부분곱을 더했습니다.',
        isFlawed: false,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '13의 1은 십의 자리(10)이므로 24 × 10 = 240이 되도록 한 자리 왼쪽(십의 자리)에 맞추어 써야 해요.',
        isCorrectReason: true,
        feedback: '완벽해요! 72 + 240 = 312가 올바른 답입니다.',
      },
      {
        id: 'r2',
        text: '24 × 3이 72가 아니라 62예요.',
        isCorrectReason: false,
        feedback: '24 × 3 = 72가 맞습니다.',
      },
      {
        id: 'r3',
        text: '두 부분곱을 더하지 않고 빼야 해요.',
        isCorrectReason: false,
        feedback: '부분곱은 서로 더하는 것이 맞아요.',
      },
    ],
    visualHintSvgDesc: '24 × 3 = 72 영역과 24 × 10 = 240 영역으로 나뉜 직사각형 넓이 모델',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g4-fraction-add',
    grade: 4,
    domain: 'math',
    misconceptionType: 'fraction_denominator_addition',
    misconceptionTitleKo: '분모끼리 더하는 분수 오개념',
    characterName: '소라',
    characterAvatar: '🦊',
    questionPrompt: '분모가 같은 분수 2/7 + 3/7을 계산해 보세요. (기약분수 형태 a/b로 입력)',
    characterWrongAnswer: '5/14',
    correctAnswer: '5/7',
    flawedStepNumber: 2,
    steps: [
      {
        stepNumber: 1,
        expression: '분자끼리 더하기: 2 + 3 = 5',
        description: '색칠한 조각의 개수를 더했습니다.',
        isFlawed: false,
      },
      {
        stepNumber: 2,
        expression: '분모끼리 더하기: 7 + 7 = 14 → 5/14',
        description: '전체를 나눈 기준 크기인 분모까지 서로 더했습니다.',
        isFlawed: true,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '분모(7)는 전체를 똑같이 나눈 한 조각의 크기이므로 그대로 두고, 분자끼리만 더해야 해요.',
        isCorrectReason: true,
        feedback: '맞아요! 1/7이 2개와 3개 모이면 1/7이 5개이므로 5/7입니다.',
      },
      {
        id: 'r2',
        text: '분모와 분자를 서로 곱해야 해요.',
        isCorrectReason: false,
        feedback: '분수의 덧셈에서는 단위분수의 개수를 더합니다.',
      },
      {
        id: 'r3',
        text: '분자는 그대로 두고 분모만 더해야 해요.',
        isCorrectReason: false,
        feedback: '전체를 나눈 칸수(분모)는 변하지 않아요.',
      },
    ],
    visualHintSvgDesc: '7등분한 분수 막대에서 2칸과 3칸을 합쳐 전체 7칸 중 5칸이 색칠된 시각 모델',
    gagneEventId: 'enhance_retention',
  },
  {
    id: 'ea-g6-decimal-align',
    grade: 6,
    domain: 'math',
    misconceptionType: 'decimal_point_misalignment',
    misconceptionTitleKo: '소수점 자릿값 정렬 오류',
    characterName: '준호',
    characterAvatar: '🐻',
    questionPrompt: '2.4 + 0.35를 계산해 보세요.',
    characterWrongAnswer: '0.59',
    correctAnswer: '2.75',
    flawedStepNumber: 1,
    steps: [
      {
        stepNumber: 1,
        expression: '오른쪽 끝 숫자를 맞추어 2.4를 0.24처럼 0.35와 줄 맞춤',
        description: '소수점 위치를 맞추지 않고 오른쪽 끝 숫자를 기준으로 세로줄을 맞추었습니다.',
        isFlawed: true,
      },
      {
        stepNumber: 2,
        expression: '0.24 + 0.35 = 0.59',
        description: '잘못 맞춘 자릿값대로 더했습니다.',
        isFlawed: false,
      },
    ],
    reasonOptions: [
      {
        id: 'r1',
        text: '소수의 덧셈은 소수점 위치를 기준으로 자릿값을 맞추고(2.40 + 0.35) 계산해야 해요.',
        isCorrectReason: true,
        feedback: '정확합니다! 2.4를 2.40으로 생각하면 2.40 + 0.35 = 2.75가 됩니다.',
      },
      {
        id: 'r2',
        text: '소수점을 모두 없애고 24 + 35 = 59로 적어야 해요.',
        isCorrectReason: false,
        feedback: '소수점의 자릿값을 유지해야 정확한 크기가 됩니다.',
      },
      {
        id: 'r3',
        text: '소수 첫째 자리와 소수 둘째 자리를 서로 곱해야 해요.',
        isCorrectReason: false,
        feedback: '같은 자릿값끼리 더해야 합니다.',
      },
    ],
    visualHintSvgDesc: '일의 자리(2), 소수 첫째 자리(4와 3), 소수 둘째 자리(0과 5)가 소수점 기준선으로 정렬된 수모형 표',
    gagneEventId: 'enhance_retention',
  },
] as const;

export function getErrorAnalysisChallenges(filter?: {
  grade?: number;
  domain?: 'math' | 'clock' | 'hangul';
  misconceptionType?: MisconceptionCategory;
}): ErrorAnalysisItem[] {
  if (!filter) return [...ERROR_ANALYSIS_BANK];

  const exact = ERROR_ANALYSIS_BANK.filter((item) => {
    if (filter.grade !== undefined && item.grade !== filter.grade) return false;
    if (filter.domain && item.domain !== filter.domain) return false;
    if (filter.misconceptionType && item.misconceptionType !== filter.misconceptionType) {
      return false;
    }
    return true;
  });

  if (exact.length > 0) return exact;

  // 해당 학년에 정확히 일치하는 항목이 없으면 가장 가까운 학년 항목 반환
  if (filter.grade !== undefined) {
    const targetGrade = filter.grade;
    const sorted = [...ERROR_ANALYSIS_BANK].sort(
      (a, b) => Math.abs(a.grade - targetGrade) - Math.abs(b.grade - targetGrade)
    );
    return [sorted[0]];
  }

  return [...ERROR_ANALYSIS_BANK];
}

export function generateErrorAnalysisChallenge(
  grade: number = 2,
  domain?: 'math' | 'clock' | 'hangul'
): ErrorAnalysisItem {
  const candidates = getErrorAnalysisChallenges({ grade, domain });
  return candidates[0] || ERROR_ANALYSIS_BANK[0];
}

function normalizeAnswer(val: string | number): string {
  return String(val).trim().replace(/\s+/g, '');
}

export function evaluateErrorAnalysisSubmission(
  item: ErrorAnalysisItem,
  submission: ErrorAnalysisSubmission
): ErrorAnalysisEvaluationResult {
  const stepMatched = Number(submission.selectedStepNumber) === item.flawedStepNumber;
  const chosenOption = item.reasonOptions.find((o) => o.id === submission.selectedReasonId);
  const reasonMatched = Boolean(chosenOption?.isCorrectReason);
  const answerMatched =
    normalizeAnswer(submission.correctedAnswer) === normalizeAnswer(item.correctAnswer);

  const passed = stepMatched && reasonMatched && answerMatched;

  const badgeTitles: Record<MisconceptionCategory, { title: string; icon: string }> = {
    ten_complement_confusion: { title: '10 만들기 메타인지 탐정', icon: '🔟' },
    hangul_liaison_error: { title: '바른 글자 연음 박사', icon: '📖' },
    carry_omission: { title: '받아올림 수호자 배지', icon: '🏅' },
    clock_hand_confusion: { title: '시계 바늘 명탐정 배지', icon: '⏰' },
    place_value_misalignment: { title: '자릿값 정렬 마스터', icon: '📐' },
    fraction_denominator_addition: { title: '분수 단위 조각 마스터', icon: '🍕' },
    decimal_point_misalignment: { title: '소수점 정밀 탐색가', icon: '🔬' },
  };

  const badgeMeta = badgeTitles[item.misconceptionType];
  const masteryBadge: MasteryBadgeRecord | null = passed
    ? {
        id: `badge-${item.id}`,
        title: badgeMeta.title,
        icon: badgeMeta.icon,
        misconceptionFixed: item.misconceptionType,
        earnedAt: new Date().toISOString(),
      }
    : null;

  const transferBonusPoints = passed ? 150 : (stepMatched ? 30 : 0) + (reasonMatched ? 40 : 0);

  const gagneCompletedEvents: GagneEventId[] = passed
    ? GAGNE_NINE_EVENTS.map((e) => e.id)
    : ['present_stimulus', 'provide_guidance', 'provide_feedback'];

  let feedbackMessage = '';
  if (passed) {
    feedbackMessage = `${item.characterName}의 ${item.flawedStepNumber}단계 오류(${item.misconceptionTitleKo})를 정확히 찾아 고쳤어요! 메타인지 마스터리 배지와 전이 보너스 +${transferBonusPoints}점을 획득했습니다.`;
  } else if (!stepMatched) {
    feedbackMessage = `${item.characterName}의 풀이를 위에서부터 차근차근 다시 살펴보세요. ${item.flawedStepNumber}단계 식에서 처음 규칙이 어긋났어요.`;
  } else if (!reasonMatched) {
    feedbackMessage =
      chosenOption?.feedback ||
      '틀린 단계는 잘 찾았어요! 왜 그 단계가 틀렸는지 원인을 다시 골라 보세요.';
  } else {
    feedbackMessage = `오류 원인을 정확히 찾았어요! 이제 마지막으로 바르게 계산한 정답(${item.correctAnswer})을 입력해 보세요.`;
  }

  return {
    passed,
    stepMatched,
    reasonMatched,
    answerMatched,
    masteryBadge,
    transferBonusPoints,
    gagneCompletedEvents,
    feedbackMessage,
  };
}

export class MetacognitionTracker {
  private badges: MasteryBadgeRecord[] = [];
  private totalTransferBonus = 0;

  public submit(
    item: ErrorAnalysisItem,
    submission: ErrorAnalysisSubmission
  ): ErrorAnalysisEvaluationResult {
    const result = evaluateErrorAnalysisSubmission(item, submission);
    this.totalTransferBonus += result.transferBonusPoints;
    if (
      result.masteryBadge &&
      !this.badges.some((b) => b.id === result.masteryBadge?.id)
    ) {
      this.badges.push(result.masteryBadge);
    }
    return result;
  }

  public getSummary(): {
    badges: MasteryBadgeRecord[];
    totalTransferBonus: number;
    masteredCount: number;
  } {
    return {
      badges: [...this.badges],
      totalTransferBonus: this.totalTransferBonus,
      masteredCount: this.badges.length,
    };
  }
}
