/**
 * 브라우저 미니게임(`public/games/*`) 및 테스트 공용 교수설계(EIS·동적 비계·가네 9수업사태) 엔진
 * - 브루너 EIS: enactive(구체물) -> iconic(시각 모형) -> symbolic(기호/수식)
 * - 동적 비계: 3회 연속 정답 시 비계 완화 및 보조선 해제, 2회 연속 오답 시 구체물/시각 보조선 자동 복구
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ClassGamePedagogy = factory();
    root.PedagogyEngine = root.ClassGamePedagogy.PedagogyEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var EIS_ORDER = ['enactive', 'iconic', 'symbolic'];

  var GAGNE_NINE_EVENTS = [
    { order: 1, id: 'gain_attention', titleKo: '주의 집중' },
    { order: 2, id: 'inform_objectives', titleKo: '목표 제시' },
    { order: 3, id: 'stimulate_recall', titleKo: '선수학습 회상' },
    { order: 4, id: 'present_stimulus', titleKo: '자극 제시' },
    { order: 5, id: 'provide_guidance', titleKo: '학습 안내' },
    { order: 6, id: 'elicit_performance', titleKo: '수행 유도' },
    { order: 7, id: 'provide_feedback', titleKo: '형성적 피드백' },
    { order: 8, id: 'assess_performance', titleKo: '수행 평가' },
    { order: 9, id: 'enhance_retention', titleKo: '파지 및 전이' },
  ];

  function clampGrade(grade) {
    var n = Number(grade);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(6, Math.round(n)));
  }

  function calculateVerticalAnchor(grade) {
    var g = clampGrade(grade);
    return Number((1.0 - (g - 1) * 0.1).toFixed(2));
  }

  function getDefaultEisForGrade(grade) {
    var g = clampGrade(grade);
    if (g <= 2) return 'enactive';
    if (g <= 4) return 'iconic';
    return 'symbolic';
  }

  function getDefaultScaffoldForStage(stage) {
    if (stage === 'enactive') return 3;
    if (stage === 'iconic') return 2;
    return 0;
  }

  function resolveVisualAidType(grade, stage, visualGuideOn, hintType) {
    if (!visualGuideOn && stage === 'symbolic') return 'none';
    if (hintType === 'fraction_part') return 'fraction-bar';
    if (grade <= 1 || stage === 'enactive' || hintType === 'number_bond') return 'ten-frame';
    if (grade === 2 || hintType === 'carry_borrow' || hintType === 'place_value') {
      return 'base-ten-blocks';
    }
    return 'number-line';
  }

  function inferMisconceptionHint(input, state) {
    if (input.correct) {
      return {
        hintType: 'none',
        visualGuideOn: state.visualGuideOn,
        visualAidType: state.visualAidType,
        message:
          state.consecutiveCorrect >= 3
            ? '3회 연속 정답! 기호 암산 모드로 전환합니다.'
            : '정답입니다! 원리를 정확히 파악했어요.',
        scaffoldLevel: state.scaffoldLevel,
        eisStage: state.eisStage,
      };
    }

    var hintType = input.misconceptionCode || 'conceptual_nudge';
    var tag = String(input.questionTag || '');
    if (!input.misconceptionCode) {
      if (tag.indexOf('분수') !== -1 || tag.indexOf('소수') !== -1) {
        hintType = 'fraction_part';
      } else if (tag.indexOf('약수') !== -1 || tag.indexOf('배수') !== -1) {
        hintType = 'factor_multiple';
      } else if (state.grade <= 1) {
        hintType = 'number_bond';
      } else if (state.grade === 2) {
        hintType = 'carry_borrow';
      } else {
        hintType = 'number_line';
      }
    }

    var messages = {
      none: '',
      number_bond: '10칸 모형에서 10을 먼저 채우고 남은 구슬 수를 세어 보세요.',
      number_line: '수직선 위에서 시작 수를 찾고 화살표 칸수만큼 이동해 보세요.',
      carry_borrow: '십 모형 1개(10)와 낱개 모형을 받아올림·받아내림했는지 확인해 보세요.',
      place_value: '자릿값(백·십·일)을 맞추어 계산했는지 수모형으로 점검해 보세요.',
      fraction_part: '전체를 똑같이 나눈 칸수(분모)와 색칠한 칸수(분자)를 비교해 보세요.',
      factor_multiple: '수를 같은 묶음으로 나누어떨어지게 묶을 수 있는지 확인해 보세요.',
      conceptual_nudge: '아래 시각 보조선을 보며 차근차근 다시 계산해 보세요.',
    };

    var aidType = resolveVisualAidType(state.grade, state.eisStage, state.visualGuideOn, hintType);

    return {
      hintType: hintType,
      visualGuideOn: state.visualGuideOn,
      visualAidType: aidType,
      message: messages[hintType] || messages.conceptual_nudge,
      scaffoldLevel: state.scaffoldLevel,
      eisStage: state.eisStage,
    };
  }

  function PedagogyEngine(options) {
    options = options || {};
    var grade = clampGrade(options.grade || 1);
    var eisStage = options.initialEisStage || getDefaultEisForGrade(grade);
    var scaffoldLevel =
      typeof options.initialScaffoldLevel === 'number'
        ? options.initialScaffoldLevel
        : getDefaultScaffoldForStage(eisStage);
    var visualGuideOn =
      typeof options.initialVisualGuideOn === 'boolean'
        ? options.initialVisualGuideOn
        : eisStage !== 'symbolic' || scaffoldLevel > 0;

    this.state = {
      grade: grade,
      eisStage: eisStage,
      scaffoldLevel: scaffoldLevel,
      visualGuideOn: visualGuideOn,
      visualAidType: resolveVisualAidType(grade, eisStage, visualGuideOn, 'none'),
      consecutiveCorrect: 0,
      consecutiveWrong: 0,
      totalAttempts: 0,
      totalCorrect: 0,
      gagneStageIndex: 0,
      currentGagneEvent: GAGNE_NINE_EVENTS[0],
    };
  }

  PedagogyEngine.prototype.getState = function () {
    return Object.assign({}, this.state);
  };

  PedagogyEngine.prototype.setGrade = function (grade) {
    var g = clampGrade(grade);
    var eisStage = getDefaultEisForGrade(g);
    var scaffoldLevel = getDefaultScaffoldForStage(eisStage);
    var visualGuideOn = eisStage !== 'symbolic';
    this.state.grade = g;
    this.state.eisStage = eisStage;
    this.state.scaffoldLevel = scaffoldLevel;
    this.state.visualGuideOn = visualGuideOn;
    this.state.visualAidType = resolveVisualAidType(g, eisStage, visualGuideOn, 'none');
    this.state.consecutiveCorrect = 0;
    this.state.consecutiveWrong = 0;
    return this.getState();
  };

  PedagogyEngine.prototype.recordAnswer = function (input) {
    input = input || { correct: false };
    this.state.totalAttempts += 1;
    var transition = 'steady';

    if (input.correct) {
      this.state.totalCorrect += 1;
      this.state.consecutiveCorrect += 1;
      this.state.consecutiveWrong = 0;

      if (this.state.consecutiveCorrect > 0 && this.state.consecutiveCorrect % 3 === 0) {
        var idx = EIS_ORDER.indexOf(this.state.eisStage);
        if (this.state.scaffoldLevel > 0) {
          this.state.scaffoldLevel = Math.max(0, this.state.scaffoldLevel - 1);
          transition = 'reduced_scaffold';
        }
        if (idx < EIS_ORDER.length - 1) {
          this.state.eisStage = EIS_ORDER[idx + 1];
          transition = 'promoted_eis';
        }
        this.state.visualGuideOn = false;
        this.state.gagneStageIndex = 7;
      } else {
        this.state.gagneStageIndex = 5;
      }
    } else {
      this.state.consecutiveWrong += 1;
      this.state.consecutiveCorrect = 0;

      if (this.state.consecutiveWrong >= 2) {
        this.state.visualGuideOn = true;
        this.state.scaffoldLevel = Math.min(3, Math.max(2, this.state.scaffoldLevel + 1));
        var cIdx = EIS_ORDER.indexOf(this.state.eisStage);
        if (cIdx > 0) {
          this.state.eisStage = EIS_ORDER[cIdx - 1];
        }
        transition = 'restored_scaffold';
        this.state.gagneStageIndex = 4;
      } else {
        this.state.gagneStageIndex = 6;
      }
    }

    this.state.currentGagneEvent = GAGNE_NINE_EVENTS[this.state.gagneStageIndex];
    var hint = inferMisconceptionHint(input, this.state);
    this.state.visualAidType = hint.visualAidType;

    return {
      state: this.getState(),
      hint: hint,
      transition: transition,
      gagneEvent: this.state.currentGagneEvent,
    };
  };

  return {
    PedagogyEngine: PedagogyEngine,
    GAGNE_NINE_EVENTS: GAGNE_NINE_EVENTS,
    clampGrade: clampGrade,
    calculateVerticalAnchor: calculateVerticalAnchor,
  };
});
