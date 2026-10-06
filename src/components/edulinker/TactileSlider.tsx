import * as React from "react";

export interface TactileSliderProps {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  strokeColor?: string;
  showMorphingPreview?: boolean;
  springStiffness?: number;
  springDamping?: number;
  className?: string;
  disabled?: boolean;
}

/**
 * TactileSlider
 * 
 * Physics-based tactile slider for smartpen stroke width / opacity adjustment.
 * Features:
 * - Emil Kowalski style spring elasticity (stiffness: 400, damping: 28, scale: 0.94)
 * - Real-time pen tip morphing preview dot
 * - Touch targets >= 44x44px (Theorem 3)
 * - Button centering: inline-flex items-center justify-center leading-none
 * - Symmetric borders (Anti-Cuticle design)
 */
export const TactileSlider: React.FC<TactileSliderProps> = ({
  label = "획 두께",
  value,
  onChange,
  min = 1,
  max = 32,
  step = 1,
  unit = "px",
  strokeColor = "#ffffff",
  showMorphingPreview = true,
  springStiffness = 400,
  springDamping = 28,
  className = "",
  disabled = false,
}) => {
  const [isInteracting, setIsInteracting] = React.useState(false);
  const trackRef = React.useRef<HTMLDivElement>(null);

  const percentage = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  const triggerHaptic = () => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(5);
    }
  };

  const handleStep = (delta: number) => {
    if (disabled) return;
    const next = Math.min(max, Math.max(min, Number((value + delta * step).toFixed(2))));
    if (next !== value) {
      triggerHaptic();
      onChange(next);
    }
  };

  const updateFromPointer = (clientX: number) => {
    if (!trackRef.current || disabled) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const rawVal = min + ratio * (max - min);
    const stepsCount = Math.round((rawVal - min) / step);
    const newVal = Math.min(max, Math.max(min, Number((min + stepsCount * step).toFixed(2))));
    if (newVal !== value) {
      triggerHaptic();
      onChange(newVal);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    setIsInteracting(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    updateFromPointer(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteracting || disabled) return;
    updateFromPointer(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsInteracting(false);
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // Ignored if pointer capture was already released
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      handleStep(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      handleStep(1);
    }
  };

  // Preview morphing diameter in pixels (clamped between 6px and 36px)
  const previewDiameter = Math.min(36, Math.max(6, (value / max) * 36));

  return (
    <div
      className={`
        w-full max-w-full select-none
        flex flex-col gap-2 p-3
        rounded-2xl bg-slate-900/60 backdrop-blur-md
        border border-white/10
        ${className}
      `}
      data-spring-stiffness={springStiffness}
      data-spring-damping={springDamping}
    >
      {/* Top Header: Label & Value & Morphing Preview */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-300">
        <span className="flex items-center gap-1.5">
          <span>{label}</span>
          <span className="inline-flex items-center justify-center leading-none px-2 py-0.5 rounded-full bg-white/10 text-white border border-white/15 text-[11px] font-mono">
            {value}{unit}
          </span>
        </span>

        {showMorphingPreview && (
          <div
            className="flex items-center justify-center w-9 h-9 rounded-full bg-slate-800/80 border border-white/15 overflow-hidden"
            title="실시간 펜촉 크기 모핑 프리뷰"
          >
            <div
              style={{
                width: `${previewDiameter}px`,
                height: `${previewDiameter}px`,
                backgroundColor: strokeColor,
                transform: `scale(${isInteracting ? 0.94 : 1.0})`,
                transition: "all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)",
              }}
              className="rounded-full shadow-sm"
            />
          </div>
        )}
      </div>

      {/* Interactive Row: Decrement, Track, Increment */}
      <div className="flex flex-wrap items-center gap-2 w-full">
        {/* Decrement Button */}
        <button
          type="button"
          disabled={disabled || value <= min}
          onClick={() => handleStep(-1)}
          className="
            min-w-[44px] min-h-[44px] h-[44px] px-3
            border border-white/15 rounded-xl
            bg-white/10 text-white/90 hover:bg-white/20
            inline-flex items-center justify-center leading-none
            text-base font-bold
            active:scale-95 transition-all
            disabled:opacity-30 disabled:cursor-not-allowed
          "
          aria-label={`${label} 감소`}
        >
          −
        </button>

        {/* Tactile Slider Track */}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-label={label}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          className={`
            relative flex-1 min-w-[120px] h-[44px]
            flex items-center cursor-pointer outline-none touch-none
            ${disabled ? "opacity-40 cursor-not-allowed" : ""}
          `}
        >
          {/* Track Bar Background */}
          <div className="w-full h-3 rounded-full bg-slate-800 border border-white/10 overflow-hidden relative">
            <div
              style={{ width: `${percentage}%` }}
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-75"
            />
          </div>

          {/* Tactile Thumb Handle */}
          <div
            style={{
              left: `calc(${percentage}% - 14px)`,
              transform: `scale(${isInteracting ? 0.94 : 1.0})`,
              transition: isInteracting ? "none" : "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
            className="
              absolute top-1/2 -translate-y-1/2
              w-7 h-7 rounded-full
              bg-white border-2 border-indigo-600
              shadow-[0_2px_8px_rgba(0,0,0,0.4)]
              flex items-center justify-center
            "
          >
            <div className="w-2 h-2 rounded-full bg-indigo-600" />
          </div>
        </div>

        {/* Increment Button */}
        <button
          type="button"
          disabled={disabled || value >= max}
          onClick={() => handleStep(1)}
          className="
            min-w-[44px] min-h-[44px] h-[44px] px-3
            border border-white/15 rounded-xl
            bg-white/10 text-white/90 hover:bg-white/20
            inline-flex items-center justify-center leading-none
            text-base font-bold
            active:scale-95 transition-all
            disabled:opacity-30 disabled:cursor-not-allowed
          "
          aria-label={`${label} 증가`}
        >
          +
        </button>
      </div>
    </div>
  );
};
