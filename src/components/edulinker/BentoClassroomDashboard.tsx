import * as React from "react";
import { BentoGrid } from "../bento/BentoGrid.js";
import { BentoCard } from "../bento/BentoCard.js";
import { TactileToolButton } from "./TactileToolButton.js";

export type StudentStatus = "writing" | "submitted" | "idle" | "needs_help";

export interface StudentHandwritingStream {
  id: string;
  name: string;
  number: number;
  status: StudentStatus;
  strokeCount: number;
  progressPercent: number;
  lastActiveSecondsAgo: number;
  currentStep: number;
  sampleStrokeSvg?: string;
}

export interface BentoClassroomDashboardProps {
  className?: string;
  classroomName?: string;
  lessonTitle?: string;
  initialTimerSeconds?: number;
  students?: StudentHandwritingStream[];
  onNudgeStudent?: (studentId: string) => void;
  onBroadcastReminder?: () => void;
  onSelectStudent?: (student: StudentHandwritingStream) => void;
}

const DEFAULT_30_STUDENTS: StudentHandwritingStream[] = [
  { id: "s01", name: "김서연", number: 1, status: "writing", strokeCount: 142, progressPercent: 75, lastActiveSecondsAgo: 2, currentStep: 3 },
  { id: "s02", name: "이도윤", number: 2, status: "writing", strokeCount: 198, progressPercent: 90, lastActiveSecondsAgo: 1, currentStep: 4 },
  { id: "s03", name: "박지호", number: 3, status: "submitted", strokeCount: 220, progressPercent: 100, lastActiveSecondsAgo: 45, currentStep: 4 },
  { id: "s04", name: "정하은", number: 4, status: "writing", strokeCount: 164, progressPercent: 80, lastActiveSecondsAgo: 3, currentStep: 3 },
  { id: "s05", name: "최민준", number: 5, status: "needs_help", strokeCount: 62, progressPercent: 35, lastActiveSecondsAgo: 120, currentStep: 2 },
  { id: "s06", name: "강예준", number: 6, status: "writing", strokeCount: 180, progressPercent: 85, lastActiveSecondsAgo: 4, currentStep: 3 },
  { id: "s07", name: "윤서아", number: 7, status: "submitted", strokeCount: 210, progressPercent: 100, lastActiveSecondsAgo: 60, currentStep: 4 },
  { id: "s08", name: "임시우", number: 8, status: "writing", strokeCount: 110, progressPercent: 60, lastActiveSecondsAgo: 8, currentStep: 3 },
  { id: "s09", name: "한지우", number: 9, status: "writing", strokeCount: 145, progressPercent: 70, lastActiveSecondsAgo: 5, currentStep: 3 },
  { id: "s10", name: "오유진", number: 10, status: "submitted", strokeCount: 240, progressPercent: 100, lastActiveSecondsAgo: 90, currentStep: 4 },
  { id: "s11", name: "서현우", number: 11, status: "writing", strokeCount: 130, progressPercent: 65, lastActiveSecondsAgo: 7, currentStep: 3 },
  { id: "s12", name: "신수아", number: 12, status: "needs_help", strokeCount: 45, progressPercent: 25, lastActiveSecondsAgo: 180, currentStep: 2 },
  { id: "s13", name: "권민재", number: 13, status: "writing", strokeCount: 172, progressPercent: 82, lastActiveSecondsAgo: 2, currentStep: 3 },
  { id: "s14", name: "황지민", number: 14, status: "submitted", strokeCount: 205, progressPercent: 100, lastActiveSecondsAgo: 110, currentStep: 4 },
  { id: "s15", name: "송예린", number: 15, status: "writing", strokeCount: 155, progressPercent: 78, lastActiveSecondsAgo: 6, currentStep: 3 },
  { id: "s16", name: "안준혁", number: 16, status: "idle", strokeCount: 88, progressPercent: 50, lastActiveSecondsAgo: 210, currentStep: 2 },
  { id: "s17", name: "배은우", number: 17, status: "writing", strokeCount: 188, progressPercent: 88, lastActiveSecondsAgo: 3, currentStep: 4 },
  { id: "s18", name: "홍지아", number: 18, status: "submitted", strokeCount: 230, progressPercent: 100, lastActiveSecondsAgo: 130, currentStep: 4 },
  { id: "s19", name: "류도현", number: 19, status: "writing", strokeCount: 125, progressPercent: 68, lastActiveSecondsAgo: 9, currentStep: 3 },
  { id: "s20", name: "고하윤", number: 20, status: "writing", strokeCount: 160, progressPercent: 80, lastActiveSecondsAgo: 4, currentStep: 3 },
  { id: "s21", name: "문건우", number: 21, status: "submitted", strokeCount: 215, progressPercent: 100, lastActiveSecondsAgo: 140, currentStep: 4 },
  { id: "s22", name: "양시은", number: 22, status: "writing", strokeCount: 140, progressPercent: 72, lastActiveSecondsAgo: 5, currentStep: 3 },
  { id: "s23", name: "손우진", number: 23, status: "needs_help", strokeCount: 50, progressPercent: 30, lastActiveSecondsAgo: 150, currentStep: 2 },
  { id: "s24", name: "조다은", number: 24, status: "writing", strokeCount: 175, progressPercent: 84, lastActiveSecondsAgo: 2, currentStep: 3 },
  { id: "s25", name: "백승현", number: 25, status: "submitted", strokeCount: 200, progressPercent: 100, lastActiveSecondsAgo: 80, currentStep: 4 },
  { id: "s26", name: "유채원", number: 26, status: "writing", strokeCount: 150, progressPercent: 75, lastActiveSecondsAgo: 6, currentStep: 3 },
  { id: "s27", name: "남태양", number: 27, status: "idle", strokeCount: 75, progressPercent: 40, lastActiveSecondsAgo: 240, currentStep: 2 },
  { id: "s28", name: "심예원", number: 28, status: "writing", strokeCount: 168, progressPercent: 82, lastActiveSecondsAgo: 3, currentStep: 3 },
  { id: "s29", name: "노준영", number: 29, status: "submitted", strokeCount: 225, progressPercent: 100, lastActiveSecondsAgo: 50, currentStep: 4 },
  { id: "s30", name: "하서현", number: 30, status: "writing", strokeCount: 185, progressPercent: 86, lastActiveSecondsAgo: 1, currentStep: 4 },
];

