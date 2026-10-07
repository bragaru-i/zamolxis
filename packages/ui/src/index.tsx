import {
  type ButtonHTMLAttributes,
  Children,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { compactPath, crownPath, facePath } from "./product-mark";
import { useScrollLock } from "./scroll-lock";

export { AgentRow, compactCount, costLabel, elapsed } from "./agent";
export { KeyValueList, SegmentedControl, Stat, StatGrid, TextInput } from "./data";
export type { Block as MarkdownBlock, Inline as MarkdownInline } from "./markdown";
export { Markdown, parseInline, parseMarkdown, safeHref } from "./markdown";
export { useScrollLock } from "./scroll-lock";
export { Disclosure, Facts, Timeline, TimelineItem } from "./timeline";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export function ProductMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={size === "lg" ? "z-mark z-mark--lg" : "z-mark"} title="Zamolxis">
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        {size === "lg" ? (
          <>
            <path d={crownPath} fill="currentColor" />
            <path d={facePath} fill="currentColor" fillRule="evenodd" />
          </>
        ) : (
          <path d={compactPath} fill="currentColor" fillRule="evenodd" />
        )}
      </svg>
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

/**
 * A fixed stack of notices that need attention wherever the owner is (an approval that
 * arrives while they are in Settings or another chat). It is a manual popover, so it sits
 * in the top layer above any sheet that was already open; nothing in it closes by itself.
 */
export function ToastStack({
  label = "Notifications",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children).filter(Boolean);
  if (!items.length) return null;
  return <ToastRegion label={label}>{items}</ToastRegion>;
}
function ToastRegion({ label, children }: { label: string; children: ReactNode }) {
  // A modal sheet makes everything outside it inert, so the stack is rendered inside the
  // topmost open sheet while one is open (as its descendant it stays clickable) and in the
  // page otherwise. Server rendering (and static tests) keep it inline.
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    const update = () => {
      const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      setHost(open.length ? (open[open.length - 1] as HTMLElement) : document.body);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);
  const inSheet = typeof document !== "undefined" && !!host && host !== document.body;
  const region = (
    <ToastPopover key={inSheet ? "sheet" : "page"} label={label}>
      {children}
    </ToastPopover>
  );
  if (typeof document === "undefined") return region;
  if (host === undefined) return null;
  return createPortal(region, host ?? document.body);
}
function ToastPopover({ label, children }: { label: string; children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = root.current as (HTMLElement & { showPopover?: () => void }) | null;
    try {
      // In the top layer above the sheet it belongs to; the fixed layout applies anyway.
      element?.showPopover?.();
    } catch {
      /* Already shown or unsupported. */
    }
  }, []);
  return (
    <section className="z-toasts" ref={root} popover="manual" aria-label={label}>
      {children}
    </section>
  );
}
/** One notice in a ToastStack: a title line, the message and optional actions. */
export function Toast({
  title,
  tone = "info",
  meta,
  actions,
  onDismiss,
  highlighted = false,
  children,
}: {
  title: string;
  tone?: Tone;
  /** Briefly draws attention, e.g. after the owner tapped a "Needs approval" chip. */
  highlighted?: boolean;
  /** Shown after the title, e.g. a risk badge. */
  meta?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`z-toast z-toast--${tone}${highlighted ? " z-toast--focus" : ""}`}
      role={tone === "danger" ? "alert" : "status"}
      aria-label={title}
    >
      <div className="z-toast__head">
        <strong className="z-toast__title">{title}</strong>
        {meta}
        <span className="z-spacer" />
        {onDismiss && (
          <button type="button" className="z-toast__close" aria-label="Dismiss" onClick={onDismiss}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="z-toast__body">{children}</div>
      {actions && <div className="z-row z-toast__actions">{actions}</div>}
    </section>
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
  plus: <path d="M10 4v12M4 10h12" />,
  send: <path d="M10 16V4M5 9l5-5 5 5" />,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" />,
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.3" />
      <path d="M17 13l-4-4-7 7" />
    </>
  ),
  "file-text": (
    <>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M8 10l-1.5 1.75L8 13.5M12 10l1.5 1.75L12 13.5" />
    </>
  ),
  "file-pdf": (
    <>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M7.5 10h5M7.5 13h3" />
    </>
  ),
  file: <path d="M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15" />,
};
export type IconName =
  | "menu"
  | "back"
  | "close"
  | "settings"
  | "plus"
  | "send"
  | "stop"
  | "image"
  | "file-text"
  | "file-pdf"
  | "file";

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

/** Attachments are controlled when `files` is given; otherwise the Composer keeps its own list. */
export type ComposerAttachmentProps = {
  files?: File[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
};

/** The composer grows with its text up to this many lines, then scrolls. */
const COMPOSER_MAX_LINES = 8;

/** A short, human-readable size: 512 B, 4.2 KB, 13 MB. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const CODE_EXTENSION =
  /\.(c|cc|cpp|cs|css|go|h|html|java|js|jsx|json|kt|md|mjs|py|rb|rs|sh|sql|swift|toml|ts|tsx|txt|xml|ya?ml)$/i;

function attachmentIcon(file: File): IconName {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "file-pdf";
  if (
    file.type.startsWith("text/") ||
    /json|javascript|typescript|xml|yaml/.test(file.type) ||
    CODE_EXTENSION.test(file.name)
  ) {
    return "file-text";
  }
  return "file";
}

/** The textarea's capped height: its CSS max-height, or eight lines plus padding. */
function composerMaxHeight(element: HTMLTextAreaElement): number {
  const style = getComputedStyle(element);
  const fromCss = Number.parseFloat(style.maxHeight);
  if (Number.isFinite(fromCss)) return fromCss;
  const line =
    Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.5;
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  return COMPOSER_MAX_LINES * line + padding;
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
  streaming = false,
  onStop,
  files: controlledFiles,
  onAddFiles,
  onRemoveFile,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Receives the attached files; callers that only send text can ignore them. */
  onSubmit: (files: File[]) => void;
  placeholder: string;
  busy?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  above?: ReactNode;
  submitLabel?: string;
  /** With `onStop`, the send button becomes a Stop button while a reply streams. */
  streaming?: boolean;
  onStop?: () => void;
} & ComposerAttachmentProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [ownFiles, setOwnFiles] = useState<File[]>([]);
  const files = controlledFiles ?? ownFiles;
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const submitted = useRef(false);
  // Grow with content up to eight lines, then scroll. Measuring and setting the height in one
  // layout pass keeps the page (which pins the composer) from jumping.
  // biome-ignore lint/correctness/useExhaustiveDependencies: height follows the value.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      const max = composerMaxHeight(element);
      const content = element.scrollHeight;
      element.style.height = `${Math.min(content, max)}px`;
      element.style.overflowY = content > max ? "auto" : "hidden";
    };
    resize();
    // A narrower window wraps the same text onto more lines.
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [value]);
  // The parent clears the text once a submit succeeds; the attachments go with it.
  useEffect(() => {
    if (value === "" && submitted.current && controlledFiles === undefined) setOwnFiles([]);
    submitted.current = false;
  }, [value, controlledFiles]);
  const canSend = !busy && !disabled && value.trim().length > 0;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    submitted.current = true;
    onSubmit(files);
  };
  const addFiles = (added: File[]) => {
    if (disabled || added.length === 0) return;
    if (controlledFiles === undefined) setOwnFiles((current) => [...current, ...added]);
    onAddFiles?.(added);
    setAnnouncement(`Attached ${added.map((file) => file.name).join(", ")}`);
  };
  const removeFile = (index: number) => {
    const file = files[index];
    if (!file) return;
    if (controlledFiles === undefined) {
      setOwnFiles((current) => current.filter((_, position) => position !== index));
    }
    onRemoveFile?.(index);
    setAnnouncement(`Removed ${file.name}`);
    field.current?.focus();
  };
  const carriesFiles = (event: DragEvent) =>
    !disabled && Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const stopping = streaming && onStop !== undefined;
  return (
    <form className="z-composer" onSubmit={submit}>
      {above}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a pointer shortcut; the + button is the keyboard path. */}
      <div
        className={dropping ? "z-composer__box z-composer__box--drop" : "z-composer__box"}
        onDragEnter={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropping(true);
        }}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropping(false);
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setDropping(false);
          if (!carriesFiles(event)) return;
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {files.length > 0 && (
          <ul className="z-composer__chips" aria-label="Attachments">
            {files.map((file, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same file may be attached twice; removal is by index.
              <li key={`${file.name}-${file.size}-${index}`} className="z-composer__chip">
                <Icon name={attachmentIcon(file)} />
                <span className="z-composer__chip-name" title={file.name}>
                  {file.name}
                </span>
                <span className="z-composer__chip-size">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  className="z-composer__chip-remove"
                  aria-label={`Remove ${file.name}`}
                  title={`Remove ${file.name}`}
                  onClick={() => removeFile(index)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
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
            if (event.key !== "Enter" || event.shiftKey) return;
            // An IME uses Enter to confirm a composition; that must not send the message.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="z-composer__actions">
          <button
            type="button"
            className="z-composer__button z-composer__attach"
            aria-label="Attach files"
            title="Attach files"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              // Lets the same file be picked again after it was removed.
              event.target.value = "";
            }}
          />
          {stopping ? (
            <button
              type="button"
              className="z-composer__button z-composer__send"
              aria-label="Stop generating"
              title="Stop generating"
              onClick={onStop}
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              type="submit"
              className="z-composer__button z-composer__send"
              aria-label={submitLabel}
              title={submitLabel}
              aria-busy={busy || undefined}
              disabled={!canSend}
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
      <p className="z-visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {hint && <p className="z-composer__hint">{hint}</p>}
    </form>
  );
}

/** True on screens at least `minWidth` wide (720px by default) after mount; false on the server. */
export function useWide(minWidth = 720): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = matchMedia(`(min-width: ${minWidth}px)`);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [minWidth]);
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
  useScrollLock(open);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  // A sheet can hold another sheet (a Picker's drawer inside Settings on a phone). React
  // re-dispatches a nested dialog's `close` and its Escape keydown to every ancestor
  // `onClose`/`onKeyDown`, so each sheet reacts only to events of its own dialog: the
  // closest dialog around the event target must be this one. The browser's own Escape
  // handling (`cancel`) may target the outer dialog while an inner one is open, so it is
  // declined and Escape is handled through the keydown below instead.
  const own = (event: { target: EventTarget | null; currentTarget: HTMLDialogElement }) =>
    event.target instanceof Element && event.target.closest("dialog") === event.currentTarget;
  return (
    <dialog
      ref={dialog}
      className={`z-sheet z-sheet--${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => event.preventDefault()}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && own(event)) onClose();
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
  const [above, setAbove] = useState(false);
  useScrollLock(popover);
  // The page cannot scroll while the popover is open, so it opens upwards when the room
  // under the trigger is too short for it and there is more room above.
  useLayoutEffect(() => {
    if (!popover) return;
    const list = root.current?.querySelector<HTMLElement>(".z-popover");
    const box = trigger.current?.getBoundingClientRect();
    if (!list || !box) return;
    const below = window.innerHeight - box.bottom;
    setAbove(below < list.offsetHeight + 8 && box.top > below);
  }, [popover]);
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
      {popover && <div className={above ? "z-popover z-popover--above" : "z-popover"}>{list}</div>}
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
