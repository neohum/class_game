import {
  clampGrade,
  type EISStage,
} from './pedagogyEngine';
import {
  generateErrorAnalysisChallenge,
  type ErrorAnalysisItem,
} from './errorAnalysisChallenge';
import {
  getGradeCurriculumPreset,
  generateGradeMathQuestion,
  type GradeNumber,
} from './gradeMathCurriculum';

export type WorksheetDifficulty = 'basic' | 'standard' | 'challenge';

export interface WorksheetSectionItem {
  id: string;
  eisStage: EISStage;
  stageLabelKo: string;
  prompt: string;
  visualAreaSvg: string;
  scaffoldBlankText: string;
  symbolicEquation: string;
  answer: string;
  explanation: string;
}

export interface TeacherAnswerKeyEntry {
  itemNumber: string;
  stage: string;
  answer: string;
  teachingNote: string;
}

export interface WorksheetDocument {
  id: string;
  gameId: string;
  gameTitle: string;
  grade: GradeNumber;
  difficulty: WorksheetDifficulty;
  focusEisStage: EISStage;
  curriculumStandardKo: string;
  paperFormat: 'A4';
  dimensionsMm: { width: 210; height: 297 };
  eisItems: [WorksheetSectionItem, WorksheetSectionItem, WorksheetSectionItem];
  errorAnalysisQuestion: ErrorAnalysisItem;
  teacherAnswerKey: TeacherAnswerKeyEntry[];
  standaloneA4Svg: string;
  printCss: string;
}

export interface GenerateWorksheetOptions {
  gameId?: string;
  gameTitle?: string;
  grade?: number;
  difficulty?: WorksheetDifficulty;
  focusEisStage?: EISStage;
}

/**
 * 인쇄 미리보기 및 브라우저 인쇄(@media print) 시 네비게이션/버튼 등 불필요한 UI를 숨기고
 * A4 단일 페이지 규격 내에 잘림 없이 배치하는 스타일시트 반환
 */
