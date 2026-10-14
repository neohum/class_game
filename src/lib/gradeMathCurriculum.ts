import { calculateVerticalAnchor, clampGrade, type VisualAidType } from './pedagogyEngine';

export type GradeNumber = 1 | 2 | 3 | 4 | 5 | 6;

export type MathOperator =
  | '+'
  | '-'
  | '×'
  | '÷'
  | 'compare'
  | 'make10'
  | 'skip_count'
  | 'fraction'
  | 'factor_multiple'
  | 'decimal';

export interface GradeCurriculumPreset {
  grade: GradeNumber;
  titleKo: string;
  curriculumStandardKo: string;
  minNumber: number;
  maxNumber: number;
  allowedOperators: MathOperator[];
  baseSpeedMultiplier: number;
  verticalAnchor: number;
  defaultVisualAid: VisualAidType;
}

export interface MathQuestionItem {
  grade: GradeNumber;
  operator: MathOperator;
  tag: string;
  text: string;
  answer: number | string;
  choices: Array<number | string>;
  distractorReasons: string[];
  visualGuideSvg: string;
  visualGuideLabel: string;
}

export const GRADE_CURRICULUM_PRESETS: Record<GradeNumber, GradeCurriculumPreset> = {
  1: {
    grade: 1,
    titleKo: '1학년 · 10 만들기와 묶어 세기',
    curriculumStandardKo: '[2수01-03] 10이 되는 더하기와 10에서 빼기, 20 이하의 수 세기와 덧뺄셈',
    minNumber: 0,
    maxNumber: 20,
    allowedOperators: ['make10', 'skip_count', '+', '-', 'compare'],
    baseSpeedMultiplier: 1.0,
    verticalAnchor: calculateVerticalAnchor(1),
    defaultVisualAid: 'ten-frame',
  },
  2: {
    grade: 2,
    titleKo: '2학년 · 두 자리 덧뺄셈과 곱셈구구',
    curriculumStandardKo: '[2수01-06] 받아올림·받아내림이 있는 두 자리 덧뺄셈과 곱셈구구(2~9단)',
    minNumber: 0,
    maxNumber: 100,
    allowedOperators: ['+', '-', '×'],
    baseSpeedMultiplier: 1.12,
    verticalAnchor: calculateVerticalAnchor(2),
    defaultVisualAid: 'base-ten-blocks',
  },
  3: {
    grade: 3,
    titleKo: '3학년 · 세 자리 연산과 나눗셈 기초',
    curriculumStandardKo: '[4수01-01] 세 자리 수의 덧셈·뺄셈 및 곱셈과 나눗셈의 관계 이해',
    minNumber: 1,
    maxNumber: 999,
    allowedOperators: ['+', '-', '×', '÷'],
    baseSpeedMultiplier: 1.2,
    verticalAnchor: calculateVerticalAnchor(3),
    defaultVisualAid: 'number-line',
  },
  4: {
    grade: 4,
    titleKo: '4학년 · 큰 수의 나눗셈과 분수 기초',
    curriculumStandardKo: '[4수01-08] 세 자리 연산·나눗셈과 분모가 같은 분수의 덧뺄셈 기초',
    minNumber: 1,
    maxNumber: 999,
    allowedOperators: ['+', '-', '×', '÷', 'fraction'],
    baseSpeedMultiplier: 1.28,
    verticalAnchor: calculateVerticalAnchor(4),
    defaultVisualAid: 'fraction-bar',
  },
  5: {
    grade: 5,
    titleKo: '5학년 · 약수와 배수 및 분수 연산',
    curriculumStandardKo: '[6수01-02] 약수와 배수, 최대공약수·최소공배수 및 분수의 덧뺄셈·곱셈',
    minNumber: 1,
    maxNumber: 200,
    allowedOperators: ['factor_multiple', 'fraction', '×', '÷'],
    baseSpeedMultiplier: 1.35,
    verticalAnchor: calculateVerticalAnchor(5),
    defaultVisualAid: 'number-line',
  },
  6: {
    grade: 6,
    titleKo: '6학년 · 분수/소수 연산과 약수·배수 응용',
    curriculumStandardKo: '[6수01-09] 분수와 소수의 사칙연산 및 약수·배수 복합 추론',
    minNumber: 0.1,
    maxNumber: 200,
    allowedOperators: ['decimal', 'fraction', 'factor_multiple', '×', '÷'],
    baseSpeedMultiplier: 1.42,
    verticalAnchor: calculateVerticalAnchor(6),
    defaultVisualAid: 'number-line',
  },
};

