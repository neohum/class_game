import * as React from "react";
import { TactileToolButton } from "./TactileToolButton.js";
import { TactileSlider } from "./TactileSlider.js";

export type DrawingTool = "pen" | "highlighter" | "eraser" | "lasso";
export type CanvasBackground = "white" | "grid" | "chalkboard";

export interface LiquidGlassToolbarProps {
  activeTool?: DrawingTool;
  onSelectTool?: (tool: DrawingTool) => void;
  strokeWidth?: number;
  onChangeStrokeWidth?: (width: number) => void;
  color?: string;
  onChangeColor?: (color: string) => void;
  canvasBackground?: CanvasBackground;
  onChangeCanvasBackground?: (bg: CanvasBackground) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onClear?: () => void;
  className?: string;
}

const COLOR_PALETTE = [
  { name: "딥 블랙", value: "#0f172a" },
  { name: "잉크 블루", value: "#2563eb" },
  { name: "스칼렛 레드", value: "#dc2626" },
  { name: "칠판 그린", value: "#16a34a" },
  { name: "형광 옐로우", value: "#eab308" },
  { name: "퓨어 화이트", value: "#ffffff" },
];

/**
 * LiquidGlassToolbar
 * 
 * Floating liquid glassmorphism toolbar for the edulinker smartpen canvas.
 * Conforms to:
 * - backdrop-filter: blur(20px) saturate(180%)
 * - Symmetric highlight border: 1px solid rgba(255,255,255,0.18)
 * - Minimum touch target >= 44x44px for all interactive buttons (Theorem 3)
 * - Button & badge centering: inline-flex items-center justify-center leading-none
 * - Dynamic canvas background detection for guaranteed 4.5:1 text contrast
 * - All flex groups wrap automatically (Theorem 1 & 2)
 */
