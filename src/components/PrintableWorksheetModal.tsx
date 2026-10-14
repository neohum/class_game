"use client";

import React, { useState, useMemo } from "react";
import {
  generatePrintableWorksheet,
  renderWorksheetAsSvg,
  type WorksheetDifficulty,
} from "@/lib/worksheetGenerator";
import type { EISStage } from "@/lib/pedagogyEngine";

export interface PrintableWorksheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameId?: string;
  gameTitle?: string;
  initialGrade?: number;
  initialDifficulty?: WorksheetDifficulty;
  initialEisStage?: EISStage;
}

export const PrintableWorksheetModal: React.FC<PrintableWorksheetModalProps> = ({
  isOpen,
  onClose,
  gameId = "number-catch-run",
  gameTitle = "달려라 숫자잡기",
  initialGrade = 1,
  initialDifficulty = "standard",
  initialEisStage = "enactive",
}) => {
  const [grade, setGrade] = useState<number>(initialGrade);
  const [difficulty, setDifficulty] =
    useState<WorksheetDifficulty>(initialDifficulty);
  const [focusEisStage, setFocusEisStage] =
    useState<EISStage>(initialEisStage);
  const [showAnswerKey, setShowAnswerKey] = useState<boolean>(true);

  const worksheet = useMemo(
    () =>
      generatePrintableWorksheet({
        gameId,
        gameTitle,
        grade,
        difficulty,
        focusEisStage,
      }),
    [gameId, gameTitle, grade, difficulty, focusEisStage]
  );

  if (!isOpen) return null;

  const handlePrint = () => {
    if (typeof window !== "undefined" && typeof window.print === "function") {
      window.print();
    }
  };

  const handleDownloadSvg = () => {
    if (typeof window === "undefined") return;
    const svgContent = renderWorksheetAsSvg(worksheet, showAnswerKey);
    const blob = new Blob([svgContent], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${worksheet.id}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="printable-worksheet-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "rgba(15, 23, 42, 0.85)",
        backdropFilter: "blur(4px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px",
        overflowY: "auto",
        wordBreak: "keep-all",
      }}
    >
      <style>{worksheet.printCss}</style>

      {/* 상단 제어 바 (인쇄 시 숨김: .no-print .worksheet-modal-controls) */}
      <div
        className="no-print worksheet-modal-controls"
        style={{
          width: "100%",
          maxWidth: "840px",
          backgroundColor: "#ffffff",
          color: "#0f172a",
          border: "3px solid #0f172a",
          borderRadius: "20px",
          boxShadow: "0 8px 0 #0f172a",
          padding: "16px 20px",
          marginBottom: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div>
            <h2
              id="printable-worksheet-modal-title"
              style={{ fontSize: "1.3rem", fontWeight: 800, margin: 0 }}
            >
              🖨️ {gameTitle} · A4 맞춤 복합 학습지 생성기
            </h2>
            <p style={{ fontSize: "0.82rem", color: "#475569", margin: 0 }}>
              브루너 EIS(구체물·보조선·기호 수식) + 메타인지 오류 찾기 + 교사용 정답지
            </p>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <button
              type="button"
              onClick={handlePrint}
              style={{
                minHeight: "44px",
                padding: "0 16px",
                borderRadius: "12px",
                border: "2.5px solid #0f172a",
                boxShadow: "0 3px 0 #0f172a",
                backgroundColor: "#34d399",
                color: "#0f172a",
                fontWeight: 800,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              🖨️ A4 인쇄하기
            </button>
            <button
              type="button"
              onClick={handleDownloadSvg}
              style={{
                minHeight: "44px",
                padding: "0 16px",
                borderRadius: "12px",
                border: "2.5px solid #0f172a",
                boxShadow: "0 3px 0 #0f172a",
                backgroundColor: "#38bdf8",
                color: "#0f172a",
                fontWeight: 800,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              💾 SVG 다운로드
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                minHeight: "44px",
                padding: "0 14px",
                borderRadius: "12px",
                border: "2.5px solid #0f172a",
                backgroundColor: "#f1f5f9",
                color: "#0f172a",
                fontWeight: 800,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              닫기 ✕
            </button>
          </div>
        </div>

        {/* 학년 / 난이도 / EIS 중점 단계 / 정답지 토글 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
            paddingTop: "8px",
            borderTop: "1.5px solid #e2e8f0",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.82rem", marginRight: "4px" }}>학년:</strong>
            {[1, 2, 3, 4, 5, 6].map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrade(g)}
                style={{
                  minHeight: "38px",
                  padding: "0 10px",
                  borderRadius: "8px",
                  border: "2px solid #0f172a",
                  backgroundColor: grade === g ? "#fde047" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  fontSize: "0.8rem",
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

          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.82rem", marginRight: "4px" }}>난이도:</strong>
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
                  minHeight: "38px",
                  padding: "0 10px",
                  borderRadius: "8px",
                  border: "2px solid #0f172a",
                  backgroundColor: difficulty === d.id ? "#bae6fd" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  fontSize: "0.8rem",
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

          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" }}>
            <strong style={{ fontSize: "0.82rem", marginRight: "4px" }}>EIS 단계:</strong>
            {(
              [
                { id: "enactive", label: "구체물(E)" },
                { id: "iconic", label: "영상(I)" },
                { id: "symbolic", label: "기호(S)" },
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setFocusEisStage(st.id)}
                style={{
                  minHeight: "38px",
                  padding: "0 10px",
                  borderRadius: "8px",
                  border: "2px solid #0f172a",
                  backgroundColor: focusEisStage === st.id ? "#bbf7d0" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  fontSize: "0.8rem",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {st.label}
              </button>
            ))}
          </div>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.82rem",
              fontWeight: 800,
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            <input
              type="checkbox"
              checked={showAnswerKey}
              onChange={(e) => setShowAnswerKey(e.target.checked)}
            />
            교사용 정답지 표시
          </label>
        </div>
      </div>

      {/* A4 규격 학습지 본문 영역 (#printable-a4-worksheet) */}
      <article
        id="printable-a4-worksheet"
        style={{
          width: "100%",
          maxWidth: "794px",
          backgroundColor: "#ffffff",
          color: "#0f172a",
          border: "3px solid #0f172a",
          borderRadius: "16px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          boxShadow: "0 10px 25px rgba(0,0,0,0.35)",
        }}
      >
        {/* 학습지 상단 타이틀 및 학생 인적사항 칸 */}
        <div
          className="worksheet-section-box"
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            borderBottom: "2.5px solid #0f172a",
            paddingBottom: "10px",
          }}
        >
          <div>
            <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#0369a1" }}>
              {worksheet.curriculumStandardKo}
            </div>
            <h1 style={{ fontSize: "1.4rem", fontWeight: 900, margin: "2px 0 0" }}>
              {worksheet.gameTitle} · {worksheet.grade}학년 맞춤 복합 학습지
            </h1>
          </div>
          <div
            style={{
              border: "2px solid #0f172a",
              borderRadius: "10px",
              padding: "8px 14px",
              fontSize: "0.85rem",
              fontWeight: 700,
            }}
          >
            {worksheet.grade}학년 ( &nbsp;&nbsp; )반 &nbsp; 이름: ________________
          </div>
        </div>

        {/* EIS 3단계 문항 (구체물 그림 영역 + 보조선 빈칸 + 기호 수식) */}
        {worksheet.eisItems.map((item, idx) => (
          <section
            key={item.id}
            className="worksheet-section-box"
            style={{
              border:
                item.eisStage === focusEisStage
                  ? "2.5px solid #0284c7"
                  : "2px solid #1e293b",
              borderRadius: "12px",
              padding: "12px 14px",
              backgroundColor:
                item.eisStage === focusEisStage ? "#f0f9ff" : "#f8fafc",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong style={{ fontSize: "0.95rem", color: "#0f172a" }}>
                [문항 {idx + 1} · {item.stageLabelKo}] {item.prompt}
              </strong>
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 800,
                  padding: "3px 8px",
                  borderRadius: "999px",
                  border: "1.5px solid #0f172a",
                  backgroundColor: "#ffffff",
                }}
              >
                {item.eisStage.toUpperCase()}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "16px",
              }}
            >
              {/* 구체물 그림 / 보조선 SVG 영역 */}
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: "10px",
                  backgroundColor: "#0f172a",
                  border: "1.5px solid #334155",
                }}
                dangerouslySetInnerHTML={{ __html: item.visualAreaSvg }}
              />

              {/* 보조선 빈칸 + 기호 수식 */}
              <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <div style={{ fontSize: "0.86rem", color: "#334155", fontWeight: 700 }}>
                  • 보조선 빈칸: {item.scaffoldBlankText}
                </div>
                <div
                  style={{
                    fontSize: "1.05rem",
                    fontWeight: 900,
                    color: "#0f172a",
                    padding: "6px 10px",
                    backgroundColor: "#ffffff",
                    border: "1.5px dashed #334155",
                    borderRadius: "8px",
                  }}
                >
                  기호 수식: {item.symbolicEquation} &nbsp;&nbsp; ➔ 답: ( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )
                </div>
              </div>
            </div>
          </section>
        ))}

        {/* 문항 4: 메타인지 오류 찾기 1문항 */}
        <section
          className="worksheet-section-box"
          style={{
            border: "2.5px solid #b45309",
            borderRadius: "12px",
            padding: "12px 14px",
            backgroundColor: "#fffbeb",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          <strong style={{ fontSize: "0.95rem", color: "#92400e" }}>
            [문항 4 · 메타인지 오류 찾기] {worksheet.errorAnalysisQuestion.characterAvatar}{" "}
            {worksheet.errorAnalysisQuestion.characterName}의 틀린 풀이를 찾아 고쳐 보세요!
          </strong>
          <div style={{ fontSize: "0.88rem", fontWeight: 700 }}>
            문제: {worksheet.errorAnalysisQuestion.questionPrompt} &nbsp; (
            {worksheet.errorAnalysisQuestion.characterName}의 오답:{" "}
            {worksheet.errorAnalysisQuestion.characterWrongAnswer})
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "3px",
              padding: "8px 10px",
              backgroundColor: "#ffffff",
              borderRadius: "8px",
              border: "1.5px solid #d97706",
              fontSize: "0.84rem",
            }}
          >
            {worksheet.errorAnalysisQuestion.steps.map((st) => (
              <div key={st.stepNumber}>
                <strong>{st.stepNumber}단계:</strong> {st.expression} ({st.description})
              </div>
            ))}
          </div>
          <div style={{ fontSize: "0.86rem", fontWeight: 800, marginTop: "4px" }}>
            ① 처음 틀린 단계: ( &nbsp;&nbsp;&nbsp; )단계 &nbsp;&nbsp; ② 바르게 고친 정답: ( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )
          </div>
          <div style={{ fontSize: "0.86rem", fontWeight: 800 }}>
            ③ 왜 틀렸는지 이유 적기: ________________________________________________________
          </div>
        </section>

        {/* 교사용 정답지 및 해설 */}
        {showAnswerKey && (
          <section
            className="worksheet-section-box"
            style={{
              border: "2px dashed #475569",
              borderRadius: "12px",
              padding: "10px 14px",
              backgroundColor: "#f1f5f9",
              fontSize: "0.8rem",
            }}
          >
            <strong style={{ display: "block", marginBottom: "4px", color: "#0f172a" }}>
              ✂️ [교사용 정답지 및 오개념 지도 가이드]
            </strong>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
              {worksheet.teacherAnswerKey.map((entry) => (
                <span key={entry.itemNumber}>
                  <strong>{entry.itemNumber}:</strong> {entry.answer}
                </span>
              ))}
            </div>
            <div style={{ marginTop: "4px", color: "#334155" }}>
              • 지도 포인트: {worksheet.errorAnalysisQuestion.visualHintSvgDesc}
            </div>
          </section>
        )}
      </article>
    </div>
  );
};

export default PrintableWorksheetModal;
