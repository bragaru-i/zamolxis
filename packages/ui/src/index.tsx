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

export { AgentRow, compactCount, costLabel, elapsed } from "./agent";
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

// A Session's status in owner words: "waiting" means nothing is running and Zamolxis is
// waiting for the owner's next message, which is not a warning.
const SESSION_STATUS: Record<string, { tone: Tone; label: string }> = {
  planning: { tone: "info", label: "Thinking" },
  running: { tone: "info", label: "Working" },
  waiting: { tone: "neutral", label: "Idle" },
  needs_input: { tone: "warning", label: "Needs you" },
  completed: { tone: "success", label: "Done" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Stopped" },
};
export function sessionStatusLabel(status: string): { tone: Tone; label: string } {
  return SESSION_STATUS[status] ?? statusLabel(status);
}
export function SessionStatusBadge({ status }: { status: string }) {
  const resolved = sessionStatusLabel(status);
  return <span className={`z-badge z-tone-${resolved.tone}`}>{resolved.label}</span>;
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

const ICON_PATHS: Record<string, ReactNode> = {
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  back: <path d="M12.5 4l-6 6 6 6" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  settings: (
    <>
      <path d="M3 5.5h8M15 5.5h2M3 14.5h2M9 14.5h8" />
      <circle cx="13" cy="5.5" r="2" />
      <circle cx="7" cy="14.5" r="2" />
    </>
  ),
};
export type IconName = "menu" | "back" | "close" | "settings";

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="z-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** A square, touch-sized button showing only an icon; `label` names it for screen readers. */
export function IconButton({
  icon,
  label,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`z-icon-button${className ? ` ${className}` : ""}`}
      {...props}
    >
      <Icon name={icon} />
    </button>
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

/** True on wide screens (≥720px) after mount; false during server rendering. */
export function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = matchMedia("(min-width: 720px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/**
 * A modal surface: a centered dialog on wide screens, a bottom drawer with a grab handle on
 * phones. Closes on the backdrop, the close button and Escape.
 */
export function Sheet({
  open,
  title,
  description,
  size = "md",
  onClose,
  onBack,
  backLabel = "Back",
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Shows a back button before the title, for sheets with pages of their own. */
  onBack?: () => void;
  backLabel?: string;
  /** md fits a form or a list; lg is for long content such as Run detail; xl has two columns. */
  size?: "md" | "lg" | "xl";
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`z-sheet z-sheet--${size}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="z-sheet__head">
        {onBack && (
          <button
            type="button"
            className="z-sheet__back"
            aria-label={`Back to ${backLabel}`}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <div className="z-sheet__titles">
          <h2 className="z-sheet__title" id={titleId}>
            {title}
          </h2>
          {description && <p className="z-sheet__description">{description}</p>}
        </div>
        <button type="button" className="z-sheet__close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="z-sheet__body">{children}</div>
    </dialog>
  );
}

export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

function CheckIcon() {
  return (
    <svg className="z-picker__check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * A select control that looks the same on every platform: a field-styled trigger that opens a
 * popover list under it on wide screens and a bottom drawer on phones, never the native wheel.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled = false,
  hideLabel = false,
}: {
  label: string;
  value: string;
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  // The label still names the control and its list for assistive technology.
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wide = useWide();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const popover = open && wide;
  // The popover closes on an outside press or Escape; the drawer handles its own.
  useEffect(() => {
    if (!popover) return;
    const onPress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [popover]);
  useEffect(() => {
    if (!popover) return;
    const list = root.current?.querySelector<HTMLElement>(".z-popover");
    (
      list?.querySelector<HTMLElement>('[aria-selected="true"]') ??
      list?.querySelector<HTMLElement>('[role="option"]')
    )?.focus();
  }, [popover]);
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    if (wide) trigger.current?.focus();
  };
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  };
  const list = (
    <div
      className="z-picker__list"
      role="listbox"
      id={listId}
      aria-label={label}
      onKeyDown={moveFocus}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={active}
            className={active ? "z-picker__option z-picker__option--active" : "z-picker__option"}
            onClick={() => choose(option.value)}
          >
            <span className="z-picker__text">
              <span className="z-picker__label">{option.label}</span>
              {option.description && (
                <span className="z-picker__description">{option.description}</span>
              )}
            </span>
            {active && <CheckIcon />}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="z-field z-field--picker" ref={root}>
      {!hideLabel && <span>{label}</span>}
      <button
        ref={trigger}
        type="button"
        className="z-picker"
        aria-haspopup="listbox"
        aria-expanded={popover}
        aria-controls={popover ? listId : undefined}
        aria-label={hideLabel ? `${label}: ${selected?.label ?? placeholder}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selected ? "z-picker__value" : "z-picker__value z-muted"}>
          {selected?.label ?? placeholder}
        </span>
        <svg className="z-picker__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {popover && <div className="z-popover">{list}</div>}
      <Sheet open={open && !wide} title={label} onClose={() => setOpen(false)}>
        {list}
      </Sheet>
    </div>
  );
}

/**
 * A tappable reference inside a message (a Session, a Run, a pull request) with its status.
 * Unlike a Button its label wraps, so a long title never widens the page.
 */
export function Chip({
  label,
  status,
  href,
  onClick,
}: {
  label: string;
  status?: string | undefined;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="z-chip__label">{label}</span>
      {status && <span className="z-chip__status">{status}</span>}
    </>
  );
  if (href)
    return (
      <a className="z-chip" href={href} target="_blank" rel="noopener noreferrer">
        {body}
        <span className="z-chip__external" aria-hidden="true">
          ↗
        </span>
      </a>
    );
  return (
    <button type="button" className="z-chip" onClick={onClick}>
      {body}
    </button>
  );
}
