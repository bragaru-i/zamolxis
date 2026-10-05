import type { ReactNode } from "react";
import type { Tone } from "./index";

/** Compact vertical activity timeline (ordered oldest to newest). */
export function Timeline({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol className="z-timeline" aria-label={label}>
      {children}
    </ol>
  );
}

export function TimelineItem({
  tone = "neutral",
  title,
  meta,
  children,
}: {
  tone?: Tone;
  title: ReactNode;
  /** Secondary text such as a time; kept on the title line when it fits. */
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="z-timeline__item">
      <span className={`z-timeline__dot z-tone-${tone}`} aria-hidden="true" />
      <div className="z-timeline__content">
        <div className="z-timeline__head">
          <span className="z-timeline__title">{title}</span>
          {meta && <span className="z-timeline__meta">{meta}</span>}
        </div>
        {children && <div className="z-timeline__body">{children}</div>}
      </div>
    </li>
  );
}

/** Native disclosure with a touch-sized summary row. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="z-disclosure" open={defaultOpen || undefined}>
      <summary className="z-disclosure__summary">{summary}</summary>
      <div className="z-disclosure__body">{children}</div>
    </details>
  );
}

/** Label/value pairs that wrap instead of overflowing on narrow screens. */
export function Facts({
  items,
  label,
}: {
  /** Falsy entries are skipped, so callers can write `condition && { label, value }`. */
  items: ReadonlyArray<{ label: string; value: ReactNode } | false | "" | 0 | undefined | null>;
  label?: string;
}) {
  const visible = items.filter((item): item is { label: string; value: ReactNode } => !!item);
  if (visible.length === 0) return null;
  return (
    <dl className="z-facts" aria-label={label}>
      {visible.map((item) => (
        <div className="z-facts__row" key={item.label}>
          <dt className="z-facts__label">{item.label}</dt>
          <dd className="z-facts__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
