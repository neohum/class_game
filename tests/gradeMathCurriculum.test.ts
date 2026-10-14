import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  GRADE_CURRICULUM_PRESETS,
  getGradeCurriculumPreset,
  generateGradeMathQuestion,
  generateGradeQuestionSet,
  type GradeNumber,
} from '../src/lib/gradeMathCurriculum';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const numberCatchGame = require('../public/games/number-catch-run/game.js');

describe('Step 3: GradeMathCurriculum & number-catch-run 1~6학년 확장', () => {
  it('AC-1: 1~6학년 선택 시 해당 학년 성취기준에 맞는 수 범위와 연산자만 출제되며 오답 매력도가 통제된 보기가 생성된다', () => {
    const grades: GradeNumber[] = [1, 2, 3, 4, 5, 6];

    for (const grade of grades) {
      const preset = getGradeCurriculumPreset(grade);
      expect(preset.grade).toBe(grade);
      expect(preset.verticalAnchor).toBeCloseTo(1.0 - (grade - 1) * 0.1, 2);

      const questions = generateGradeQuestionSet(grade, 6);
      expect(questions).toHaveLength(6);

      for (const q of questions) {
        expect(q.grade).toBe(grade);
        expect(preset.allowedOperators).toContain(q.operator);
        expect(q.choices).toHaveLength(3);
        expect(new Set(q.choices).size).toBe(3);
        expect(q.choices).toContain(q.answer);
        expect(q.distractorReasons.length).toBeGreaterThanOrEqual(2);
        expect(q.visualGuideSvg).toContain('<svg');

        const numAns = Number(q.answer);
        if (!Number.isNaN(numAns)) {
          expect(numAns).toBeGreaterThanOrEqual(preset.minNumber);
          expect(numAns).toBeLessThanOrEqual(preset.maxNumber);
        }
      }

      // number-catch-run/game.js 문제 생성기 교차 검증
      const runtimeQ = numberCatchGame.genQuestionForGrade(grade, 0);
      expect(runtimeQ.grade).toBe(grade);
      expect(runtimeQ.values).toHaveLength(3);
      expect(runtimeQ.values).toContain(runtimeQ.answer);
      expect(runtimeQ.guideSvg).toContain('<svg');
    }

    expect(GRADE_CURRICULUM_PRESETS[1].allowedOperators).toContain('make10');
    expect(GRADE_CURRICULUM_PRESETS[2].allowedOperators).toContain('×');
    expect(GRADE_CURRICULUM_PRESETS[4].allowedOperators).toContain('fraction');
    expect(GRADE_CURRICULUM_PRESETS[5].allowedOperators).toContain('factor_multiple');
    expect(GRADE_CURRICULUM_PRESETS[6].allowedOperators).toContain('decimal');
  });

  it('AC-2: 연속 2회 오답 시 수모형/수직선 시각 보조선이 자동 표시되고 연속 3회 정답 시 기호 암산 모드로 전환된다', () => {
    const controller = numberCatchGame.createColumnController({ grade: 2 });
    const sampleQuestion = numberCatchGame.genQuestionForGrade(2, 0);

    // 초기에는 보조선 비활성
    expect(controller.getState().visualGuideVisible).toBe(false);

    // 연속 2회 오답 -> 수모형/수직선 시각 보조선 자동 표시
    controller.recordAttempt(false, sampleQuestion);
    const afterTwoMisses = controller.recordAttempt(false, sampleQuestion);
    expect(afterTwoMisses.consecutiveWrong).toBe(2);
    expect(afterTwoMisses.visualGuideVisible).toBe(true);
    expect(afterTwoMisses.modeBadge).toContain('보조선 활성');

    // 연속 3회 정답 -> 기호 암산 모드 전환 및 보조선 숨김
    controller.recordAttempt(true, sampleQuestion);
    controller.recordAttempt(true, sampleQuestion);
    const afterThreeCorrect = controller.recordAttempt(true, sampleQuestion);
    expect(afterThreeCorrect.consecutiveCorrect).toBe(3);
    expect(afterThreeCorrect.visualGuideVisible).toBe(false);

    // 한 번 더 3연속 정답으로 symbolic 단계 도달 확인
    controller.recordAttempt(true, sampleQuestion);
    controller.recordAttempt(true, sampleQuestion);
    const symbolicState = controller.recordAttempt(true, sampleQuestion);
    expect(symbolicState.eisStage).toBe('symbolic');
    expect(symbolicState.modeBadge).toBe('기호 암산 (S)');

    // index.html에 학년 선택 UI(.grade-selector)와 동적 비계 보조선(.scaffold-guide)이 포함되어 있는지 검증
    const htmlPath = path.join(
      process.cwd(),
      'public',
      'games',
      'number-catch-run',
      'index.html'
    );
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('grade-selector');
    expect(html).toContain('scaffold-guide');
    expect(html).toContain('../shared/pedagogy-engine.js');
    expect(html).toContain('./game.js');
  });
});
