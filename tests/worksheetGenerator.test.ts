import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  generatePrintableWorksheet,
  renderWorksheetAsSvg,
  getWorksheetPrintCss,
} from '../src/lib/worksheetGenerator';

describe('Step 4: Printable EIS Worksheet Generator & GameDetail 통합 검증', () => {
  it('AC-1: 선택 학년과 난이도에 맞는 A4 규격 문제지(EIS 3단계 문항 및 오류 찾기 문항 포함)와 교사용 정답지가 생성된다', () => {
    const doc = generatePrintableWorksheet({
      gameId: 'number-catch-run',
      gameTitle: '달려라 숫자잡기',
      grade: 2,
      difficulty: 'standard',
      focusEisStage: 'iconic',
    });

    expect(doc.paperFormat).toBe('A4');
    expect(doc.dimensionsMm).toEqual({ width: 210, height: 297 });
    expect(doc.grade).toBe(2);
    expect(doc.difficulty).toBe('standard');
    expect(doc.focusEisStage).toBe('iconic');

    // EIS 3단계 문항(enactive -> iconic -> symbolic) 검증
    expect(doc.eisItems).toHaveLength(3);
    expect(doc.eisItems[0].eisStage).toBe('enactive');
    expect(doc.eisItems[1].eisStage).toBe('iconic');
    expect(doc.eisItems[2].eisStage).toBe('symbolic');

    for (const item of doc.eisItems) {
      expect(item.visualAreaSvg).toContain('<svg');
      expect(item.scaffoldBlankText.length).toBeGreaterThan(3);
      expect(item.symbolicEquation.length).toBeGreaterThan(2);
      expect(item.answer.length).toBeGreaterThan(0);
    }

    // 오류 찾기 1문항 포함 검증
    expect(doc.errorAnalysisQuestion).toBeDefined();
    expect(doc.errorAnalysisQuestion.grade).toBe(2);
    expect(doc.errorAnalysisQuestion.steps.length).toBeGreaterThanOrEqual(2);

    // 교사용 정답지 포함 검증
    expect(doc.teacherAnswerKey).toHaveLength(4);
    expect(doc.teacherAnswerKey[3].answer).toContain(
      doc.errorAnalysisQuestion.correctAnswer
    );

    // SVG 렌더링 검증 (210mm x 297mm A4 규격)
    expect(doc.standaloneA4Svg).toContain('width="210mm"');
    expect(doc.standaloneA4Svg).toContain('height="297mm"');
    expect(doc.standaloneA4Svg).toContain('교사용 정답지');

    const studentOnlySvg = renderWorksheetAsSvg(doc, false);
    expect(studentOnlySvg).not.toContain('교사용 정답지');
  });

  it('AC-2: 인쇄 미리보기 CSS에서 불필요한 네비게이션 UI가 숨겨지고 A4 한 페이지 내에 잘림 방지 규칙이 적용되며 GameDetail에 액션 버튼이 제공된다', () => {
    const css = getWorksheetPrintCss();
    expect(css).toContain('@page');
    expect(css).toContain('size: A4 portrait');
    expect(css).toContain('@media print');
    expect(css).toContain('.no-print');
    expect(css).toContain('display: none !important');
    expect(css).toContain('page-break-inside: avoid');
    expect(css).toContain('break-inside: avoid');

    const gameDetailPath = path.join(
      process.cwd(),
      'src',
      'pages',
      'GameDetail.tsx'
    );
    const gameDetailSource = fs.readFileSync(gameDetailPath, 'utf8');
    expect(gameDetailSource).toContain('맞춤 학습지 인쇄');
    expect(gameDetailSource).toContain('오류 찾기 챌린지');
    expect(gameDetailSource).toContain('PrintableWorksheetModal');
    expect(gameDetailSource).toContain('ErrorAnalysisModal');
  });
});