export function getGradeCurriculumPreset(grade: number): GradeCurriculumPreset {
  const g = clampGrade(grade) as GradeNumber;
  return GRADE_CURRICULUM_PRESETS[g];
}

function buildTenFrameSvg(filledA: number, filledB: number): string {
  const total = Math.min(10, Math.max(0, filledA + filledB));
  const cells: string[] = [];
  for (let i = 0; i < 10; i++) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = 10 + col * 28;
    const y = 8 + row * 24;
    let fill = '#1e293b';
    if (i < filledA) fill = '#38bdf8';
    else if (i < total) fill = '#fbbf24';
    cells.push(
      `<rect x="${x}" y="${y}" width="24" height="20" rx="4" fill="${fill}" stroke="#94a3b8" stroke-width="1.5"/>`
    );
  }
  return `<svg viewBox="0 0 160 60" width="160" height="60" aria-label="10칸 수모형 보조선">${cells.join('')}</svg>`;
}

function buildNumberLineSvg(start: number, target: number, label: string): string {
  const minVal = Math.min(start, target);
  const maxVal = Math.max(start, target);
  return `<svg viewBox="0 0 220 56" width="220" height="56" aria-label="수직선 보조선">
    <line x1="20" y1="36" x2="200" y2="36" stroke="#38bdf8" stroke-width="3"/>
    <circle cx="45" cy="36" r="5" fill="#fbbf24"/>
    <circle cx="175" cy="36" r="5" fill="#34d399"/>
    <path d="M 45 30 Q 110 6 175 30" fill="none" stroke="#f472b6" stroke-width="2" stroke-dasharray="4 2"/>
    <text x="45" y="52" fill="#e2e8f0" font-size="11" text-anchor="middle">${minVal}</text>
    <text x="110" y="18" fill="#fbbf24" font-size="11" text-anchor="middle">${label}</text>
    <text x="175" y="52" fill="#34d399" font-size="11" text-anchor="middle">${maxVal}</text>
  </svg>`;
}

function buildFractionBarSvg(numerator: number, denominator: number): string {
  const safeDenom = Math.max(2, Math.min(10, denominator));
  const safeNum = Math.max(1, Math.min(safeDenom, numerator));
  const segW = Math.floor(180 / safeDenom);
  const rects: string[] = [];
  for (let i = 0; i < safeDenom; i++) {
    const fill = i < safeNum ? '#34d399' : '#1e293b';
    rects.push(
      `<rect x="${15 + i * segW}" y="16" width="${segW - 2}" height="24" rx="3" fill="${fill}" stroke="#94a3b8" stroke-width="1.2"/>`
    );
  }
  return `<svg viewBox="0 0 210 54" width="210" height="54" aria-label="분수 막대 보조선">${rects.join('')}</svg>`;
}

/**
 * 학년·연산자별 오답 매력도가 통제된 오답 2개 생성
 */
