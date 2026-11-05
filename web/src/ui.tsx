import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError } from "./api";

export type ToneName = "good" | "bad" | "warn" | "neutral";

export const stamp = (n: number) =>
  n ? new Date(n).toLocaleString() : "Never";

/** Evidence can age while a network request is pending or a tab is suspended. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return now;
}

export function Time({ value }: { value: number }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  if (!value) return <span>Never</span>;
  const elapsed = Math.max(0, Math.floor((Date.now() - value) / 1000));
  const label =
    elapsed < 60
      ? "Just now"
      : elapsed < 3600
        ? `${Math.floor(elapsed / 60)}m ago`
        : elapsed < 86400
          ? `${Math.floor(elapsed / 3600)}h ago`
          : new Date(value).toLocaleDateString();
  return (
    <span className="timestamp">
      <button
        type="button"
        className="time-trigger"
        aria-expanded={expanded}
        aria-controls={id}
        title="Exact date and time"
        aria-label={`${expanded ? "Hide" : "Show"} exact time: ${label}`}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setExpanded(false);
        }}
      >
        <time dateTime={new Date(value).toISOString()}>{label}</time>
        <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      <span id={id} className="time-exact" hidden={!expanded}>
        {new Date(value).toLocaleString(undefined, { timeZoneName: "short" })}
      </span>
    </span>
  );
}

/** Summary information starts collapsed on small screens without losing fields. */
export function ResponsiveDetails({
  children,
  label,
  className = "",
}: {
  children: ReactNode;
  label: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(
    () => matchMedia("(min-width: 721px)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(min-width: 721px)");
    const changed = () => setOpen(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return (
    <details
      className={`responsive-details ${className}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      {children}
    </details>
  );
}

/** Native modal semantics provide focus containment and an inert background. */
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    (
      dialog.querySelector<HTMLElement>("input:not([disabled]), textarea") ||
      dialog.querySelector<HTMLElement>("h2") ||
      dialog
    ).focus();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal panel${wide ? " wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <button
        type="button"
        className="close"
        aria-label="Close dialog"
        onClick={onClose}
        disabled={busy}
      >
        ×
      </button>
      <h2 id={titleId} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </dialog>
  );
}

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
  mobilePrefix,
}: {
  value: string;
  tone?: ToneName;
  label?: string;
  mobilePrefix?: string;
}) {
  const text = label ?? value.replaceAll("_", " ");
  return (
    <span className={`chip ${tone || toneOf(value)}`}>
      <span aria-hidden="true">●</span>{" "}
      {mobilePrefix && (
        <span className="mobile-tone-prefix" aria-hidden="true">
          {mobilePrefix}:{" "}
        </span>
      )}
      {text.charAt(0).toUpperCase() + text.slice(1)}
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
  retained = false,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  retained?: boolean;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      {retained && <small className="retained-label">Last known</small>}
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

/** The region stays mounted so asynchronous confirmation text is announced. */
export function StatusNotice({ children }: { children: ReactNode }) {
  return (
    <div className="status-notice" role="status" aria-atomic="true">
      {children && <div className="notice">{children}</div>}
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
    <div className="notice error error-notice" role="alert">
      <span>
        {recent
          ? "A recent password and MFA verification is required. Verify your identity, then try again. Your unsaved input is kept."
          : error instanceof Error
            ? error.message
            : String(error)}
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
