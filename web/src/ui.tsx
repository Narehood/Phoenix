import type { FormEvent, ReactNode } from "react";
import { ApiError } from "./api";

export type ToneName = "good" | "bad" | "warn" | "neutral";

export const stamp = (n: number) =>
  n ? new Date(n).toLocaleString() : "Never";

export function toneOf(value: string): ToneName {
  return [
    "up",
    "connected",
    "fresh",
    "normal",
    "succeeded",
    "completed",
  ].includes(value)
    ? "good"
    : ["down", "failed", "revoked", "denied"].includes(value)
      ? "bad"
      : ["stale", "uncertain", "warning", "timed_out"].includes(value)
        ? "warn"
        : "neutral";
}

export function Tone({
  value,
  tone,
  label,
}: {
  value: string;
  tone?: ToneName;
  label?: string;
}) {
  return (
    <span className={`chip ${tone || toneOf(value)}`}>
      <span aria-hidden="true">●</span> {label ?? value.replaceAll("_", " ")}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function Form({
  children,
  onSubmit,
  submit = "Save",
  busy = false,
  disabled = false,
}: {
  children: ReactNode;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  submit?: string;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="form">
      {children}
      <button className="primary" disabled={busy || disabled}>
        {busy ? "Working…" : submit}
      </button>
    </form>
  );
}

export function field(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return new FormData(e.currentTarget);
}

/** The server requires password + MFA within five minutes for this mutation. */
export function needsRecentAuth(e: unknown) {
  return e instanceof ApiError && e.status === 403 && /recent/i.test(e.message);
}

/** A scoped error banner. Recent-authentication failures offer the existing
 *  identity verification workflow instead of discarding unsaved input. */
export function ErrorNotice({
  error,
  onDismiss,
  onVerify,
}: {
  error: unknown;
  onDismiss: () => void;
  onVerify?: () => void;
}) {
  if (!error) return null;
  const recent = needsRecentAuth(error);
  return (
    <div className="notice error" role="alert">
      <span>
        {error instanceof Error ? error.message : String(error)}
        {recent &&
          " — verify your password and authenticator code, then try again. Your unsaved input is kept."}
      </span>
      <span className="button-row">
        {recent && onVerify && (
          <button type="button" onClick={onVerify}>
            Verify identity
          </button>
        )}
        <button type="button" onClick={onDismiss} aria-label="Dismiss error">
          ×
        </button>
      </span>
    </div>
  );
}
