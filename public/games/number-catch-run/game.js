/**
 * 달려라 숫자잡기 (number-catch-run) — 초등 1~6학년 확장 및 EIS 동적 비계 연동 모듈
 * - GAME_PRINCIPLES.md 원칙 1~7 준수 (멀티터치 pointerdown, 1·2·4·6인 독립 인스턴스, 학년별 세로 배치 보간)
 * - 연속 2회 오답 시 수모형/수직선 시각 보조선 하단 자동 표시
 * - 연속 3회 정답 시 기호 암산(symbolic) 모드로 전환 및 보조선 해제
 */
(function (root, factory) {
  var pedagogyMod =
    typeof module === 'object' && module.exports
      ? require('../shared/pedagogy-engine.js')
      : root.ClassGamePedagogy;
  var api = factory(pedagogyMod);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NumberCatchRunGame = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pedagogyMod) {
  var TOTAL = 5;
  var SPEED_UP = 1.25;

  function clampGrade(grade) {
    var n = Number(grade);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(6, Math.round(n)));
  }

  /**
   * GAME_PRINCIPLES.md 원칙 4: 학년(1~6)에 따른 세로 배치 비율 보간
   * grade 1 -> 1.0 (화면 최하단), grade 6 -> 0.5 (세로 중앙)
   */
  function getVerticalAnchor(grade) {
    var g = clampGrade(grade);
    return Number((1.0 - (g - 1) * 0.1).toFixed(2));
  }

  var GRADE_PRESETS = {
    1: {
      grade: 1,
      label: '1학년 (10 만들기·묶어 세기)',
      min: 0,
      max: 20,
      speedScale: 1.0,
      operators: ['make10', 'skip_count', '+', '-', 'compare'],
    },
    2: {
      grade: 2,
      label: '2학년 (두 자리 연산·곱셈구구)',
      min: 0,
      max: 100,
      speedScale: 1.1,
      operators: ['+', '-', '×'],
    },
    3: {
      grade: 3,
      label: '3학년 (세 자리 연산·나눗셈)',
      min: 1,
      max: 999,
      speedScale: 1.18,
      operators: ['+', '-', '×', '÷'],
    },
    4: {
      grade: 4,
      label: '4학년 (큰 수 나눗셈·분수 기초)',
      min: 1,
      max: 999,
      speedScale: 1.25,
      operators: ['+', '-', '×', '÷', 'fraction'],
    },
    5: {
      grade: 5,
      label: '5학년 (약수와 배수·분수 연산)',
      min: 1,
      max: 200,
      speedScale: 1.32,
      operators: ['factor_multiple', 'fraction', '×', '÷'],
    },
    6: {
      grade: 6,
      label: '6학년 (분수/소수 연산·공배수)',
      min: 0.1,
      max: 200,
      speedScale: 1.4,
      operators: ['decimal', 'fraction', 'factor_multiple', '×', '÷'],
    },
  };

  function rnd(n) {
    return Math.floor(Math.random() * n);
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = rnd(i + 1);
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function buildTenFrameSvg(a, b) {
    var total = Math.min(10, Math.max(0, a + b));
    var rects = '';
    for (var i = 0; i < 10; i++) {
      var col = i % 5;
      var row = Math.floor(i / 5);
      var fill = i < a ? '#38bdf8' : i < total ? '#fbbf24' : '#1e293b';
      rects +=
        '<rect x="' +
        (6 + col * 24) +
        '" y="' +
        (4 + row * 18) +
        '" width="20" height="15" rx="3" fill="' +
        fill +
        '" stroke="#94a3b8" stroke-width="1.2"/>';
    }
    return '<svg viewBox="0 0 130 42" width="130" height="42" aria-label="수모형 보조선">' + rects + '</svg>';
  }

  function buildNumberLineSvg(leftLabel, rightLabel, jumpText) {
    return (
      '<svg viewBox="0 0 190 44" width="190" height="44" aria-label="수직선 보조선">' +
      '<line x1="18" y1="28" x2="172" y2="28" stroke="#38bdf8" stroke-width="2.5"/>' +
      '<circle cx="36" cy="28" r="4" fill="#fbbf24"/>' +
      '<circle cx="154" cy="28" r="4" fill="#34d399"/>' +
      '<path d="M 36 24 Q 95 4 154 24" fill="none" stroke="#f472b6" stroke-width="1.8" stroke-dasharray="3 2"/>' +
      '<text x="36" y="41" fill="#e2e8f0" font-size="10" text-anchor="middle">' +
      leftLabel +
      '</text>' +
      '<text x="95" y="13" fill="#fbbf24" font-size="10" text-anchor="middle">' +
      jumpText +
      '</text>' +
      '<text x="154" y="41" fill="#34d399" font-size="10" text-anchor="middle">' +
      rightLabel +
      '</text></svg>'
    );
  }

  function makeDistractors(answer, grade, operator) {
    var preset = GRADE_PRESETS[clampGrade(grade)];
    var num = Number(answer);
    if (operator === 'decimal' || !Number.isInteger(num)) {
      var d1 = Number((num + 0.2).toFixed(1));
      var d2 = Number(Math.max(0.1, num - 0.2).toFixed(1));
      if (d2 === num) d2 = Number((num + 0.5).toFixed(1));
      return [d1, d2];
    }
    var offsets =
      grade === 1
        ? [-2, -1, 1, 2, 3]
        : grade === 2
        ? [-10, 10, -2, 2, -1, 1]
        : grade <= 4
        ? [-10, 10, -2, 2, -5, 5]
        : [-2, 2, -4, 4, -6, 6];
    var pool = [];
    for (var i = 0; i < offsets.length; i++) {
      var v = num + offsets[i];
      if (v >= preset.min && v <= preset.max && v !== num && pool.indexOf(v) === -1) {
        pool.push(v);
      }
      if (pool.length === 2) break;
    }
    var step = 1;
    while (pool.length < 2) {
      var cand = num + step;
      if (cand !== num && pool.indexOf(cand) === -1) pool.push(cand);
      step += 1;
    }
    return pool.slice(0, 2);
  }

  function genQuestionForGrade(grade, stepIdx) {
    var g = clampGrade(grade);
    var idx = typeof stepIdx === 'number' ? stepIdx : rnd(5);
    var q;

    if (g === 1) {
      var types1 = [
        function () {
          var a = 2 + rnd(7);
          var ans = 10 - a;
          return {
            tag: '10 만들기',
            operator: 'make10',
            text: a + ' + □ = 10',
            answer: ans,
            guideSvg: buildTenFrameSvg(a, ans),
            guideText: '10칸 수모형: ' + a + '개에 ' + ans + '개를 더하면 10이에요!',
          };
        },
        function () {
          var n = 2 * (1 + rnd(7));
          return {
            tag: '2씩 묶어 세기',
            operator: 'skip_count',
            text: n + ', ' + (n + 2) + ' 다음 수는?',
            answer: n + 4,
            guideSvg: buildNumberLineSvg(n, n + 4, '+2씩 묶어 세기'),
            guideText: '수직선에서 2칸씩 뛰어 세어 보세요.',
          };
        },
        function () {
          var a = 2 + rnd(7);
          var b = 1 + rnd(10 - a);
          return {
            tag: '덧셈',
            operator: '+',
            text: a + ' + ' + b + ' = ?',
            answer: a + b,
            guideSvg: buildTenFrameSvg(a, b),
            guideText: '수모형 구슬 ' + a + '개와 ' + b + '개를 합쳐 보세요.',
          };
        },
        function () {
          var a = 5 + rnd(6);
          var b = 1 + rnd(a - 1);
          return {
            tag: '뺄셈',
            operator: '-',
            text: a + ' - ' + b + ' = ?',
            answer: a - b,
            guideSvg: buildTenFrameSvg(a - b, 0),
            guideText: a + '개에서 ' + b + '개를 덜어내면 남은 수를 세어요.',
          };
        },
      ];
      q = types1[idx % types1.length]();
    } else if (g === 2) {
      var types2 = [
        function () {
          var a = 15 + rnd(35);
          var b = 14 + rnd(35);
          return {
            tag: '두 자리 덧셈',
            operator: '+',
            text: a + ' + ' + b + ' = ?',
            answer: a + b,
            guideSvg: buildNumberLineSvg(a, a + b, '+' + b + ' 받아올림'),
            guideText: '십의 자리와 일의 자리를 나누어 받아올림을 확인하세요.',
          };
        },
        function () {
          var a = 42 + rnd(45);
          var b = 13 + rnd(25);
          return {
            tag: '두 자리 뺄셈',
            operator: '-',
            text: a + ' - ' + b + ' = ?',
            answer: a - b,
            guideSvg: buildNumberLineSvg(a - b, a, '-' + b + ' 받아내림'),
            guideText: '십 모형 1개를 낱개 10개로 받아내려 계산해 보세요.',
          };
        },
        function () {
          var a = 2 + rnd(8);
          var b = 2 + rnd(8);
          return {
            tag: '곱셈구구',
            operator: '×',
            text: a + ' × ' + b + ' = ?',
            answer: a * b,
            guideSvg: buildNumberLineSvg(0, a * b, a + '씩 ' + b + '묶음'),
            guideText: a + '씩 ' + b + '번 뛰어 세면 얼마일까요?',
          };
        },
      ];
      q = types2[idx % types2.length]();
    } else if (g === 3) {
      var types3 = [
        function () {
          var a = 120 + rnd(300);
          var b = 110 + rnd(250);
          return {
            tag: '세 자리 덧셈',
            operator: '+',
            text: a + ' + ' + b + ' = ?',
            answer: a + b,
            guideSvg: buildNumberLineSvg(a, a + b, '+' + b),
            guideText: '백·십·일 자릿값을 맞추어 차례대로 더해요.',
          };
        },
        function () {
          var divisor = 3 + rnd(7);
          var quotient = 3 + rnd(7);
          var dividend = divisor * quotient;
          return {
            tag: '나눗셈 기초',
            operator: '÷',
            text: dividend + ' ÷ ' + divisor + ' = ?',
            answer: quotient,
            guideSvg: buildNumberLineSvg(0, dividend, divisor + '씩 ' + quotient + '묶음'),
            guideText: divisor + '에 어떤 수를 곱하면 ' + dividend + '가 될까요?',
          };
        },
      ];
      q = types3[idx % types3.length]();
    } else if (g === 4) {
      var types4 = [
        function () {
          var den = 7;
          var n1 = 1 + rnd(3);
          var n2 = 1 + rnd(3);
          return {
            tag: '분수 기초',
            operator: 'fraction',
            text: n1 + '/' + den + ' + ' + n2 + '/' + den + ' = □/' + den,
            answer: n1 + n2,
            guideSvg: buildNumberLineSvg(n1 + '/' + den, (n1 + n2) + '/' + den, '분자끼리 더하기'),
            guideText: '분모(' + den + ')는 그대로 두고 분자 ' + n1 + '과 ' + n2 + '를 더해요.',
          };
        },
        function () {
          var divisor = 12;
          var quotient = 4 + rnd(6);
          return {
            tag: '두 자리 나눗셈',
            operator: '÷',
            text: divisor * quotient + ' ÷ ' + divisor + ' = ?',
            answer: quotient,
            guideSvg: buildNumberLineSvg(0, divisor * quotient, divisor + '씩 나누기'),
            guideText: divisor + '씩 몇 묶음인지 수직선에서 어림해 보세요.',
          };
        },
      ];
      q = types4[idx % types4.length]();
    } else if (g === 5) {
      var pairs5 = [
        { text: '12와 18의 최대공약수는?', ans: 6, tag: '최대공약수', guide: '12와 18을 동시에 나누는 가장 큰 수' },
        { text: '4와 6의 최소공배수는?', ans: 12, tag: '최소공배수', guide: '4의 배수와 6의 배수 중 가장 작은 공통 배수' },
        { text: '1/2 + 1/4 = □/4 (□는?)', ans: 3, tag: '분수 통분', guide: '1/2 = 2/4로 통분한 뒤 분자끼리 더해요' },
      ];
      var p5 = pairs5[idx % pairs5.length];
      q = {
        tag: p5.tag,
        operator: 'factor_multiple',
        text: p5.text,
        answer: p5.ans,
        guideSvg: buildNumberLineSvg(0, p5.ans, p5.tag),
        guideText: p5.guide,
      };
    } else {
      var pairs6 = [
        { text: '1.2 + 0.7 = ?', ans: 1.9, op: 'decimal', tag: '소수 덧셈', guide: '소수점 위치를 맞추어 1.2 + 0.7을 계산해요' },
        { text: '3.6 ÷ 0.9 = ?', ans: 4, op: 'decimal', tag: '소수 나눗셈', guide: '두 수에 10을 곱해 36 ÷ 9로 바꾸어 계산해요' },
        { text: '6과 8의 최소공배수는?', ans: 24, op: 'factor_multiple', tag: '공배수 응용', guide: '6×4 = 24, 8×3 = 24로 공통 배수를 찾아요' },
      ];
      var p6 = pairs6[idx % pairs6.length];
      q = {
        tag: p6.tag,
        operator: p6.op,
        text: p6.text,
        answer: p6.ans,
        guideSvg: buildNumberLineSvg(0, p6.ans, p6.tag),
        guideText: p6.guide,
      };
    }

    var dist = makeDistractors(q.answer, g, q.operator);
    q.grade = g;
    q.values = shuffle([q.answer, dist[0], dist[1]]);
    return q;
  }

  function createColumnController(options) {
    var grade = clampGrade(options && options.grade ? options.grade : 1);
    var EngineCtor = pedagogyMod && pedagogyMod.PedagogyEngine;
    var engine = EngineCtor
      ? new EngineCtor({
          grade: grade,
          initialEisStage: 'iconic',
          initialScaffoldLevel: 2,
          initialVisualGuideOn: false,
        })
      : null;

    var state = {
      grade: grade,
      verticalAnchor: getVerticalAnchor(grade),
      visualGuideVisible: false,
      modeBadge: '시각 모형 (I)',
      lastHintMessage: '',
      consecutiveCorrect: 0,
      consecutiveWrong: 0,
      eisStage: 'iconic',
    };

    function syncFromEngine(res) {
      state.consecutiveCorrect = res.state.consecutiveCorrect;
      state.consecutiveWrong = res.state.consecutiveWrong;
      state.eisStage = res.state.eisStage;
      state.visualGuideVisible = Boolean(res.state.visualGuideOn);
      state.lastHintMessage = res.hint ? res.hint.message : '';
      if (state.eisStage === 'symbolic' && !state.visualGuideVisible) {
        state.modeBadge = '기호 암산 (S)';
      } else if (state.visualGuideVisible) {
        state.modeBadge = '수모형·수직선 보조선 활성 (E·I)';
      } else {
        state.modeBadge = '시각 모형 (I)';
      }
    }

    return {
      getState: function () {
        return Object.assign({}, state);
      },
      setGrade: function (newGrade) {
        grade = clampGrade(newGrade);
        state.grade = grade;
        state.verticalAnchor = getVerticalAnchor(grade);
        if (engine) {
          engine.setGrade(grade);
        }
        state.visualGuideVisible = false;
        state.consecutiveCorrect = 0;
        state.consecutiveWrong = 0;
        return this.getState();
      },
      recordAttempt: function (isCorrect, question) {
        if (engine) {
          var res = engine.recordAnswer({
            correct: Boolean(isCorrect),
            grade: grade,
            questionTag: question && question.tag,
          });
          syncFromEngine(res);
          return this.getState();
        }
        if (isCorrect) {
          state.consecutiveCorrect += 1;
          state.consecutiveWrong = 0;
          if (state.consecutiveCorrect >= 3) {
            state.visualGuideVisible = false;
            state.eisStage = 'symbolic';
            state.modeBadge = '기호 암산 (S)';
          }
        } else {
          state.consecutiveWrong += 1;
          state.consecutiveCorrect = 0;
          if (state.consecutiveWrong >= 2) {
            state.visualGuideVisible = true;
            state.eisStage = 'enactive';
            state.modeBadge = '수모형·수직선 보조선 활성 (E·I)';
          }
        }
        return this.getState();
      },
    };
  }

  return {
    TOTAL: TOTAL,
    SPEED_UP: SPEED_UP,
    GRADE_PRESETS: GRADE_PRESETS,
    clampGrade: clampGrade,
    getVerticalAnchor: getVerticalAnchor,
    genQuestionForGrade: genQuestionForGrade,
    makeDistractors: makeDistractors,
    createColumnController: createColumnController,
  };
});
