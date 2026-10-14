"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import {
  PedagogyEngine,
  GAGNE_NINE_EVENTS,
  type EISStage,
} from "@/lib/pedagogyEngine";
import {
  getGradeCurriculumPreset,
  type GradeNumber,
} from "@/lib/gradeMathCurriculum";
import type {
  MasteryBadgeRecord,
  ErrorAnalysisEvaluationResult,
} from "@/lib/errorAnalysisChallenge";
import ErrorAnalysisModal from "@/components/ErrorAnalysisModal";
import PrintableWorksheetModal from "@/components/PrintableWorksheetModal";
import type { WorksheetDifficulty } from "@/lib/worksheetGenerator";

export interface GameDetailProps {
  gameId?: string;
  gameName?: string;
  initialGrade?: GradeNumber;
  initialEisStage?: EISStage;
  initialDifficulty?: WorksheetDifficulty;
}

export default function GameDetail({
  gameId = "number-catch-run",
  gameName = "달려라 숫자잡기",
  initialGrade = 1,
  initialEisStage = "enactive",
  initialDifficulty = "standard",
}: GameDetailProps) {
  const [grade, setGrade] = useState<GradeNumber>(initialGrade);
  const [players, setPlayers] = useState<number>(1);
  const [eisStage, setEisStage] = useState<EISStage>(initialEisStage);
  const [difficulty, setDifficulty] =
    useState<WorksheetDifficulty>(initialDifficulty);

  const [isWorksheetOpen, setIsWorksheetOpen] = useState<boolean>(false);
  const [isErrorChallengeOpen, setIsErrorChallengeOpen] =
    useState<boolean>(false);

  const [earnedBadges, setEarnedBadges] = useState<MasteryBadgeRecord[]>([]);
  const [transferBonus, setTransferBonus] = useState<number>(0);

  const engine = useMemo(
    () =>
      new PedagogyEngine({
        grade,
        initialEisStage: eisStage,
      }),
    [grade, eisStage]
  );

  const preset = useMemo(() => getGradeCurriculumPreset(grade), [grade]);
  const pedagogyState = engine.getState();

  const domain: "math" | "clock" | "hangul" = useMemo(() => {
    if (gameId.includes("clock")) return "clock";
    if (
      gameId.includes("hangul") ||
      gameId.includes("word") ||
      gameId.includes("chosung")
    ) {
      return "hangul";
    }
    return "math";
  }, [gameId]);

  const iframeSrc = `/games/${gameId}/index.html?players=${players}&grade=${grade}`;

  const handleErrorChallengeComplete = (
    res: ErrorAnalysisEvaluationResult
  ) => {
    setTransferBonus((prev) => prev + res.transferBonusPoints);
    if (res.masteryBadge) {
      setEarnedBadges((prev) =>
        prev.some((b) => b.id === res.masteryBadge?.id)
          ? prev
          : [...prev, res.masteryBadge!]
      );
    }
  };

  return (
    <main
      style={{
        maxWidth: "1200px",
        margin: "0 auto",
        padding: "24px 16px 64px",
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        wordBreak: "keep-all",
      }}
    >
      {/* 상단 네비게이션 및 액션 툴바 */}
      <section
        className="no-print"
        style={{
          backgroundColor: "#ffffff",
          border: "4px solid #1e293b",
          borderRadius: "24px",
          boxShadow: "0 10px 0 #1e293b",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <Link
              href="/"
              style={{
                fontSize: "0.85rem",
                fontWeight: 800,
                color: "#0284c7",
                textDecoration: "none",
              }}
            >
              ← 전체 교실 게임 허브로 돌아가기
            </Link>
            <h1
              style={{
                fontSize: "2rem",
                fontWeight: 900,
                color: "#0f172a",
                margin: 0,
              }}
            >
              🎮 {gameName}
            </h1>
            <p style={{ fontSize: "0.9rem", color: "#475569", margin: 0 }}>
              {preset.curriculumStandardKo} · 세로 배치 앵커: {preset.verticalAnchor}
            </p>
          </div>

          {/* 핵심 교수설계 액션 버튼: 맞춤 학습지 인쇄 & 오류 찾기 챌린지 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
            <button
              type="button"
              onClick={() => setIsErrorChallengeOpen(true)}
              style={{
                minHeight: "48px",
                padding: "0 20px",
                borderRadius: "14px",
                border: "3px solid #1e293b",
                boxShadow: "0 4px 0 #1e293b",
                backgroundColor: "#fde047",
                color: "#0f172a",
                fontWeight: 800,
                fontSize: "1rem",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                gap: "6px",
              }}
            >
              🔍 오류 찾기 챌린지
            </button>

            <button
              type="button"
              onClick={() => setIsWorksheetOpen(true)}
              style={{
                minHeight: "48px",
                padding: "0 20px",
                borderRadius: "14px",
                border: "3px solid #1e293b",
                boxShadow: "0 4px 0 #1e293b",
                backgroundColor: "#34d399",
                color: "#0f172a",
                fontWeight: 800,
                fontSize: "1rem",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                gap: "6px",
              }}
            >
              🖨️ 맞춤 학습지 인쇄
            </button>

            <a
              href={iframeSrc}
              target="_blank"
              rel="noreferrer"
              style={{
                minHeight: "48px",
                padding: "0 18px",
                borderRadius: "14px",
                border: "3px solid #1e293b",
                boxShadow: "0 4px 0 #1e293b",
                backgroundColor: "#38bdf8",
                color: "#0f172a",
                fontWeight: 800,
                fontSize: "0.95rem",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              ⛶ 전자칠판 전체화면 실행
            </a>
          </div>
        </div>

        {/* 학년(1~6) · 인원수(1·2·4·6) · EIS 표상 단계 선택 바 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "14px",
            paddingTop: "12px",
            borderTop: "2px solid #e2e8f0",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#0f172a" }}>학년 선택:</strong>
            {([1, 2, 3, 4, 5, 6] as GradeNumber[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrade(g)}
                style={{
                  minHeight: "40px",
                  padding: "0 12px",
                  borderRadius: "10px",
                  border: "2px solid #1e293b",
                  backgroundColor: grade === g ? "#38bdf8" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {g}학년
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#0f172a" }}>플레이 인원:</strong>
            {[1, 2, 4, 6].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlayers(p)}
                style={{
                  minHeight: "40px",
                  padding: "0 12px",
                  borderRadius: "10px",
                  border: "2px solid #1e293b",
                  backgroundColor: players === p ? "#fde047" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {p}인용
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#0f172a" }}>EIS 표상 단계:</strong>
            {(
              [
                { id: "enactive", label: "구체물(E)" },
                { id: "iconic", label: "시각모형(I)" },
                { id: "symbolic", label: "기호수식(S)" },
              ] as const
            ).map((stage) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => setEisStage(stage.id)}
                style={{
                  minHeight: "40px",
                  padding: "0 12px",
                  borderRadius: "10px",
                  border: "2px solid #1e293b",
                  backgroundColor: eisStage === stage.id ? "#86efac" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {stage.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.85rem", color: "#0f172a" }}>학습지 난이도:</strong>
            {(
              [
                { id: "basic", label: "기초" },
                { id: "standard", label: "표준" },
                { id: "challenge", label: "심화" },
              ] as const
            ).map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDifficulty(d.id)}
                style={{
                  minHeight: "40px",
                  padding: "0 10px",
                  borderRadius: "10px",
                  border: "2px solid #1e293b",
                  backgroundColor: difficulty === d.id ? "#e9d5ff" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* 가네 9수업사태 및 획득한 메타인지 배지 요약 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderRadius: "14px",
            backgroundColor: "#f8fafc",
            border: "2px solid #cbd5e1",
            fontSize: "0.82rem",
          }}
        >
          <div>
            <strong>동적 비계 상태:</strong> 비계 레벨 {pedagogyState.scaffoldLevel} ·{" "}
            {pedagogyState.visualGuideOn ? "수모형/수직선 보조선 ON" : "기호 암산 모드"} ·{" "}
            가네 9수업사태 ({GAGNE_NINE_EVENTS.length}단계 순환 루프)
          </div>
          <div style={{ fontWeight: 800, color: "#0f766e" }}>
            🏆 메타인지 마스터리 배지: {earnedBadges.length}개 · 전이 보너스: +{transferBonus}점
          </div>
        </div>
      </section>

      {/* 게임 실행 Iframe 영역 */}
      <section
        className="no-print"
        style={{
          width: "100%",
          height: "640px",
          backgroundColor: "#0f172a",
          border: "4px solid #1e293b",
          borderRadius: "24px",
          boxShadow: "0 12px 0 #1e293b",
          overflow: "hidden",
        }}
      >
        <iframe
          key={iframeSrc}
          src={iframeSrc}
          title={`${gameName} 게임 실행 화면`}
          style={{ width: "100%", height: "100%", border: "none" }}
        />
      </section>

      {/* 메타인지 오류 찾기 챌린지 모달 */}
      <ErrorAnalysisModal
        isOpen={isErrorChallengeOpen}
        onClose={() => setIsErrorChallengeOpen(false)}
        initialGrade={grade}
        initialDomain={domain}
        onCompleted={handleErrorChallengeComplete}
      />

      {/* 인쇄용 A4 복합 학습지 모달 */}
      <PrintableWorksheetModal
        isOpen={isWorksheetOpen}
        onClose={() => setIsWorksheetOpen(false)}
        gameId={gameId}
        gameTitle={gameName}
        initialGrade={grade}
        initialDifficulty={difficulty}
        initialEisStage={eisStage}
      />
    </main>
  );
}