export function getWorksheetPrintCss(): string {
  return `
@page {
  size: A4 portrait;
  margin: 12mm;
}
@media print {
  body * {
    visibility: hidden;
  }
  .no-print,
  header,
  nav,
  footer,
  .worksheet-modal-controls {
    display: none !important;
  }
  #printable-a4-worksheet,
  #printable-a4-worksheet * {
    visibility: visible;
  }
  #printable-a4-worksheet {
    position: absolute;
    left: 0;
    top: 0;
    width: 186mm !important;
    max-width: 186mm !important;
    min-height: 268mm;
    margin: 0 !important;
    padding: 8mm !important;
    box-shadow: none !important;
    border: 1.5px solid #0f172a !important;
    page-break-inside: avoid;
    break-inside: avoid;
    overflow: hidden !important;
    background: #ffffff !important;
    color: #0f172a !important;
  }
  .worksheet-section-box {
    page-break-inside: avoid;
    break-inside: avoid;
  }
}
`.trim();
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderWorksheetAsSvg(
  doc: Omit<WorksheetDocument, 'standaloneA4Svg'>,
  includeAnswerKey: boolean = true
): string {
  const [enactiveItem, iconicItem, symbolicItem] = doc.eisItems;
  const ea = doc.errorAnalysisQuestion;
  const answerSummary = doc.teacherAnswerKey
    .map((k) => `${k.itemNumber}: ${k.answer}`)
    .join('  |  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="210mm" height="297mm" aria-label="${escapeXml(
    doc.gameTitle
  )} A4 맞춤 학습지">
  <rect x="0" y="0" width="794" height="1123" fill="#ffffff"/>
  <rect x="28" y="28" width="738" height="1067" rx="12" fill="none" stroke="#0f172a" stroke-width="2.5"/>

  <!-- 헤더 -->
  <text x="48" y="68" font-family="Malgun Gothic, sans-serif" font-size="22" font-weight="bold" fill="#0f172a">${escapeXml(
    doc.gameTitle
  )} · ${doc.grade}학년 EIS 맞춤 학습지</text>
  <text x="48" y="92" font-family="Malgun Gothic, sans-serif" font-size="12" fill="#475569">${escapeXml(
    doc.curriculumStandardKo
  )} | 난이도: ${doc.difficulty.toUpperCase()}</text>
  <rect x="540" y="46" width="204" height="44" rx="8" fill="#f8fafc" stroke="#334155" stroke-width="1.5"/>
  <text x="554" y="73" font-family="Malgun Gothic, sans-serif" font-size="13" fill="#0f172a">학년/반:        이름:          </text>

  <!-- 문항 1: Enactive (구체물 그림 영역) -->
  <rect x="44" y="114" width="706" height="200" rx="10" fill="#f8fafc" stroke="#1e293b" stroke-width="1.8"/>
  <text x="60" y="142" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#0369a1">[1단계 · 구체물 조작(Enactive)] ${escapeXml(
    enactiveItem.prompt
  )}</text>
  <text x="60" y="166" font-family="Malgun Gothic, sans-serif" font-size="13" fill="#334155">구체물 그림 영역: 아래 모형을 묶거나 색칠해 보고 빈칸을 채우세요.</text>
  <g transform="translate(60, 178)">${enactiveItem.visualAreaSvg}</g>
  <text x="360" y="215" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#0f172a">보조선 빈칸: ${escapeXml(
    enactiveItem.scaffoldBlankText
  )}</text>
  <text x="360" y="250" font-family="Malgun Gothic, sans-serif" font-size="16" font-weight="bold" fill="#0f172a">식: ${escapeXml(
    enactiveItem.symbolicEquation
  )}</text>

  <!-- 문항 2: Iconic (시각 모형 보조선 빈칸) -->
  <rect x="44" y="330" width="706" height="200" rx="10" fill="#f8fafc" stroke="#1e293b" stroke-width="1.8"/>
  <text x="60" y="358" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#0f766e">[2단계 · 시각 모형(Iconic)] ${escapeXml(
    iconicItem.prompt
  )}</text>
  <text x="60" y="382" font-family="Malgun Gothic, sans-serif" font-size="13" fill="#334155">시각 보조선 영역: 수직선·수모형 화살표를 따라 빈칸을 완성하세요.</text>
  <g transform="translate(60, 394)">${iconicItem.visualAreaSvg}</g>
  <text x="360" y="430" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#0f172a">보조선 빈칸: ${escapeXml(
    iconicItem.scaffoldBlankText
  )}</text>
  <text x="360" y="465" font-family="Malgun Gothic, sans-serif" font-size="16" font-weight="bold" fill="#0f172a">식: ${escapeXml(
    iconicItem.symbolicEquation
  )}</text>

  <!-- 문항 3: Symbolic (기호·수식 추상화) -->
  <rect x="44" y="546" width="706" height="165" rx="10" fill="#f8fafc" stroke="#1e293b" stroke-width="1.8"/>
  <text x="60" y="574" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#6d28d9">[3단계 · 기호 수식(Symbolic)] ${escapeXml(
    symbolicItem.prompt
  )}</text>
  <text x="60" y="604" font-family="Malgun Gothic, sans-serif" font-size="14" fill="#334155">보조선 없이 수식과 기호의 원리만으로 빠르게 해결해 보세요.</text>
  <text x="60" y="642" font-family="Malgun Gothic, sans-serif" font-size="18" font-weight="bold" fill="#0f172a">수식: ${escapeXml(
    symbolicItem.symbolicEquation
  )}     답: (               )</text>
  <text x="60" y="680" font-family="Malgun Gothic, sans-serif" font-size="13" fill="#475569">풀이 생각 적기: ${escapeXml(
    symbolicItem.scaffoldBlankText
  )}</text>

  <!-- 문항 4: 메타인지 오류 찾기 1문항 -->
  <rect x="44" y="727" width="706" height="220" rx="10" fill="#fffbeb" stroke="#b45309" stroke-width="2"/>
  <text x="60" y="756" font-family="Malgun Gothic, sans-serif" font-size="15" font-weight="bold" fill="#92400e">[4단계 · 메타인지 오류 찾기 챌린지] ${escapeXml(
    ea.characterName
  )}의 풀이에서 틀린 곳을 찾아 고쳐 보세요!</text>
  <text x="60" y="782" font-family="Malgun Gothic, sans-serif" font-size="13" font-weight="bold" fill="#0f172a">문제: ${escapeXml(
    ea.questionPrompt
  )} (캐릭터의 오답: ${escapeXml(ea.characterWrongAnswer)})</text>
  ${ea.steps
    .map(
      (st, idx) =>
        `<text x="68" y="${808 + idx * 22}" font-family="Malgun Gothic, sans-serif" font-size="12.5" fill="#1e293b">${st.stepNumber}단계: ${escapeXml(
          st.expression
        )}</text>`
    )
    .join('\n  ')}
  <text x="60" y="896" font-family="Malgun Gothic, sans-serif" font-size="13" font-weight="bold" fill="#0f172a">• 처음 틀린 단계: (      )단계   • 왜 틀렸나요?: ________________________________________</text>
  <text x="60" y="924" font-family="Malgun Gothic, sans-serif" font-size="13" font-weight="bold" fill="#0f172a">• 바르게 고친 정답: (                )</text>
  ${
    includeAnswerKey
      ? `<rect x="44" y="964" width="706" height="112" rx="8" fill="#f1f5f9" stroke="#475569" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="60" y="990" font-family="Malgun Gothic, sans-serif" font-size="13" font-weight="bold" fill="#0f172a">✂️ [교사용 정답지 및 지도 가이드]</text>
  <text x="60" y="1014" font-family="Malgun Gothic, sans-serif" font-size="12" fill="#1e293b">${escapeXml(
    answerSummary
  )}</text>
  <text x="60" y="1038" font-family="Malgun Gothic, sans-serif" font-size="11.5" fill="#334155">• 오류 찾기 해설: ${
    ea.flawedStepNumber
  }단계 오류 (${escapeXml(ea.misconceptionTitleKo)}) → 정답: ${escapeXml(
          ea.correctAnswer
        )}</text>
  <text x="60" y="1060" font-family="Malgun Gothic, sans-serif" font-size="11.5" fill="#475569">• 지도 팁: ${escapeXml(
    ea.visualHintSvgDesc
  )}</text>`
      : ''
  }
