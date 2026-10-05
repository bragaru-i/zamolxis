import {
  type ButtonHTMLAttributes,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export { KeyValueList, SegmentedControl, Stat, StatGrid, TextInput } from "./data";
export type { Block as MarkdownBlock, Inline as MarkdownInline } from "./markdown";
export { Markdown, parseInline, parseMarkdown, safeHref } from "./markdown";
export { Disclosure, Facts, Timeline, TimelineItem } from "./timeline";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function ProductMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={size === "lg" ? "z-mark z-mark--lg" : "z-mark"} title="Zamolxis">
      Z
    </span>
  );
}

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "small";
  block?: boolean;
}) {
  const classes = ["z-button", `z-button--${variant}`];
  if (size === "small") classes.push("z-button--small");
  if (block) classes.push("z-button--block");
  if (className) classes.push(className);
  return <button type={type} className={classes.join(" ")} {...props} />;
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  planning: { tone: "info", label: "Planning" },
  planned: { tone: "neutral", label: "Planned" },
  queued: { tone: "neutral", label: "Queued" },
  blocked: { tone: "neutral", label: "Waiting on other work" },
  ready: { tone: "neutral", label: "Ready" },
  starting: { tone: "info", label: "Starting" },
  building: { tone: "info", label: "Building" },
  running: { tone: "info", label: "Running" },
  verifying: { tone: "info", label: "Verifying" },
  repairing: { tone: "warning", label: "Repairing" },
  integrating: { tone: "info", label: "Integrating" },
  waiting: { tone: "warning", label: "Waiting" },
  needs_input: { tone: "warning", label: "Needs you" },
  needs_approval: { tone: "warning", label: "Needs approval" },
  stopping: { tone: "warning", label: "Stopping" },
  completed: { tone: "success", label: "Done" },
  trusted: { tone: "success", label: "Trusted" },
  untrusted: { tone: "danger", label: "Not trusted" },
  failed: { tone: "danger", label: "Failed" },
  lost: { tone: "danger", label: "Lost" },
  stopped: { tone: "neutral", label: "Stopped" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export function statusLabel(status: string): { tone: Tone; label: string } {
  return (
    STATUS[status] ?? {
      tone: "neutral",
      label: status.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase()),
    }
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const resolved = statusLabel(status);
  return <span className={`z-badge z-tone-${resolved.tone}`}>{label ?? resolved.label}</span>;
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p className={`z-notice z-tone-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function AppShell({
  header,
  footer,
  centered = false,
  children,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  centered?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="z-app">
      {header}
      <main className={centered ? "z-main z-centered" : "z-main"}>{children}</main>
      {footer && <div className="z-footer">{footer}</div>}
    </div>
  );
}

export function AppHeader({
  leading,
  title,
  subtitle,
  trailing,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="z-header">
      {leading}
      <div className="z-header__titles">
        <h1 className="z-header__title">{title}</h1>
        {subtitle && <div className="z-header__subtitle">{subtitle}</div>}
      </div>
      {trailing}
    </header>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section className="z-card z-stack" aria-label={label}>
      {children}
    </section>
  );
}

export function ConnectionIndicator({
  state,
  label,
}: {
  state: "online" | "offline" | "none";
  label: string;
}) {
  return (
    <span className={`z-connection z-connection--${state}`}>
      <span className="z-connection__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Message({
  author,
  label,
  meta,
  children,
}: {
  author: "user" | "assistant";
  label: string;
  /** Small secondary line under the bubble, e.g. token usage. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className={`z-message z-message--${author}`}>
      <span className="z-message__author">{label}</span>
      <div className="z-message__body">{children}</div>
      {meta && <span className="z-message__meta">{meta}</span>}
    </article>
  );
}

/** Live "working on it" state for a reply that has not arrived yet. */
export function Thinking({ label = "Thinking…", detail }: { label?: string; detail?: ReactNode }) {
  return (
    <span className="z-thinking" role="status">
      <span className="z-thinking__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="z-thinking__text">
        <span className="z-thinking__label">{label}</span>
        {detail && <span className="z-thinking__detail">{detail}</span>}
      </span>
    </span>
  );
}

/** Clamps long content to a few lines with an accessible Show more / Show less toggle. */
export function Collapsible({
  children,
  likelyLong = false,
  moreLabel = "Show more",
  lessLabel = "Show less",
}: {
  children: ReactNode;
  /** Initial guess before layout is measured (also used for server rendering). */
  likelyLong?: boolean;
  moreLabel?: string;
  lessLabel?: string;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(likelyLong);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the content changes.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, children]);
  const clamped = overflowing && !expanded;
  return (
    <div className="z-collapsible">
      <div
        id={id}
        ref={body}
        className={
          expanded ? "z-collapsible__body" : "z-collapsible__body z-collapsible__body--clamped"
        }
        data-faded={clamped ? "true" : undefined}
      >
        {children}
      </div>
      {(overflowing || expanded) && (
        <Button
          variant="ghost"
          size="small"
          className="z-collapsible__toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? lessLabel : moreLabel}
        </Button>
      )}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  busy = false,
  disabled = false,
  hint,
  above,
  submitLabel = "Send",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  above?: ReactNode;
  submitLabel?: string;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  // Grow with content up to the CSS max-height; the page keeps the composer pinned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: height follows the value.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  const canSend = !busy && !disabled && value.trim().length > 0;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) onSubmit();
  };
  return (
    <form className="z-composer" onSubmit={submit}>
      {above}
      <div className="z-composer__box">
        <textarea
          ref={field}
          className="z-textarea"
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          maxLength={16000}
          rows={1}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <Button type="submit" disabled={!canSend}>
          {busy ? "Sending…" : submitLabel}
        </Button>
      </div>
      {hint && <p className="z-composer__hint">{hint}</p>}
    </form>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="z-sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="z-sheet__head">
        <h2 className="z-header__title">{title}</h2>
        <span className="z-spacer" />
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
      <div className="z-sheet__body">{children}</div>
    </dialog>
  );
}
