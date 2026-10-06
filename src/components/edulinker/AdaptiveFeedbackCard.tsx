import * as React from "react";
import { TactileToolButton } from "./TactileToolButton.js";

export interface AdaptiveFeedbackStep {
  stepNumber: number;
  title: string;
  formula: string;
  isStudentMistake?: boolean;
  mistakeDetail?: string;
  correctExplanation: string;
  tip?: string;
}

export interface AchievementBadge {
  id: string;
  name: string;
  icon: string;
  bgColor: string;
  textColor: string;
  description: string;
  claimed: boolean;
}

export interface AdaptiveFeedbackCardProps {
  studentName?: string;
  questionTitle?: string;
  questionFormula?: string;
  studentAnswer?: string;
  studentMistakeStep?: number;
  steps?: AdaptiveFeedbackStep[];
  earnedBadges?: AchievementBadge[];
  onRetryQuestion?: () => void;
  onClaimBadge?: (badgeId: string) => void;
  className?: string;
}

const DEFAULT_STEPS: AdaptiveFeedbackStep[] = [
  {
    stepNumber: 1,
    title: "1단계: 주어진 식 정리",
    formula: "2x² - 4x - 6 = 0",
    correctExplanation: "이차방정식이 일반형 ax² + bx + c = 0 형태로 올바르게 정리되어 있습니다.",
  },
  {
    stepNumber: 2,
    title: "2단계: 최고차항 계수(2)로 양변 나누기",
    formula: "x² - 2x - 3 = 0",
    isStudentMistake: true,
    mistakeDetail: "학생 필기: x² - 2x + 3 = 0 (상수항 -6의 음의 부호 누락)",
    correctExplanation: "양변을 2로 나눌 때 상수항 (-6) ÷ 2 = -3이 되어야 합니다. 부호 실수를 주의하세요!",
    tip: "부호 실수가 발생하기 쉬운 단계입니다. 음수를 나눌 때 괄호를 쳐서 검산해보세요.",
  },
  {
    stepNumber: 3,
    title: "3단계: 일차식들의 곱으로 인수분해",
    formula: "(x - 3)(x + 1) = 0",
    correctExplanation: "곱해서 -3, 더해서 -2가 되는 두 정수는 -3과 +1입니다.",
  },
  {
    stepNumber: 4,
    title: "4단계: 두 근 구하기",
    formula: "x = 3 또는 x = -1",
    correctExplanation: "x - 3 = 0 또는 x + 1 = 0 이므로 최종 해는 x = 3 또는 x = -1 입니다.",
  },
];

const DEFAULT_BADGES: AchievementBadge[] = [
  {
    id: "stamp-praise",
    name: "참 잘했어요 도장",
    icon: "🌟",
    bgColor: "#fde047", // Vivid Yellow
    textColor: "#09090b",
    description: "오답의 원인을 스스로 찾아내고 재도전했습니다!",
    claimed: true,
  },
  {
    id: "stamp-mastery",
    name: "완벽 오답 정복 스탬프",
    icon: "🎯",
    bgColor: "#86efac", // Neo Emerald
    textColor: "#09090b",
    description: "이차방정식 부호 처리 실수를 완벽하게 보완했습니다.",
    claimed: true,
  },
  {
    id: "stamp-streak",
    name: "3일 연속 출석 도장",
    icon: "🔥",
    bgColor: "#fca5a5", // Vivid Coral
    textColor: "#09090b",
    description: "꾸준한 데일리 형성평가 풀이를 달성했습니다.",
    claimed: false,
  },
];

/**
 * AdaptiveFeedbackCard
 * 
 * Vercel AI SDK Generative UI-based AI formative assessment feedback viewer for edulinker.
 * Combines:
 * 1. AI HTR Handwriting Analysis & Diagnosis
 * 2. Interactive mathematical formula curve visualizer (SVG parabola)
 * 3. Step-by-step solution interactive slider with mistake highlighting
 * 4. Neubrutalism gamification reward stamps (border: 2.5px solid #09090b, box-shadow: 4px 4px 0px #09090b)
 * 
 * Conforms to:
 * - Anti-Cuticle: Symmetric borders throughout
 * - Button & badge centering: inline-flex items-center justify-center leading-none
 * - Theorem 1, 2, 3: Full responsive bounds, flex-wrap on all button rows, min 44px touch targets.
 */