export const LiquidGlassToolbar: React.FC<LiquidGlassToolbarProps> = ({
  activeTool = "pen",
  onSelectTool,
  strokeWidth = 3,
  onChangeStrokeWidth,
  color = "#2563eb",
  onChangeColor,
  canvasBackground = "white",
  onChangeCanvasBackground,
  canUndo = true,
  canRedo = false,
  onUndo,
  onRedo,
  onClear,
  className = "",
}) => {
  const [showSlider, setShowSlider] = React.useState(false);

  // Dynamic background styling according to canvas background to ensure >= 4.5:1 contrast
  const toolbarBgColor =
    canvasBackground === "chalkboard"
      ? "rgba(15, 23, 42, 0.85)"
      : canvasBackground === "grid"
      ? "rgba(15, 23, 42, 0.78)"
      : "rgba(15, 23, 42, 0.75)";

  return (
    <div className={`w-full max-w-full flex flex-col items-center gap-2 p-2 select-none ${className}`}>
      {/* Floating Main Glass Capsule */}
      <div
        role="toolbar"
        aria-label="스마트펜 판서 도구 모음"
        style={{
          backgroundColor: toolbarBgColor,
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          border: "1px solid rgba(255, 255, 255, 0.18)",
          boxShadow: "0 10px 30px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
        }}
        className="
          w-full max-w-full
          flex flex-wrap items-center justify-between gap-3
          p-2.5 rounded-2xl md:rounded-full
          text-slate-100 transition-all duration-200
        "
      >
        {/* Group 1: Drawing Tools (Pen, Highlighter, Lasso, Eraser) */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="그리기 도구">
          {/* Pen Button */}
          <TactileToolButton
            active={activeTool === "pen"}
            onClick={() => onSelectTool?.("pen")}
            label="스마트펜"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
            }
          >
            펜
          </TactileToolButton>

          {/* Highlighter Button */}
          <TactileToolButton
            active={activeTool === "highlighter"}
            onClick={() => onSelectTool?.("highlighter")}
            label="형광펜"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 11-6 6v3h3l6-6" />
                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
              </svg>
            }
          >
            형광펜
          </TactileToolButton>

          {/* Lasso Button */}
          <TactileToolButton
            active={activeTool === "lasso"}
            onClick={() => onSelectTool?.("lasso")}
            label="올가미 선택"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 22a5 5 0 0 1-2-4" />
                <path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1" />
                <path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
              </svg>
            }
          >
            올가미
          </TactileToolButton>

          {/* Eraser Button */}
          <TactileToolButton
            active={activeTool === "eraser"}
            onClick={() => onSelectTool?.("eraser")}
            label="지우개"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                <path d="M22 21H7" />
                <path d="m5 11 9 9" />
              </svg>
            }
          >
            지우개
          </TactileToolButton>
        </div>

        {/* Divider */}
        <div className="hidden sm:block w-[1px] h-6 bg-white/20" />

        {/* Group 2: Color Palette Swatches */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="색상 선택">
          {COLOR_PALETTE.map((c) => {
            const isSelected = color.toLowerCase() === c.value.toLowerCase();
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => onChangeColor?.(c.value)}
                title={c.name}
                aria-label={`색상: ${c.name}`}
                aria-pressed={isSelected}
                className={`
                  min-w-[44px] min-h-[44px] h-[44px] w-[44px]
                  rounded-full border transition-all duration-150
                  inline-flex items-center justify-center leading-none
                  ${
                    isSelected
                      ? "border-white scale-110 shadow-[0_0_10px_rgba(255,255,255,0.6)]"
                      : "border-white/20 hover:scale-105 hover:border-white/50"
                  }
                `}
              >
                <span
                  style={{ backgroundColor: c.value }}
                  className="w-5 h-5 rounded-full border border-black/20 shadow-sm"
                />
              </button>
            );
          })}

          {/* Stroke Width Toggle Button */}
          <button
            type="button"
            onClick={() => setShowSlider(!showSlider)}
            aria-label="펜 굵기 조절 패널 토글"
            aria-expanded={showSlider}
            className={`
              min-w-[44px] min-h-[44px] h-[44px] px-3
              rounded-xl border transition-all
              inline-flex items-center justify-center leading-none gap-2
              text-xs font-semibold
              ${
                showSlider
                  ? "bg-white/25 text-white border-white/40"
                  : "bg-white/10 text-white/90 border-white/15 hover:bg-white/20"
              }
            `}
          >
            <span
              style={{ width: `${Math.min(18, Math.max(4, strokeWidth * 2))}px`, height: `${Math.min(18, Math.max(4, strokeWidth * 2))}px`, backgroundColor: color }}
              className="rounded-full border border-white/40 inline-flex items-center justify-center leading-none"
            />
            <span>{strokeWidth}px</span>
          </button>
        </div>

        {/* Divider */}
        <div className="hidden sm:block w-[1px] h-6 bg-white/20" />

        {/* Group 3: History & Background Actions */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="작업 제어">
          {/* Undo */}
          <TactileToolButton
            disabled={!canUndo}
            onClick={onUndo}
            label="실행 취소"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            }
          />

          {/* Redo */}
          <TactileToolButton
            disabled={!canRedo}
            onClick={onRedo}
            label="다시 실행"
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
              </svg>
            }
          />

          {/* Canvas Background Cycle */}
          <button
            type="button"
            onClick={() => {
              const order: CanvasBackground[] = ["white", "grid", "chalkboard"];
              const nextIdx = (order.indexOf(canvasBackground) + 1) % order.length;
              const nextBg = order[nextIdx] ?? "white";
              onChangeCanvasBackground?.(nextBg);
            }}
            title="캔버스 배경 전환 (화이트 / 모눈 / 칠판)"
            aria-label={`현재 배경: ${canvasBackground}. 클릭 시 전환`}
            className="
              min-w-[44px] min-h-[44px] h-[44px] px-3
              rounded-xl border border-white/15
              bg-white/10 hover:bg-white/20 text-white
              inline-flex items-center justify-center leading-none gap-1.5
              text-xs font-medium
            "
          >
            <span className="inline-flex items-center justify-center leading-none">
              {canvasBackground === "white" ? "⬜ 화이트" : canvasBackground === "grid" ? "▦ 모눈" : "🟩 칠판"}
            </span>
          </button>

          {/* Clear Button */}
          {onClear && (
            <TactileToolButton
              onClick={onClear}
              label="전체 지우기"
              className="text-red-300 hover:text-red-100 hover:bg-red-500/20"
              icon={
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              }
            />
          )}
        </div>
      </div>

      {/* Expandable Tactile Stroke Width / Opacity Slider */}
      {showSlider && (
        <div className="w-full max-w-md animate-fadeIn">
          <TactileSlider
            label="스마트펜 획 두께"
            value={strokeWidth}
            onChange={(val) => onChangeStrokeWidth?.(val)}
            min={1}
            max={24}
            step={1}
            strokeColor={color}
            showMorphingPreview={true}
          />
        </div>
      )}
    </div>
  );
};