export function generateControlledDistractors(
  answer: number | string,
  grade: number,
  operator: MathOperator
): { distractors: Array<number | string>; reasons: string[] } {
  const preset = getGradeCurriculumPreset(grade);

  // 분수 문자열(예: '5/7')인 경우
  if (typeof answer === 'string' && answer.includes('/')) {
    const [numStr, denStr] = answer.split('/');
    const num = Number(numStr) || 1;
    const den = Number(denStr) || 2;
    const d1 = `${num}/${den * 2}`; // 분모끼리 더한 매력적 오답
    const d2 = `${Math.max(1, num + 1)}/${den}`; // 분자 계산 착오 오답
    return {
      distractors: [d1 === answer ? `${num + 2}/${den}` : d1, d2 === answer ? `${num + 3}/${den}` : d2],
      reasons: ['분모끼리 더한 오개념 보기', '분자 단위 조각 개수 +1 착오 보기'],
    };
  }

  const numAns = Number(answer);
  if (operator === 'decimal' || !Number.isInteger(numAns)) {
    const d1 = Number((numAns + 0.1).toFixed(2));
    const d2 = Number(Math.max(0.1, numAns * 0.1).toFixed(2));
    return {
      distractors: [d1 === numAns ? Number((numAns + 0.2).toFixed(2)) : d1, d2 === numAns || d2 === d1 ? Number((numAns + 1).toFixed(2)) : d2],
      reasons: ['소수 첫째 자리 +0.1 계산 착오', '소수점 자릿값 이동 착오'],
    };
  }

  let candidateOffsets: number[] = [];
  let reasons: string[] = [];

  if (grade === 1) {
    candidateOffsets = [-1, 1, -2, 2, -3, 3];
    reasons = ['10의 보수 ±1 세기 착오', '인접 수 뛰어 세기 착오'];
  } else if (grade === 2) {
    if (operator === '+' || operator === '-') {
      candidateOffsets = [-10, 10, -1, 1, -2, 2];
      reasons = ['받아올림·받아내림(±10) 누락 오답', '일의 자리 ±1 계산 오답'];
    } else {
      candidateOffsets = [-3, 3, -4, 4, -2, 2];
      reasons = ['곱셈구구 인접 단 착오', '곱셈구구 덧셈 혼동'];
    }
  } else if (grade === 3 || grade === 4) {
    candidateOffsets = [-10, 10, -100, 100, -2, 2, -5, 5];
    reasons = ['십/백의 자리 받아올림 착오', '나눗셈 몫 자릿값 착오'];
  } else {
    candidateOffsets = [-2, 2, -4, 4, -6, 6, -12, 12];
    reasons = ['약수·배수 배율 착오', '공약수·공배수 인접 배수 혼동'];
  }

  const distractors: number[] = [];
  for (const offset of candidateOffsets) {
    const val = numAns + offset;
    if (
      val !== numAns &&
      val >= preset.minNumber &&
      val <= preset.maxNumber &&
      !distractors.includes(val)
    ) {
      distractors.push(val);
    }
    if (distractors.length === 2) break;
  }

  // 범위 경계로 인해 2개가 안 채워졌을 경우 안전 폴백
  let fallbackStep = 1;
  while (distractors.length < 2) {
    const up = numAns + fallbackStep;
    const down = numAns - fallbackStep;
    if (up <= preset.maxNumber && up !== numAns && !distractors.includes(up)) {
      distractors.push(up);
    } else if (down >= preset.minNumber && down !== numAns && !distractors.includes(down)) {
      distractors.push(down);
    } else {
      distractors.push(numAns + fallbackStep);
    }
    fallbackStep += 1;
  }

  return { distractors: distractors.slice(0, 2), reasons };
}

/**
 * 초등 1~6학년 교육과정 성취기준에 맞춘 수학 문제 생성
 */
