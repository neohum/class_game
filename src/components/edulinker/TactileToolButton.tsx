import * as React from "react";

export interface TactileToolButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  variant?: "glass" | "solid" | "ghost" | "neobrutal";
  icon?: React.ReactNode;
  badge?: string | number;
  label?: string;
  springStiffness?: number;
  springDamping?: number;
}

/**
 * TactileToolButton
 * 
 * Emil Kowalski-inspired tactile micro-interaction button for smartpen canvas tools.
 * Physics parameters: stiffness 400, damping 28, scale tension 0.94.
 * Conforms to:
 * - Touch Target >= 44x44px (Theorem 3)
 * - Perfect Centering: inline-flex items-center justify-center leading-none
 * - Symmetric Borders: Anti-Fingernail / Cuticle rule
 */
export const TactileToolButton: React.FC<TactileToolButtonProps> = ({
  active = false,
  variant = "glass",
  icon,
  badge,
  label,
  children,
  onClick,
  className = "",
  springStiffness = 400,
  springDamping = 28,
  disabled = false,
  ...rest
}) => {
  const [isPressed, setIsPressed] = React.useState(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    setIsPressed(true);
    // Haptic feedback trigger for supported mobile/pen devices
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(6);
    }
    rest.onPointerDown?.(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    setIsPressed(false);
    rest.onPointerUp?.(e);
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    setIsPressed(false);
    rest.onPointerLeave?.(e);
  };

  // Base styling per variant
  const variantStyles = {
    glass: active
      ? "bg-white/25 text-white border-white/40 shadow-inner"
      : "bg-white/10 text-white/90 border-white/15 hover:bg-white/20 hover:text-white",
    solid: active
      ? "bg-blue-600 text-white border-blue-500 shadow-md"
      : "bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700 hover:text-white",
    ghost: active
      ? "bg-white/20 text-white border-white/20"
      : "bg-transparent text-slate-300 border-transparent hover:bg-white/10 hover:text-white",
    neobrutal: active
      ? "bg-amber-300 text-zinc-900 border-zinc-900 shadow-[2px_2px_0px_#09090b]"
      : "bg-white text-zinc-900 border-zinc-900 shadow-[3px_3px_0px_#09090b] hover:bg-zinc-50",
  };

  const scaleValue = isPressed ? 0.94 : 1.0;

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onClick={onClick}
      style={{
        transform: `scale(${scaleValue})`,
        transition: `transform ${isPressed ? "0.06s" : "0.28s"} cubic-bezier(0.34, 1.56, 0.64, 1)`,
      }}
      className={`
        relative select-none outline-none
        min-w-[44px] min-h-[44px] h-[44px] px-3
        border rounded-xl
        inline-flex items-center justify-center leading-none gap-2
        text-sm font-medium transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed
        ${variantStyles[variant]}
        ${className}
      `}
      aria-pressed={active}
      aria-label={label || (typeof children === "string" ? children : undefined)}
      data-spring-stiffness={springStiffness}
      data-spring-damping={springDamping}
      {...rest}
    >
      {icon && (
        <span className="inline-flex items-center justify-center leading-none w-5 h-5 flex-shrink-0">
          {icon}
        </span>
      )}
      {children && (
        <span className="inline-flex items-center justify-center leading-none text-center">
          {children}
        </span>
      )}
      {badge !== undefined && (
        <span className="inline-flex items-center justify-center leading-none px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-500 text-white border border-white/20">
          {badge}
        </span>
      )}
    </button>
  );
};
