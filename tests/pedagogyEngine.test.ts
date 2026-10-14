import { describe, expect, it } from 'vitest';
import {
  PedagogyEngine,
  GAGNE_NINE_EVENTS,
  calculateVerticalAnchor,
  getRecommendedEisRatio,
} from '../src/lib/pedagogyEngine';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharedPedagogy = require('../public/games/shared/pedagogy-engine.js');

describe('Step 1: PedagogyEngine (EIS 표상 전이 및 동적 비계 엔진)', () => {
  it('AC-1: 연속 정답 3회 시 scaffoldLevel을 1단계 낮추고 EIS 표상 단계를 enactive -> iconic -> symbolic으로 승격시킨다', () => {
    const engine = new PedagogyEngine({
      grade: 1,
      initialEisStage: 'enactive',
      initialScaffoldLevel: 3,
    });

    expect(engine.getState().eisStage).toBe('enactive');
    expect(engine.getState().scaffoldLevel).toBe(3);
    expect(engine.getState().visualGuideOn).toBe(true);

    engine.recordAnswer({ correct: true });
    engine.recordAnswer({ correct: true });
    const third = engine.recordAnswer({ correct: true });

    expect(third.state.consecutiveCorrect).toBe(3);
    expect(third.state.scaffoldLevel).toBe(2);
    expect(third.state.eisStage).toBe('iconic');
    expect(third.state.visualGuideOn).toBe(false);
    expect(third.transition).toBe('promoted_eis');

    // 추가 3회 연속 정답 시 iconic -> symbolic 승격
    engine.recordAnswer({ correct: true });
    engine.recordAnswer({ correct: true });
    const sixth = engine.recordAnswer({ correct: true });

    expect(sixth.state.consecutiveCorrect).toBe(6);
    expect(sixth.state.scaffoldLevel).toBe(1);
    expect(sixth.state.eisStage).toBe('symbolic');
    expect(sixth.state.visualGuideOn).toBe(false);
  });

  it('AC-1: 연속 오답 2회 시 즉시 시각 보조 가이드(visualGuideOn)와 비계 레벨을 복구한다', () => {
    const engine = new PedagogyEngine({
      grade: 5,
      initialEisStage: 'symbolic',
      initialScaffoldLevel: 0,
      initialVisualGuideOn: false,
    });

    expect(engine.getState().visualGuideOn).toBe(false);

    const firstMiss = engine.recordAnswer({
      correct: false,
      expectedAnswer: 42,
      submittedAnswer: 32,
    });
    expect(firstMiss.state.consecutiveWrong).toBe(1);

    const secondMiss = engine.recordAnswer({
      correct: false,
      expectedAnswer: 42,
      submittedAnswer: 32,
    });
    expect(secondMiss.state.consecutiveWrong).toBe(2);
    expect(secondMiss.state.visualGuideOn).toBe(true);
    expect(secondMiss.state.scaffoldLevel).toBeGreaterThanOrEqual(2);
    expect(secondMiss.state.eisStage).toBe('iconic');
    expect(secondMiss.transition).toBe('restored_scaffold');
    expect(secondMiss.hint.visualGuideOn).toBe(true);
  });

  it('AC-2: 오답 발생 시 단순 감점 대신 오개념 교정 힌트 객체(hintType, visualGuideOn, message)를 반환한다', () => {
    const engine = new PedagogyEngine({ grade: 2 });

    const carryMiss = engine.recordAnswer({
      correct: false,
      expectedAnswer: 53,
      submittedAnswer: 43,
      questionTag: '두 자리 덧셈',
    });

    expect(carryMiss.hint).toBeDefined();
    expect(carryMiss.hint.hintType).toBe('carry_borrow');
    expect(typeof carryMiss.hint.visualGuideOn).toBe('boolean');
    expect(carryMiss.hint.message.length).toBeGreaterThan(10);
    expect(carryMiss.hint.message).toContain('받아올림');

    const clockMiss = engine.recordAnswer({
      correct: false,
      domain: 'clock',
      questionTag: '시계 읽기',
    });
    expect(clockMiss.hint.hintType).toBe('clock_hands');
    expect(clockMiss.hint.message).toContain('짧은바늘');
  });

  it('가네 9수업사태 루프와 학년별 EIS 권장 비중 및 세로 배치 앵커(원칙 4)를 정확히 계산한다', () => {
    expect(GAGNE_NINE_EVENTS).toHaveLength(9);
    expect(calculateVerticalAnchor(1)).toBe(1.0);
    expect(calculateVerticalAnchor(6)).toBe(0.5);

    const lowGradeRatio = getRecommendedEisRatio(1);
    expect(lowGradeRatio.enactiveIconicCombined).toBeGreaterThanOrEqual(0.8);

    // 브라우저 공용 스크립트(public/games/shared/pedagogy-engine.js) 동작 일관성 검증
    const browserEngine = new sharedPedagogy.PedagogyEngine({ grade: 1 });
    browserEngine.recordAnswer({ correct: true });
    browserEngine.recordAnswer({ correct: true });
    const promoted = browserEngine.recordAnswer({ correct: true });
    expect(promoted.state.eisStage).toBe('iconic');
    expect(promoted.state.visualGuideOn).toBe(false);

    browserEngine.recordAnswer({ correct: false });
    const restored = browserEngine.recordAnswer({ correct: false });
    expect(restored.state.visualGuideOn).toBe(true);
    expect(restored.hint.hintType).toBe('number_bond');
  });
});