export function generateGradeMathQuestion(
  grade: number,
  seedIndex: number = 0
): MathQuestionItem {
  const g = clampGrade(grade) as GradeNumber;
  const idx = Math.abs(Math.round(seedIndex));

  if (g === 1) {
    const bank: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
      {
        grade: 1,
        operator: 'make10',
        tag: '10 만들기',
        text: '7 + □ = 10',
        answer: 3,
        visualGuideSvg: buildTenFrameSvg(7, 3),
        visualGuideLabel: '10칸 상자: 파란 구슬 7개에 노란 구슬 3개를 더하면 10!',
      },
      {
        grade: 1,
        operator: 'make10',
        tag: '10 만들기',
        text: '8 + □ = 10',
        answer: 2,
        visualGuideSvg: buildTenFrameSvg(8, 2),
        visualGuideLabel: '10칸 상자: 빈칸 2개를 채우면 10이 돼요!',
      },
      {
        grade: 1,
        operator: 'skip_count',
        tag: '묶어 세기',
        text: '2, 4, 6, 8 다음 수는?',
        answer: 10,
        visualGuideSvg: buildNumberLineSvg(2, 10, '+2씩 묶어 세기'),
        visualGuideLabel: '수직선 보조선: 2씩 뛰어 세면 8 다음은 10이에요.',
      },
      {
        grade: 1,
        operator: '+',
        tag: '한 자리 덧셈',
        text: '6 + 3 = ?',
        answer: 9,
        visualGuideSvg: buildTenFrameSvg(6, 3),
        visualGuideLabel: '10칸 상자: 6개와 3개를 합하면 9개예요.',
      },
      {
        grade: 1,
        operator: '-',
        tag: '10에서 빼기',
        text: '10 - 4 = ?',
        answer: 6,
        visualGuideSvg: buildTenFrameSvg(6, 0),
        visualGuideLabel: '10칸 상자에서 4개를 덜어내면 6개가 남아요.',
      },
    ];
    const base = bank[idx % bank.length];
    const { distractors, reasons } = generateControlledDistractors(base.answer, 1, base.operator);
    return {
      ...base,
      choices: [base.answer, ...distractors],
      distractorReasons: reasons,
    };
  }

  if (g === 2) {
    const bank: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
      {
        grade: 2,
        operator: '+',
        tag: '두 자리 덧셈',
        text: '38 + 25 = ?',
        answer: 63,
        visualGuideSvg: buildNumberLineSvg(38, 63, '+20 후 +5 (받아올림)'),
        visualGuideLabel: '십 모형 5개에 일의 자리(8+5=13)에서 받아올림한 10을 더해 63!',
      },
      {
        grade: 2,
        operator: '-',
        tag: '두 자리 뺄셈',
        text: '52 - 17 = ?',
        answer: 35,
        visualGuideSvg: buildNumberLineSvg(35, 52, '십 모형 받아내림 -17'),
        visualGuideLabel: '십 모형 1개를 낱개 10개로 받아내려 12 - 7 = 5, 답은 35!',
      },
      {
        grade: 2,
        operator: '×',
        tag: '곱셈구구',
        text: '7 × 8 = ?',
        answer: 56,
        visualGuideSvg: buildNumberLineSvg(0, 56, '7씩 8묶음'),
        visualGuideLabel: '7씩 8번 뛰어 세면 56이에요.',
      },
      {
        grade: 2,
        operator: '×',
        tag: '곱셈구구',
        text: '6 × 9 = ?',
        answer: 54,
        visualGuideSvg: buildNumberLineSvg(0, 54, '6씩 9묶음'),
        visualGuideLabel: '6 × 10 = 60에서 6을 한 번 빼면 54예요.',
      },
    ];
    const base = bank[idx % bank.length];
    const { distractors, reasons } = generateControlledDistractors(base.answer, 2, base.operator);
    return {
      ...base,
      choices: [base.answer, ...distractors],
      distractorReasons: reasons,
    };
  }

  if (g === 3) {
    const bank: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
      {
        grade: 3,
        operator: '+',
        tag: '세 자리 덧셈',
        text: '245 + 138 = ?',
        answer: 383,
        visualGuideSvg: buildNumberLineSvg(245, 383, '+100, +30, +8'),
        visualGuideLabel: '백·십·일 자릿값을 맞추고 일의 자리(5+8=13) 받아올림을 더해요.',
      },
      {
        grade: 3,
        operator: '-',
        tag: '세 자리 뺄셈',
        text: '412 - 150 = ?',
        answer: 262,
        visualGuideSvg: buildNumberLineSvg(262, 412, '-150 이동'),
        visualGuideLabel: '백의 자리에서 받아내려 410 - 150 = 260, 일의 자리 2를 더해 262!',
      },
      {
        grade: 3,
        operator: '÷',
        tag: '나눗셈 기초',
        text: '36 ÷ 4 = ?',
        answer: 9,
        visualGuideSvg: buildNumberLineSvg(0, 36, '4씩 9묶음'),
        visualGuideLabel: '4 × 9 = 36이므로 36을 4씩 나누면 9묶음이에요.',
      },
      {
        grade: 3,
        operator: '×',
        tag: '두 자리 곱셈',
        text: '14 × 3 = ?',
        answer: 42,
        visualGuideSvg: buildNumberLineSvg(0, 42, '10×3=30, 4×3=12'),
        visualGuideLabel: '10 × 3 = 30과 4 × 3 = 12를 더하면 42예요.',
      },
    ];
    const base = bank[idx % bank.length];
    const { distractors, reasons } = generateControlledDistractors(base.answer, 3, base.operator);
    return {
      ...base,
      choices: [base.answer, ...distractors],
      distractorReasons: reasons,
    };
  }

  if (g === 4) {
    const bank: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
      {
        grade: 4,
        operator: 'fraction',
        tag: '분수 기초',
        text: '2/7 + 3/7 = ? (분자만 잡기: □/7)',
        answer: 5,
        visualGuideSvg: buildFractionBarSvg(5, 7),
        visualGuideLabel: '7칸 중 2칸과 3칸을 합치면 5칸(5/7)이에요!',
      },
      {
        grade: 4,
        operator: '÷',
        tag: '세 자리 나눗셈',
        text: '120 ÷ 15 = ?',
        answer: 8,
        visualGuideSvg: buildNumberLineSvg(0, 120, '15씩 8묶음'),
        visualGuideLabel: '15 × 2 = 30이고 30 × 4 = 120이므로 몫은 8이에요.',
      },
      {
        grade: 4,
        operator: '+',
        tag: '세 자리 연산',
        text: '360 + 240 = ?',
        answer: 600,
        visualGuideSvg: buildNumberLineSvg(360, 600, '+240 이동'),
        visualGuideLabel: '60 + 40 = 100이 되어 백의 자리가 600이 됩니다.',
      },
      {
        grade: 4,
        operator: 'fraction',
        tag: '분수 뺄셈',
        text: '7/9 - 2/9 = ? (분자만 잡기: □/9)',
        answer: 5,
        visualGuideSvg: buildFractionBarSvg(5, 9),
        visualGuideLabel: '1/9이 7개에서 2개를 빼면 1/9이 5개(5/9) 남아요.',
      },
    ];
    const base = bank[idx % bank.length];
    const { distractors, reasons } = generateControlledDistractors(base.answer, 4, base.operator);
    return {
      ...base,
      choices: [base.answer, ...distractors],
      distractorReasons: reasons,
    };
  }

  if (g === 5) {
    const bank: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
      {
        grade: 5,
        operator: 'factor_multiple',
        tag: '최대공약수',
        text: '12와 18의 최대공약수는?',
        answer: 6,
        visualGuideSvg: buildNumberLineSvg(0, 18, '6씩 나누어떨어짐'),
        visualGuideLabel: '12 = 6×2, 18 = 6×3이므로 공통인 가장 큰 약수는 6이에요.',
      },
      {
        grade: 5,
        operator: 'factor_multiple',
        tag: '최소공배수',
        text: '4와 6의 최소공배수는?',
        answer: 12,
        visualGuideSvg: buildNumberLineSvg(0, 12, '4의 배수와 6의 배수 공통'),
        visualGuideLabel: '4의 배수(4, 8, 12...)와 6의 배수(6, 12...)가 처음 만나는 수는 12!',
      },
      {
        grade: 5,
        operator: 'fraction',
        tag: '이분모 분수 통분',
        text: '1/2 + 1/4 = □/4 (분자 □는?)',
        answer: 3,
        visualGuideSvg: buildFractionBarSvg(3, 4),
        visualGuideLabel: '1/2은 2/4와 같으므로 2/4 + 1/4 = 3/4이에요.',
      },
      {
        grade: 5,
        operator: 'factor_multiple',
        tag: '약수 찾기',
        text: '15의 약수 중 5보다 큰 수는?',
        answer: 15,
        visualGuideSvg: buildNumberLineSvg(1, 15, '1, 3, 5, 15'),
        visualGuideLabel: '15를 나누어떨어지게 하는 수는 1, 3, 5, 15입니다.',
      },
    ];
    const base = bank[idx % bank.length];
    const { distractors, reasons } = generateControlledDistractors(base.answer, 5, base.operator);
    return {
      ...base,
      choices: [base.answer, ...distractors],
      distractorReasons: reasons,
    };
  }

  // 6학년: 분수/소수 연산 및 약수·배수 응용
  const bank6: Array<Omit<MathQuestionItem, 'choices' | 'distractorReasons'>> = [
    {
      grade: 6,
      operator: 'decimal',
      tag: '소수 덧셈',
      text: '1.4 + 0.8 = ?',
      answer: 2.2,
      visualGuideSvg: buildNumberLineSvg(1.4, 2.2, '+0.8 소수점 정렬'),
      visualGuideLabel: '0.1이 14개와 8개 모이면 22개이므로 소수점을 맞추면 2.2!',
    },
    {
      grade: 6,
      operator: 'decimal',
      tag: '소수 나눗셈',
      text: '3.6 ÷ 0.9 = ?',
      answer: 4,
      visualGuideSvg: buildNumberLineSvg(0, 3.6, '0.9씩 4묶음'),
      visualGuideLabel: '나누는 수와 나누어지는 수에 10을 곱하면 36 ÷ 9 = 4와 같아요.',
    },
    {
      grade: 6,
      operator: 'fraction',
      tag: '분수 나눗셈',
      text: '4/5 ÷ 2/5 = ?',
      answer: 2,
      visualGuideSvg: buildFractionBarSvg(4, 5),
      visualGuideLabel: '분모가 같을 때는 분자끼리 나누어 4 ÷ 2 = 2가 됩니다.',
    },
    {
      grade: 6,
      operator: 'factor_multiple',
      tag: '공배수 응용',
      text: '6과 8의 최소공배수는?',
      answer: 24,
      visualGuideSvg: buildNumberLineSvg(0, 24, '6×4 = 8×3 = 24'),
      visualGuideLabel: '6의 배수와 8의 배수 중 가장 작은 공통 배수는 24입니다.',
    },
  ];
  const base6 = bank6[idx % bank6.length];
  const { distractors, reasons } = generateControlledDistractors(
    base6.answer,
    6,
    base6.operator
  );
  return {
    ...base6,
    choices: [base6.answer, ...distractors],
    distractorReasons: reasons,
  };
}

export function generateGradeQuestionSet(
  grade: number,
  count: number = 5
): MathQuestionItem[] {
  const list: MathQuestionItem[] = [];
  for (let i = 0; i < count; i++) {
    list.push(generateGradeMathQuestion(grade, i));
  }
  return list;
}
