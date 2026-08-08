import { cloneElement, forwardRef, isValidElement, useId } from "react";
import { cn } from "./cn";

// Shared control chrome: sunken well, divider hairline, accent focus ring
// (soft, no hard glow) per the mockup's `.field`. Used by Input/Select/Textarea.
const fieldClass =
  "w-full bg-sunken border border-divider rounded-control text-ink font-sans text-sm placeholder:text-ink-hush transition-[border-color,box-shadow] duration-150 ease-out focus:outline-none focus:border-accent/60 focus:ring-[3px] focus:ring-accent/20 disabled:opacity-50";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cn(fieldClass, "px-3 py-2", className)} {...rest} />;
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldClass, "px-3 py-2 resize-y", className)} {...rest} />;
});

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  // Extra right padding so the native caret has room (mirrors `select.field`).
  return (
    <select ref={ref} className={cn(fieldClass, "pl-3 pr-7 py-2", className)} {...rest}>
      {children}
    </select>
  );
});

export type FieldProps = {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>;
};

/**
 * Wraps a control with a label, optional hint, and optional error. Generates an
 * id and wires `htmlFor` / `aria-describedby` so the label and messages are
 * associated for assistive tech. The error, when present, is announced.
 */
export function Field({ label, hint, error, htmlFor, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? children.props.id ?? generatedId;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control = {
    id: controlId,
    "aria-describedby": describedBy,
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={controlId} className="font-sans text-xs font-medium text-ink-mute">
          {label}
        </label>
      )}
      {/* Clone the control to inject id / aria without the consumer wiring it. */}
      {isValidElement(children) ? cloneElement(children, control) : children}
      {hint && !error && (
        <p id={hintId} className="font-sans text-[11px] text-ink-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="font-sans text-[11px] text-fail">
          {error}
        </p>
      )}
    </div>
  );
}
