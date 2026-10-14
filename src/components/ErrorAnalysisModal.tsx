"use client";

import React, { useState, useMemo } from "react";
import {
  ERROR_ANALYSIS_BANK,
  evaluateErrorAnalysisSubmission,
  type ErrorAnalysisItem,
  type ErrorAnalysisEvaluationResult,
} from "@/lib/errorAnalysisChallenge";
import { GAGNE_NINE_EVENTS } from "@/lib/pedagogyEngine";

export interface ErrorAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialGrade?: number;
  initialDomain?: "math" | "clock" | "hangul";
  onCompleted?: (result: ErrorAnalysisEvaluationResult, item: ErrorAnalysisItem) => void;
}

export const ErrorAnalysisModal: React.FC<ErrorAnalysisModalProps> = ({
  isOpen,
  onClose,
  initialGrade = 2,
  initialDomain,
  onCompleted,
}) => {
  const [selectedGrade, setSelectedGrade] = useState<number>(initialGrade);
  const filteredChallenges = useMemo(() => {
    const byGrade = ERROR_ANALYSIS_BANK.filter(
      (item) =>
        item.grade === selectedGrade &&
        (!initialDomain || item.domain === initialDomain)
    );
    return byGrade.length > 0 ? byGrade : ERROR_ANALYSIS_BANK;
  }, [selectedGrade, initialDomain]);

  const [challengeIndex, setChallengeIndex] = useState<number>(0);
  const activeChallenge =
    filteredChallenges[challengeIndex % filteredChallenges.length] ||
    ERROR_ANALYSIS_BANK[0];

  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [selectedReasonId, setSelectedReasonId] = useState<string>("");
  const [correctedAnswer, setCorrectedAnswer] = useState<string>("");
  const [evaluation, setEvaluation] =
    useState<ErrorAnalysisEvaluationResult | null>(null);

  if (!isOpen) return null;

  const handleGradeChange = (grade: number) => {
    setSelectedGrade(grade);
    setChallengeIndex(0);
    setSelectedStep(null);
    setSelectedReasonId("");
    setCorrectedAnswer("");
    setEvaluation(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedStep === null || !selectedReasonId || !correctedAnswer.trim()) {
      return;
    }
    const res = evaluateErrorAnalysisSubmission(activeChallenge, {
      selectedStepNumber: selectedStep,
      selectedReasonId,
      correctedAnswer,
    });
    setEvaluation(res);
    if (res.passed) {
      onCompleted?.(res, activeChallenge);
    }
  };

  const handleNextChallenge = () => {
    setChallengeIndex((prev) => prev + 1);
    setSelectedStep(null);
    setSelectedReasonId("");
    setCorrectedAnswer("");
    setEvaluation(null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="error-analysis-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        backgroundColor: "rgba(15, 23, 42, 0.82)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        wordBreak: "keep-all",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "760px",
          maxHeight: "92vh",
          overflowY: "auto",
          backgroundColor: "#ffffff",
          color: "#1e293b",
          border: "4px solid #1e293b",
          borderRadius: "24px",
          boxShadow: "0 12px 0 #1e293b",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        {/* 상단 헤더 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            borderBottom: "2px solid #e2e8f0",
            paddingBottom: "12px",
          }}
        >
          <div>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                padding: "6px 12px",
                borderRadius: "999px",
                backgroundColor: "#fef3c7",
                color: "#92400e",
                border: "2px solid #1e293b",
                fontSize: "0.78rem",
                fontWeight: 800,
                marginBottom: "6px",
              }}
            >
              🔍 가네 9수업사태 · 메타인지 오류 찾기 챌린지
            </span>
            <h2
              id="error-analysis-modal-title"
              style={{ fontSize: "1.45rem", fontWeight: 800, margin: 0 }}
            >
              누가 어디서 왜 틀렸을까요?
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              minHeight: "44px",
              minWidth: "44px",
              padding: "0 16px",
              borderRadius: "12px",
              border: "2.5px solid #1e293b",
              backgroundColor: "#f1f5f9",
              color: "#1e293b",
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

        {/* 학년 선택 탭 */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {[1, 2, 3, 4, 6].map((g) => {
            const active = selectedGrade === g;
            return (
              <button
                key={g}
                type="button"
                onClick={() => handleGradeChange(g)}
                style={{
                  minHeight: "44px",
                  padding: "0 14px",
                  borderRadius: "12px",
                  border: "2.5px solid #1e293b",
                  backgroundColor: active ? "#38bdf8" : "#f8fafc",
                  color: "#0f172a",
                  fontWeight: 800,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                }}
              >
                {g}학년 오개념
              </button>
            );
          })}
        </div>

        {/* 가네 9수업사태 미니 루프 표시 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            padding: "10px 12px",
            borderRadius: "14px",
            backgroundColor: "#f8fafc",
            border: "2px solid #cbd5e1",
            fontSize: "0.75rem",
          }}
        >
          {GAGNE_NINE_EVENTS.map((ev) => (
            <span
              key={ev.id}
              style={{
                padding: "4px 8px",
                borderRadius: "8px",
                fontWeight: 700,
                backgroundColor:
                  ev.id === activeChallenge.gagneEventId ? "#dcfce7" : "#e2e8f0",
                color: "#0f172a",
                border:
                  ev.id === activeChallenge.gagneEventId
                    ? "1.5px solid #15803d"
                    : "1.5px solid transparent",
              }}
            >
              {ev.order}. {ev.titleKo}
            </span>
          ))}
        </div>

        {/* 캐릭터의 틀린 풀이 제시 카드 */}
        <div
          style={{
            padding: "16px",
            borderRadius: "16px",
            backgroundColor: "#fff7ed",
            border: "2.5px solid #1e293b",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              marginBottom: "8px",
            }}
          >
            <strong style={{ fontSize: "1.05rem" }}>
              {activeChallenge.characterAvatar} {activeChallenge.characterName}의
              풀이 ({activeChallenge.misconceptionTitleKo})
            </strong>
            <span
              style={{
                padding: "4px 10px",
                borderRadius: "999px",
                backgroundColor: "#fee2e2",
                color: "#991b1b",
                fontWeight: 800,
                fontSize: "0.8rem",
                border: "1.5px solid #991b1b",
              }}
            >
              {activeChallenge.characterName}의 답: {activeChallenge.characterWrongAnswer} (오답)
            </span>
          </div>
          <p style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "8px" }}>
            문제: {activeChallenge.questionPrompt}
          </p>
          <p style={{ fontSize: "0.85rem", color: "#475569", margin: 0 }}>
            💡 시각 힌트: {activeChallenge.visualHintSvgDesc}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          {/* 1단계: 틀린 풀이 단계 선택 */}
          <div>
            <h3 style={{ fontSize: "1rem", fontWeight: 800, marginBottom: "8px" }}>
              1️⃣ 어느 단계에서 처음 틀렸나요?
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {activeChallenge.steps.map((step) => {
                const chosen = selectedStep === step.stepNumber;
                return (
                  <button
                    key={step.stepNumber}
                    type="button"
                    onClick={() => setSelectedStep(step.stepNumber)}
                    style={{
                      minHeight: "48px",
                      padding: "12px 14px",
                      borderRadius: "12px",
                      border: "2.5px solid #1e293b",
                      backgroundColor: chosen ? "#fde047" : "#f8fafc",
                      color: "#0f172a",
                      textAlign: "left",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <span style={{ fontWeight: 800 }}>
                      [{step.stepNumber}단계] {step.expression}
                    </span>
                    <span style={{ fontSize: "0.85rem", color: "#334155" }}>
                      {step.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2단계: 틀린 이유 고르기 */}
          <div>
            <h3 style={{ fontSize: "1rem", fontWeight: 800, marginBottom: "8px" }}>
              2️⃣ 왜 틀렸는지 이유를 골라 보세요
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {activeChallenge.reasonOptions.map((opt) => {
                const chosen = selectedReasonId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setSelectedReasonId(opt.id)}
                    style={{
                      minHeight: "46px",
                      padding: "10px 14px",
                      borderRadius: "12px",
                      border: "2.5px solid #1e293b",
                      backgroundColor: chosen ? "#bae6fd" : "#f8fafc",
                      color: "#0f172a",
                      fontWeight: 700,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    {opt.text}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3단계: 바른 정답 직접 입력 */}
          <div>
            <label
              htmlFor="error-analysis-correct-input"
              style={{
                display: "block",
                fontSize: "1rem",
                fontWeight: 800,
                marginBottom: "8px",
              }}
            >
              3️⃣ 바르게 고친 정답을 적어 보세요
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
              <input
                id="error-analysis-correct-input"
                type="text"
                value={correctedAnswer}
                onChange={(e) => setCorrectedAnswer(e.target.value)}
                placeholder="바른 답 입력"
                style={{
                  flex: "1 1 180px",
                  minHeight: "48px",
                  padding: "0 14px",
                  borderRadius: "12px",
                  border: "2.5px solid #1e293b",
                  fontSize: "1.05rem",
                  fontWeight: 700,
                }}
              />
              <button
                type="submit"
                style={{
                  minHeight: "48px",
                  padding: "0 24px",
                  borderRadius: "12px",
                  border: "2.5px solid #1e293b",
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
                }}
              >
                교정 결과 확인하기 ✓
              </button>
            </div>
          </div>
        </form>

        {/* 평가 피드백 및 마스터리 배지 */}
        {evaluation && (
          <div
            style={{
              padding: "16px",
              borderRadius: "16px",
              border: "2.5px solid #1e293b",
              backgroundColor: evaluation.passed ? "#dcfce7" : "#fee2e2",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <p style={{ fontWeight: 800, margin: 0 }}>
              {evaluation.passed ? "🎉 완벽한 메타인지 교정 성공!" : "💡 다시 한번 점검해 볼까요?"}
            </p>
            <p style={{ margin: 0, fontSize: "0.95rem" }}>
              {evaluation.feedbackMessage}
            </p>
            {evaluation.masteryBadge && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "12px",
                  borderRadius: "12px",
                  backgroundColor: "#fde047",
                  border: "2.5px solid #1e293b",
                }}
              >
                <span style={{ fontWeight: 800 }}>
                  {evaluation.masteryBadge.icon} 획득 배지: {evaluation.masteryBadge.title} (전이 보너스 +{evaluation.transferBonusPoints}점)
                </span>
                <button
                  type="button"
                  onClick={handleNextChallenge}
                  style={{
                    minHeight: "44px",
                    padding: "0 16px",
                    borderRadius: "10px",
                    border: "2px solid #1e293b",
                    backgroundColor: "#ffffff",
                    fontWeight: 800,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    lineHeight: 1,
                  }}
                >
                  다음 오개념 도전 ▶
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ErrorAnalysisModal;