/**
 * BentoClassroomDashboard
 * 
 * Teacher's 30-student real-time handwriting monitoring Bento Grid dashboard.
 * Features:
 * - 4-column Bento grid on desktop, 2-column on tablet, 1-column on mobile
 * - PicoMQ live stream status card (30 students, active pen writing, progress bar)
 * - Real-time classroom attention & focus gauge
 * - Lesson countdown timer widget with chime controls
 * - Unsubmitted / struggling students quick alert & nudge block
 * - 112 tools integration slot: spark 3DGS & tldraw collaborative board preview
 * 
 * Conforms to:
 * - Theorem 1 (Containment Math): 0px horizontal overflow on all viewports
 * - Theorem 2 (Row Overflow Math): Flex wrapping on all button groups
 * - Theorem 3 (Touch Targets): Minimum 44x44px bounding boxes
 * - Anti-Cuticle: Symmetric borders throughout
 * - Button & badge centering: inline-flex items-center justify-center leading-none
 */
export const BentoClassroomDashboard: React.FC<BentoClassroomDashboardProps> = ({
  className = "",
  classroomName = "3학년 2반 수학 (이차방정식 형성평가)",
  lessonTitle = "4단원: 인수분해를 활용한 이차방정식 풀이",
  initialTimerSeconds = 20 * 60,
  students = DEFAULT_30_STUDENTS,
  onNudgeStudent,
  onBroadcastReminder,
  onSelectStudent,
}) => {
  const [selectedStudentId, setSelectedStudentId] = React.useState<string>(students[0]?.id ?? "s01");
  const [statusFilter, setStatusFilter] = React.useState<"all" | StudentStatus>("all");
  const [timerSeconds, setTimerSeconds] = React.useState(initialTimerSeconds);
  const [isTimerRunning, setIsTimerRunning] = React.useState(true);
  const [chimeEnabled, setChimeEnabled] = React.useState(true);
  const [toolSlot, setToolSlot] = React.useState<"tldraw" | "spark3dgs">("tldraw");

  // Timer countdown tick
  React.useEffect(() => {
    if (!isTimerRunning || timerSeconds <= 0) return;
    const interval = setInterval(() => {
      setTimerSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isTimerRunning, timerSeconds]);

  const selectedStudent = students.find((s) => s.id === selectedStudentId) || students[0];

  // Aggregated Stats
  const submittedCount = students.filter((s) => s.status === "submitted").length;
  const writingCount = students.filter((s) => s.status === "writing").length;
  const needsHelpCount = students.filter((s) => s.status === "needs_help").length;
  const idleCount = students.filter((s) => s.status === "idle").length;
  const unsubmittedStudents = students.filter((s) => s.status !== "submitted");

  const filteredStudents = statusFilter === "all"
    ? students
    : students.filter((s) => s.status === statusFilter);

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const getStatusColor = (st: StudentStatus) => {
    switch (st) {
      case "writing":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
      case "submitted":
        return "bg-blue-500/20 text-blue-400 border-blue-500/40";
      case "needs_help":
        return "bg-rose-500/20 text-rose-400 border-rose-500/40";
      case "idle":
        return "bg-amber-500/20 text-amber-400 border-amber-500/40";
    }
  };

  const getStatusLabel = (st: StudentStatus) => {
    switch (st) {
      case "writing":
        return "실시간 작성 중";
      case "submitted":
        return "제출 완료";
      case "needs_help":
        return "오답 / 힌트 요청";
      case "idle":
        return "필기 대기 중";
    }
  };

  return (
    <div className={`w-full max-w-full text-slate-100 p-3 sm:p-5 flex flex-col gap-4 ${className}`}>
      {/* Top Classroom Bar */}
      <div className="w-full flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-md">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center justify-center leading-none px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              교사용 라이브 LMS
            </span>
            <span className="inline-flex items-center justify-center leading-none gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              PicoMQ: 30/30 노드 연결됨
            </span>
          </div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white mt-1">
            {classroomName}
          </h1>
          <p className="text-xs text-slate-400">{lessonTitle}</p>
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <TactileToolButton
            variant="glass"
            onClick={onBroadcastReminder}
            label="전체 리마인더"
            icon={
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            }
          >
            전체 리마인더 발송
          </TactileToolButton>

          <TactileToolButton
            variant="solid"
            onClick={() => setTimerSeconds((prev) => prev + 300)}
            label="수업 시간 5분 연장"
          >
            +5분 연장
          </TactileToolButton>
        </div>
      </div>

      {/* Main Bento Grid */}
      <BentoGrid columns={4} gap={4}>
        {/* ========================================================================= */}
        {/* CARD 1: 30인 학생 필기 실시간 스트림 (lg: 2 cols x 2 rows)                */}
        {/* ========================================================================= */}
        <BentoCard
          colSpan={2}
          rowSpan={2}
          title="30인 학생 필기 스트림 (PicoMQ)"
          badge={`제출 ${submittedCount}/30 (${Math.round((submittedCount / 30) * 100)}%)`}
          subtitle="스마트펜에서 전송되는 획 벡터 데이터가 실시간으로 수신되고 있습니다."
          headerAction={
            <div className="flex flex-wrap items-center gap-1">
              {(["all", "writing", "needs_help", "submitted"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={`
                    min-h-[44px] px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all
                    inline-flex items-center justify-center leading-none
                    ${
                      statusFilter === filter
                        ? "bg-blue-600 text-white border-blue-400"
                        : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                    }
                  `}
                >
                  {filter === "all" ? "전체(30)" : filter === "writing" ? `작성(${writingCount})` : filter === "needs_help" ? `도움(${needsHelpCount})` : `완료(${submittedCount})`}
                </button>
              ))}
            </div>
          }
          footer={
            <div className="w-full flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <span>선택 학생: <strong className="text-white">{selectedStudent?.number}번 {selectedStudent?.name}</strong></span>
              <span className="inline-flex items-center justify-center leading-none px-2 py-0.5 rounded-full border text-[11px] font-medium"
                style={{ borderColor: "rgba(255,255,255,0.15)" }}>
                {selectedStudent?.strokeCount}획 렌더링 중
              </span>
            </div>
          }
        >
          <div className="flex flex-col gap-3 h-full">
            {/* 30 Student Grid Chips */}
            <div className="grid grid-cols-5 sm:grid-cols-6 gap-2 max-h-[220px] overflow-y-auto p-1 border border-slate-800 rounded-xl bg-slate-950/60">
              {filteredStudents.map((s) => {
                const isSelected = s.id === selectedStudentId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setSelectedStudentId(s.id);
                      onSelectStudent?.(s);
                    }}
                    className={`
                      min-h-[44px] p-1.5 rounded-lg border text-left transition-all
                      flex flex-col justify-between
                      ${isSelected ? "border-blue-400 bg-blue-950/50 shadow-sm" : "border-slate-800 bg-slate-900/60 hover:border-slate-700"}
                    `}
                    aria-label={`${s.number}번 ${s.name} (${getStatusLabel(s.status)})`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-[11px] font-bold text-slate-200">{s.number}. {s.name}</span>
                      <span className={`w-2 h-2 rounded-full ${s.status === "writing" ? "bg-emerald-400 animate-ping" : s.status === "needs_help" ? "bg-rose-400" : s.status === "submitted" ? "bg-blue-400" : "bg-slate-500"}`} />
                    </div>
                    <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                      <div
                        style={{ width: `${s.progressPercent}%` }}
                        className={`h-full ${s.status === "needs_help" ? "bg-rose-500" : "bg-blue-500"}`}
                      />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Selected Student Real-Time Handwriting Preview Canvas */}
            <div className="flex-1 min-h-[140px] p-3 rounded-xl border border-slate-800 bg-slate-950 flex flex-col justify-between">
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-white">{selectedStudent?.number}번 {selectedStudent?.name}</span>
                  <span className={`inline-flex items-center justify-center leading-none px-2 py-0.5 rounded-full text-[10px] font-bold border ${getStatusColor(selectedStudent?.status || "writing")}`}>
                    {getStatusLabel(selectedStudent?.status || "writing")}
                  </span>
                </span>
                <span className="text-slate-400">{selectedStudent?.lastActiveSecondsAgo}초 전 작성</span>
              </div>

              {/* Vector handwriting mock illustration */}
              <div className="my-2 p-2 rounded-lg bg-slate-900 border border-slate-800/80 flex items-center justify-center min-h-[80px]">
                <svg className="w-full max-w-[280px] h-16" viewBox="0 0 280 60" fill="none">
                  <path d="M10 35 Q 35 10, 60 30 T 110 35" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" fill="none" />
                  <path d="M115 30 L 140 25 M 125 15 L 125 45" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
                  <path d="M150 40 Q 170 20, 190 35 T 230 25" stroke={selectedStudent?.status === "needs_help" ? "#f87171" : "#34d399"} strokeWidth="2.5" strokeLinecap="round" fill="none" />
                  <circle cx="230" cy="25" r="3" fill="#60a5fa" />
                </svg>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-400">현재 풀이 단계: <strong className="text-slate-200">Step {selectedStudent?.currentStep} / 4</strong></span>
                {selectedStudent?.status === "needs_help" && (
                  <button
                    type="button"
                    onClick={() => onNudgeStudent?.(selectedStudent.id)}
                    className="min-h-[44px] px-3 rounded-lg border border-rose-500/40 bg-rose-500/20 text-rose-300 text-xs font-semibold inline-flex items-center justify-center leading-none hover:bg-rose-500/30"
                  >
                    💡 1:1 힌트 전송
                  </button>
                )}
              </div>
            </div>
          </div>
        </BentoCard>

        {/* ========================================================================= */}
        {/* CARD 2: 실시간 학급 집중도 게이지 (lg: 1 col)                              */}
        {/* ========================================================================= */}
        <BentoCard
          colSpan={1}
          rowSpan={1}
          title="실시간 학급 집중도"
          badge="AI 집중 분석"
        >
          <div className="flex flex-col items-center justify-center gap-3 py-2">
            {/* Circular Gauge */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" stroke="#1e293b" strokeWidth="10" fill="none" />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  stroke="#3b82f6"
                  strokeWidth="10"
                  strokeDasharray="251.2"
                  strokeDashoffset={251.2 * (1 - 0.88)}
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              <div className="absolute flex flex-col items-center justify-center">
                <span className="text-2xl font-black text-white">88%</span>
                <span className="text-[10px] text-slate-400">집중 지수</span>
              </div>
            </div>

            {/* Metrics Breakdown */}
            <div className="w-full flex flex-wrap justify-between gap-1 text-xs text-slate-300 border-t border-slate-800 pt-2">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400" /> 고집중 21명
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-400" /> 보통 6명
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-rose-400" /> 저조 3명
              </span>
            </div>
          </div>
        </BentoCard>

        {/* ========================================================================= */}
        {/* CARD 3: 수업 타이머 & 알림 위젯 (lg: 1 col)                              */}
        {/* ========================================================================= */}
        <BentoCard
          colSpan={1}
          rowSpan={1}
          title="수업 타이머"
          badge="형성평가"
        >
          <div className="flex flex-col items-center justify-between gap-3 py-1 h-full">
            {/* Big Countdown Display */}
            <div className="text-3xl sm:text-4xl font-mono font-extrabold tracking-wider text-white">
              {formatTimer(timerSeconds)}
            </div>

            {/* Timer Controls Row */}
            <div className="flex flex-wrap items-center justify-center gap-2 w-full">
              <button
                type="button"
                onClick={() => setIsTimerRunning(!isTimerRunning)}
                className="
                  min-w-[44px] min-h-[44px] h-[44px] px-3.5
                  rounded-xl border border-blue-500/40
                  bg-blue-600 text-white font-semibold text-xs
                  inline-flex items-center justify-center leading-none
                  hover:bg-blue-500 transition-colors
                "
              >
                {isTimerRunning ? "일시정지" : "시작"}
              </button>

              <button
                type="button"
                onClick={() => setTimerSeconds((p) => p + 60)}
                className="
                  min-w-[44px] min-h-[44px] h-[44px] px-3
                  rounded-xl border border-slate-700
                  bg-slate-800 text-slate-200 text-xs font-medium
                  inline-flex items-center justify-center leading-none
                  hover:bg-slate-700
                "
              >
                +1분
              </button>

              <button
                type="button"
                onClick={() => setTimerSeconds(initialTimerSeconds)}
                className="
                  min-w-[44px] min-h-[44px] h-[44px] px-3
                  rounded-xl border border-slate-700
                  bg-slate-800 text-slate-200 text-xs font-medium
                  inline-flex items-center justify-center leading-none
                  hover:bg-slate-700
                "
              >
                리셋
              </button>

              <button
                type="button"
                onClick={() => setChimeEnabled(!chimeEnabled)}
                className={`
                  min-w-[44px] min-h-[44px] h-[44px] px-3
                  rounded-xl border text-xs font-medium
                  inline-flex items-center justify-center leading-none
                  ${chimeEnabled ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-700 text-slate-400"}
                `}
                aria-label="종소리 알림 토글"
              >
                {chimeEnabled ? "🔔 켬" : "🔕 끔"}
              </button>
            </div>
          </div>
        </BentoCard>

        {/* ========================================================================= */}
        {/* CARD 4: 미제출자 퀵 알림 블록 (lg: 2 cols)                                */}
        {/* ========================================================================= */}
        <BentoCard
          colSpan={2}
          rowSpan={1}
          title="미제출자 퀵 알림 & 지원 블록"
          badge={`미제출 ${unsubmittedStudents.length}명`}
          subtitle="시간 내에 작성을 완료하지 못하거나 오답 패턴이 반복되는 학생 목록입니다."
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {unsubmittedStudents.slice(0, 6).map((st) => (
                <div
                  key={st.id}
                  className="
                    flex items-center gap-2 px-3 py-1.5 rounded-xl
                    border border-slate-800 bg-slate-950/70 text-xs
                  "
                >
                  <span className="font-semibold text-slate-200">{st.number}. {st.name}</span>
                  <span className={`inline-flex items-center justify-center leading-none px-1.5 py-0.5 rounded text-[10px] border ${getStatusColor(st.status)}`}>
                    {getStatusLabel(st.status)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onNudgeStudent?.(st.id)}
                    className="
                      min-w-[44px] min-h-[44px] h-[44px] px-2 rounded-lg
                      border border-slate-700 hover:border-blue-400
                      bg-slate-800 text-slate-200 hover:text-white
                      inline-flex items-center justify-center leading-none text-xs
                    "
                    aria-label={`${st.name} 학생에게 힌트 전송`}
                  >
                    힌트
                  </button>
                </div>
              ))}
            </div>
          </div>
        </BentoCard>

        {/* ========================================================================= */}
        {/* CARD 5: 112대 도구 연동 슬롯 (spark 3DGS & tldraw) (lg: 2 cols)             */}
        {/* ========================================================================= */}
        <BentoCard
          colSpan={2}
          rowSpan={1}
          title="협업 판서 & 3D 공간 뷰어 (112 도구군)"
          badge="spark 3DGS + tldraw"
          headerAction={
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setToolSlot("tldraw")}
                className={`
                  min-h-[44px] px-3 text-xs font-semibold rounded-lg border
                  inline-flex items-center justify-center leading-none
                  ${toolSlot === "tldraw" ? "bg-indigo-600 text-white border-indigo-400" : "bg-slate-800 text-slate-300 border-slate-700"}
                `}
              >
                tldraw 무한 판서
              </button>
              <button
                type="button"
                onClick={() => setToolSlot("spark3dgs")}
                className={`
                  min-h-[44px] px-3 text-xs font-semibold rounded-lg border
                  inline-flex items-center justify-center leading-none
                  ${toolSlot === "spark3dgs" ? "bg-purple-600 text-white border-purple-400" : "bg-slate-800 text-slate-300 border-slate-700"}
                `}
              >
                spark 3DGS 가상 교실
              </button>
            </div>
          }
        >
          <div className="w-full min-h-[90px] rounded-xl border border-slate-800 bg-slate-950 p-3 flex items-center justify-between gap-3">
            {toolSlot === "tldraw" ? (
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-semibold text-indigo-300">✏️ tldraw 다자간 판서 세션 활성화</span>
                <span className="text-slate-400">학급 전체 30명의 스마트펜 궤적이 실시간 합성되는 무한 캔버스입니다.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-semibold text-purple-300">🌐 spark 3DGS 공간 뷰어</span>
                <span className="text-slate-400">교실 좌석 배치도 및 실시간 모둠별 시선 방향을 3차원 가우시안 스플래팅으로 시각화합니다.</span>
              </div>
            )}
            <span className="inline-flex items-center justify-center leading-none px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-medium text-slate-300">
              연동 대기 중
            </span>
          </div>
        </BentoCard>
      </BentoGrid>
    </div>
  );
};