export const AdaptiveFeedbackCard: React.FC<AdaptiveFeedbackCardProps> = ({
  studentName = "최민준",
  questionTitle = "이차방정식의 근 구하기",
  questionFormula = "2x² - 4x - 6 = 0",
  studentAnswer = "x = 2 ± √10",
  studentMistakeStep = 2,
  steps = DEFAULT_STEPS,
  earnedBadges = DEFAULT_BADGES,
  onRetryQuestion,
  onClaimBadge,
  className = "",
}) => {
  const [currentStepIndex, setCurrentStepIndex] = React.useState<number>(studentMistakeStep - 1);
  const [showMistakeCurve, setShowMistakeCurve] = React.useState<boolean>(true);
  const [badges, setBadges] = React.useState<AchievementBadge[]>(earnedBadges);

  const activeStep = steps[currentStepIndex] || steps[0];

  const handleClaim = (id: string) => {
    setBadges((prev) =>
      prev.map((b) => (b.id === id ? { ...b, claimed: true } : b))
    );
    onClaimBadge?.(id);
  };

  return (
    <div
      className={`
        w-full max-w-full
        flex flex-col gap-5 p-4 sm:p-6
        rounded-2xl border border-slate-800 bg-slate-900/95
        text-slate-100 shadow-xl
        ${className}
      `}
    >
      {/* ========================================================================= */}
      {/* 1. Header & AI HTR Recognition Summary                                    */}
      {/* ========================================================================= */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center justify-center leading-none px-2.5 py-1 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
              Vercel AI SDK Generative UI
            </span>
            <span className="inline-flex items-center justify-center leading-none px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
              HTR 필기 인식 완료
            </span>
          </div>
          <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight mt-1">
            {studentName} 학생의 형성평가 AI 피드백
          </h2>
          <p className="text-xs text-slate-400">문항: {questionTitle}</p>
        </div>

        {/* Student Answer Comparison Badge */}
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">문제 식:</span>
            <code className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-xs text-blue-300">
              {questionFormula}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-rose-300 font-medium">제출 답안:</span>
            <code className="px-2 py-0.5 rounded bg-rose-950/40 border border-rose-500/30 font-mono text-xs text-rose-300">
              {studentAnswer} (오답)
            </code>
          </div>
        </div>
      </div>

      {/* AI Diagnosis Notice Banner */}
      <div className="p-3.5 rounded-xl border border-rose-500/30 bg-rose-950/20 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="text-base">💡</span>
          <span className="text-rose-200 leading-relaxed">
            <strong>오답 진단:</strong> {studentMistakeStep}단계에서 양변을 2로 나누는 과정 중 상수항(-6)의 부호 처리 누락이 감지되었습니다.
          </span>
        </div>
        <span className="inline-flex items-center justify-center leading-none px-2 py-1 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 font-bold text-[11px]">
          집중 클리닉 추천
        </span>
      </div>

      {/* ========================================================================= */}
      {/* 2. Interactive Mathematical Formula Graph (SVG Parabola)                 */}
      {/* ========================================================================= */}
      <div className="flex flex-col gap-2 p-4 rounded-xl border border-slate-800 bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
            <span>📈 인터랙티브 수식 그래프 시각화</span>
            <span className="text-[11px] text-slate-400 font-normal">y = 2x² - 4x - 6 (두 근: x = -1, 3)</span>
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowMistakeCurve(!showMistakeCurve)}
              className={`
                min-h-[44px] px-3 rounded-lg border text-xs font-semibold
                inline-flex items-center justify-center leading-none transition-colors
                ${
                  showMistakeCurve
                    ? "bg-rose-500/20 border-rose-500/40 text-rose-300"
                    : "bg-slate-800 border-slate-700 text-slate-400"
                }
              `}
              aria-pressed={showMistakeCurve}
            >
              {showMistakeCurve ? "오답 곡선 숨기기" : "오답 곡선 비교 보기"}
            </button>
          </div>
        </div>

        {/* SVG Curve Canvas */}
        <div className="w-full flex items-center justify-center py-2 overflow-x-auto">
          <svg className="w-full max-w-[420px] h-48 select-none" viewBox="-5 -12 10 16">
            {/* Coordinate Grid & Axes */}
            <line x1="-5" y1="0" x2="5" y2="0" stroke="#334155" strokeWidth="0.15" />
            <line x1="0" y1="-12" x2="0" y2="4" stroke="#334155" strokeWidth="0.15" />

            {/* Axis labels */}
            <text x="4.5" y="-0.3" fill="#64748b" fontSize="0.6" textAnchor="end">x</text>
            <text x="0.3" y="-11" fill="#64748b" fontSize="0.6">y</text>

            {/* Correct Parabola Curve: y = 2x^2 - 4x - 6 */}
            <path
              d="M -3 24 Q 1 -16 5 24"
              stroke="#38bdf8"
              strokeWidth="0.35"
              fill="none"
              strokeLinecap="round"
            />

            {/* Correct Roots Points (x = -1, x = 3) */}
            <circle cx="-1" cy="0" r="0.3" fill="#38bdf8" />
            <text x="-1" y="1" fill="#38bdf8" fontSize="0.55" textAnchor="middle">-1</text>

            <circle cx="3" cy="0" r="0.3" fill="#38bdf8" />
            <text x="3" y="1" fill="#38bdf8" fontSize="0.55" textAnchor="middle">3</text>

            {/* Vertex Point (1, -8) */}
            <circle cx="1" cy="-8" r="0.25" fill="#818cf8" />
            <text x="1" y="-8.5" fill="#818cf8" fontSize="0.5" textAnchor="middle">꼭짓점 (1, -8)</text>

            {/* Student Mistake Curve: y = x^2 - 2x + 3 (D < 0, doesn't touch x-axis) */}
            {showMistakeCurve && (
              <>
                <path
                  d="M -3 18 Q 1 2 5 18"
                  stroke="#f43f5e"
                  strokeWidth="0.3"
                  strokeDasharray="0.4, 0.2"
                  fill="none"
                />
                <circle cx="1" cy="2" r="0.25" fill="#f43f5e" />
                <text x="1.5" y="2.8" fill="#f43f5e" fontSize="0.5">학생 식의 꼭짓점 (실근 없음)</text>
              </>
            )}
          </svg>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-400 border-t border-slate-800/80 pt-2">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-sky-400 inline-block" /> 정답 함수 곡선: y = 2x² - 4x - 6
          </span>
          {showMistakeCurve && (
            <span className="flex items-center gap-1.5 text-rose-400">
              <span className="w-3 h-0.5 bg-rose-500 border-t border-dashed inline-block" /> 학생 오답 함수 곡선: y = x² - 2x + 3
            </span>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. Step-by-Step Solution Slider & Tactical Mistake Highlighting          */}
      {/* ========================================================================= */}
      <div className="flex flex-col gap-3 p-4 rounded-xl border border-slate-800 bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-slate-200">
            단계별 인터랙티브 풀이 슬라이더
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {steps.map((st, idx) => {
              const isSelected = idx === currentStepIndex;
              const isMistake = st.isStudentMistake;
              return (
                <button
                  key={st.stepNumber}
                  type="button"
                  onClick={() => setCurrentStepIndex(idx)}
                  className={`
                    min-h-[44px] min-w-[44px] px-2.5 rounded-lg border text-xs font-bold
                    inline-flex items-center justify-center leading-none transition-all
                    ${
                      isSelected
                        ? isMistake
                          ? "bg-rose-600 text-white border-rose-400 shadow-md"
                          : "bg-blue-600 text-white border-blue-400 shadow-md"
                        : isMistake
                        ? "bg-rose-950/40 text-rose-300 border-rose-500/40 hover:bg-rose-950/70"
                        : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                    }
                  `}
                  aria-label={`${st.stepNumber}단계 보기`}
                >
                  Step {st.stepNumber} {isMistake && "⚠️"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Current Step Content Box */}
        {activeStep && (
          <div
            className={`
              p-4 rounded-xl border transition-all
              ${
                activeStep.isStudentMistake
                  ? "bg-rose-950/30 border-rose-500/50"
                  : "bg-slate-900 border-slate-800"
              }
            `}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-sm font-bold text-white">{activeStep.title}</span>
              {activeStep.isStudentMistake && (
                <span className="inline-flex items-center justify-center leading-none px-2.5 py-1 rounded-full text-xs font-extrabold bg-rose-500 text-white border border-rose-400">
                  학생 오류 발생 지점
                </span>
              )}
            </div>

            {/* Formula Block */}
            <div className="p-3 my-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-sm text-center text-blue-300">
              {activeStep.formula}
            </div>

            {/* Mistake Detail if any */}
            {activeStep.isStudentMistake && activeStep.mistakeDetail && (
              <div className="p-2.5 my-2 rounded-lg bg-rose-900/40 border border-rose-500/30 text-xs text-rose-200">
                <strong>⚠️ 오류 상세:</strong> {activeStep.mistakeDetail}
              </div>
            )}

            {/* Explanation & Tip */}
            <p className="text-xs text-slate-300 leading-relaxed mt-2">
              {activeStep.correctExplanation}
            </p>
            {activeStep.tip && (
              <p className="text-xs text-amber-300 leading-relaxed mt-1 flex items-center gap-1">
                <span>💡 팁:</span> {activeStep.tip}
              </p>
            )}
          </div>
        )}

        {/* Slider Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
          <button
            type="button"
            disabled={currentStepIndex <= 0}
            onClick={() => setCurrentStepIndex((p) => Math.max(0, p - 1))}
            className="
              min-w-[44px] min-h-[44px] h-[44px] px-3.5 rounded-xl border border-slate-700
              bg-slate-800 text-slate-200 text-xs font-semibold
              inline-flex items-center justify-center leading-none gap-1.5
              hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed
            "
          >
            ◀ 이전 단계
          </button>

          <span className="text-xs text-slate-400 font-medium">
            {currentStepIndex + 1} / {steps.length} 단계
          </span>

          <button
            type="button"
            disabled={currentStepIndex >= steps.length - 1}
            onClick={() => setCurrentStepIndex((p) => Math.min(steps.length - 1, p + 1))}
            className="
              min-w-[44px] min-h-[44px] h-[44px] px-3.5 rounded-xl border border-slate-700
              bg-slate-800 text-slate-200 text-xs font-semibold
              inline-flex items-center justify-center leading-none gap-1.5
              hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed
            "
          >
            다음 단계 ▶
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. Neubrutalism Gamification & Achievement Reward Badges/Stamps           */}
      {/* ========================================================================= */}
      <div className="flex flex-col gap-3 p-4 rounded-xl border border-slate-800 bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-base">🏆</span>
            <div>
              <h3 className="text-sm font-bold text-white">
                학생 성취 보상 & 학습 스탬프 (네오 브루탈리즘)
              </h3>
              <p className="text-[11px] text-slate-400">
                오답을 정복할 때마다 대칭 볼드 테두리와 하드 섀도우 학습 배지가 수여됩니다.
              </p>
            </div>
          </div>
        </div>

        {/* Neubrutalism Stamps Grid */}
        <div className="flex flex-wrap items-center gap-3 w-full">
          {badges.map((badge) => (
            <div
              key={badge.id}
              style={{
                backgroundColor: badge.bgColor,
                color: badge.textColor,
                border: "2.5px solid #09090b",
                boxShadow: badge.claimed ? "4px 4px 0px #09090b" : "2px 2px 0px #09090b",
                opacity: badge.claimed ? 1 : 0.65,
              }}
              className="
                flex-1 min-w-[200px] p-3 rounded-xl
                flex flex-col justify-between gap-2
                transition-all duration-150 select-none
              "
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xl">{badge.icon}</span>
                <span
                  style={{ border: "1.5px solid #09090b" }}
                  className="inline-flex items-center justify-center leading-none px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-white/60"
                >
                  {badge.claimed ? "획득 완료" : "잠금 해제 가능"}
                </span>
              </div>

              <div>
                <h4 className="text-sm font-extrabold tracking-tight">
                  {badge.name}
                </h4>
                <p className="text-[11px] font-medium leading-tight mt-0.5 opacity-90">
                  {badge.description}
                </p>
              </div>

              {!badge.claimed && (
                <button
                  type="button"
                  onClick={() => handleClaim(badge.id)}
                  style={{
                    border: "2px solid #09090b",
                    boxShadow: "2px 2px 0px #09090b",
                  }}
                  className="
                    min-h-[44px] w-full px-3 py-1.5 rounded-lg
                    bg-white hover:bg-zinc-100 text-zinc-900 font-extrabold text-xs
                    inline-flex items-center justify-center leading-none mt-1
                    active:translate-x-[1px] active:translate-y-[1px]
                  "
                >
                  도장 받기 ✨
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 5. Footer Actions (Retry & Save to Notes)                                 */}
      {/* ========================================================================= */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-2 border-t border-slate-800">
        <TactileToolButton
          variant="glass"
          onClick={() => alert("오답 노트에 저장되었습니다.")}
          label="오답 노트 저장"
        >
          📝 오답 노트에 저장
        </TactileToolButton>

        <TactileToolButton
          variant="solid"
          onClick={onRetryQuestion}
          label="유사 문제 재도전"
        >
          🔄 유사 문제 재도전
        </TactileToolButton>
      </div>
    </div>
  );
};
