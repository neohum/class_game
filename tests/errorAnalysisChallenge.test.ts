import { describe, expect, it } from 'vitest';
import {
  ERROR_ANALYSIS_BANK,
  getErrorAnalysisChallenges,
  generateErrorAnalysisChallenge,
  evaluateErrorAnalysisSubmission,
  MetacognitionTracker,
} from '../src/lib/errorAnalysisChallenge';

describe('Step 2: ErrorAnalysisChallenge (가네 9수업사태 및 메타인지 오류 찾기 모듈)', () => {
  it('AC-1: 학년별 주요 오개념(받아올림 누락, 자릿값 정렬 오류, 시계 긴바늘·짧은바늘 혼동, 받침 연음 오류 등) 문제 뱅크에서 캐릭터 오류 풀이 단계와 교정 선택지를 생성한다', () => {
    expect(ERROR_ANALYSIS_BANK.length).toBeGreaterThanOrEqual(6);

    const misconceptionTypes = new Set(ERROR_ANALYSIS_BANK.map((i) => i.misconceptionType));
    expect(misconceptionTypes.has('carry_omission')).toBe(true);
    expect(misconceptionTypes.has('place_value_misalignment')).toBe(true);
    expect(misconceptionTypes.has('clock_hand_confusion')).toBe(true);
    expect(misconceptionTypes.has('hangul_liaison_error')).toBe(true);

    for (const item of ERROR_ANALYSIS_BANK) {
      expect(item.steps.length).toBeGreaterThanOrEqual(2);
      const flawedSteps = item.steps.filter((s) => s.isFlawed);
      expect(flawedSteps).toHaveLength(1);
      expect(flawedSteps[0].stepNumber).toBe(item.flawedStepNumber);

      const correctReasons = item.reasonOptions.filter((r) => r.isCorrectReason);
      expect(correctReasons).toHaveLength(1);
      expect(item.reasonOptions.length).toBeGreaterThanOrEqual(3);
    }

    const grade2Clock = generateErrorAnalysisChallenge(2, 'clock');
    expect(grade2Clock.misconceptionType).toBe('clock_hand_confusion');
  });

  it('AC-2: 학생이 오류 원인을 정확히 지목하고 바른 답을 입력하면 메타인지 마스터리 배지와 전이 보너스가 기록된다', () => {
    const tracker = new MetacognitionTracker();
    const carryItem = getErrorAnalysisChallenges({
      misconceptionType: 'carry_omission',
    })[0];

    const correctReason = carryItem.reasonOptions.find((r) => r.isCorrectReason)!;

    // 1) 오답 제출 시 배지 미지급 및 부분 피드백 반환
    const wrongResult = tracker.submit(carryItem, {
      selectedStepNumber: 1,
      selectedReasonId: correctReason.id,
      correctedAnswer: carryItem.correctAnswer,
    });
    expect(wrongResult.passed).toBe(false);
    expect(wrongResult.masteryBadge).toBeNull();

    // 2) 정확한 오류 단계 + 원인 선택 + 바른 답 입력 시 마스터리 배지 및 전이 보너스 기록
    const successResult = tracker.submit(carryItem, {
      selectedStepNumber: carryItem.flawedStepNumber,
      selectedReasonId: correctReason.id,
      correctedAnswer: carryItem.correctAnswer,
    });

    expect(successResult.passed).toBe(true);
    expect(successResult.stepMatched).toBe(true);
    expect(successResult.reasonMatched).toBe(true);
    expect(successResult.answerMatched).toBe(true);
    expect(successResult.masteryBadge).not.toBeNull();
    expect(successResult.masteryBadge?.misconceptionFixed).toBe('carry_omission');
    expect(successResult.transferBonusPoints).toBe(150);
    expect(successResult.gagneCompletedEvents).toHaveLength(9);

    const summary = tracker.getSummary();
    expect(summary.masteredCount).toBe(1);
    expect(summary.totalTransferBonus).toBeGreaterThanOrEqual(150);

    // 직접 함수 호출 검증
    const directEval = evaluateErrorAnalysisSubmission(carryItem, {
      selectedStepNumber: carryItem.flawedStepNumber,
      selectedReasonId: correctReason.id,
      correctedAnswer: ' 63 ',
    });
    expect(directEval.passed).toBe(true);
  });
});