</svg>`;
}

export function generatePrintableWorksheet(
  options: GenerateWorksheetOptions = {}
): WorksheetDocument {
  const grade = clampGrade(options.grade ?? 1) as GradeNumber;
  const difficulty: WorksheetDifficulty = options.difficulty ?? 'standard';
  const focusEisStage: EISStage = options.focusEisStage ?? 'enactive';
  const gameId = options.gameId ?? 'number-catch-run';
  const gameTitle = options.gameTitle ?? '달려라 숫자잡기';

  const preset = getGradeCurriculumPreset(grade);
  const offset = difficulty === 'basic' ? 0 : difficulty === 'standard' ? 1 : 2;

  const q1 = generateGradeMathQuestion(grade, offset);
  const q2 = generateGradeMathQuestion(grade, offset + 1);
  const q3 = generateGradeMathQuestion(grade, offset + 2);

  const domain =
    gameId.includes('clock')
      ? 'clock'
      : gameId.includes('hangul') || gameId.includes('word') || gameId.includes('chosung')
      ? 'hangul'
      : 'math';

  const errorAnalysisQuestion = generateErrorAnalysisChallenge(grade, domain);

  const enactiveItem: WorksheetSectionItem = {
    id: `ws-${grade}-enactive`,
    eisStage: 'enactive',
    stageLabelKo: '구체물 조작 (Enactive)',
    prompt: `${q1.tag} 개념을 구체물 그림을 묶어 확인해 보세요.`,
    visualAreaSvg: q1.visualGuideSvg,
    scaffoldBlankText: `${q1.visualGuideLabel} → 빈칸 [   ]`,
    symbolicEquation: `${q1.text.replace('?', '□')}`,
    answer: String(q1.answer),
    explanation: q1.visualGuideLabel,
  };

  const iconicItem: WorksheetSectionItem = {
    id: `ws-${grade}-iconic`,
    eisStage: 'iconic',
    stageLabelKo: '시각 모형 보조선 (Iconic)',
    prompt: `${q2.tag} 문제를 수직선·수모형 보조선 빈칸과 함께 풀어 보세요.`,
    visualAreaSvg: q2.visualGuideSvg,
    scaffoldBlankText: `보조선 단서: ${q2.visualGuideLabel} → 답: [   ]`,
    symbolicEquation: `${q2.text.replace('?', '□')}`,
    answer: String(q2.answer),
    explanation: q2.visualGuideLabel,
  };

  const symbolicItem: WorksheetSectionItem = {
    id: `ws-${grade}-symbolic`,
    eisStage: 'symbolic',
    stageLabelKo: '기호·수식 완성 (Symbolic)',
    prompt: `${q3.tag} 문제를 보조선 없이 기호와 수식으로 해결해 보세요.`,
    visualAreaSvg: q3.visualGuideSvg,
    scaffoldBlankText: `핵심 원리 식 세우기: [           ] = [     ]`,
    symbolicEquation: `${q3.text.replace('?', '□')}`,
    answer: String(q3.answer),
    explanation: q3.visualGuideLabel,
  };

  const correctReason = errorAnalysisQuestion.reasonOptions.find((r) => r.isCorrectReason);

  const teacherAnswerKey: TeacherAnswerKeyEntry[] = [
    {
      itemNumber: '문항 1 (Enactive 구체물)',
      stage: 'enactive',
      answer: enactiveItem.answer,
      teachingNote: enactiveItem.explanation,
    },
    {
      itemNumber: '문항 2 (Iconic 보조선)',
      stage: 'iconic',
      answer: iconicItem.answer,
      teachingNote: iconicItem.explanation,
    },
    {
      itemNumber: '문항 3 (Symbolic 수식)',
      stage: 'symbolic',
      answer: symbolicItem.answer,
      teachingNote: symbolicItem.explanation,
    },
    {
      itemNumber: '문항 4 (오류 찾기)',
      stage: 'enhance_retention',
      answer: `${errorAnalysisQuestion.flawedStepNumber}단계 / 바른 답: ${errorAnalysisQuestion.correctAnswer}`,
      teachingNote:
        correctReason?.text || errorAnalysisQuestion.misconceptionTitleKo,
    },
  ];

  const printCss = getWorksheetPrintCss();

  const partialDoc: Omit<WorksheetDocument, 'standaloneA4Svg'> = {
    id: `worksheet-${gameId}-g${grade}-${difficulty}`,
    gameId,
    gameTitle,
    grade,
    difficulty,
    focusEisStage,
    curriculumStandardKo: preset.curriculumStandardKo,
    paperFormat: 'A4',
    dimensionsMm: { width: 210, height: 297 },
    eisItems: [enactiveItem, iconicItem, symbolicItem],
    errorAnalysisQuestion,
    teacherAnswerKey,
    printCss,
  };

  return {
    ...partialDoc,
    standaloneA4Svg: renderWorksheetAsSvg(partialDoc, true),
  };
}
