import type { InputHTMLAttributes, ReactNode } from "react";

/** Label/value rows, e.g. a usage breakdown or profile details. Wraps on narrow screens. */
export function KeyValueList({
  items,
  label,
}: {
  items: Array<{ key?: string; label: ReactNode; value: ReactNode }>;
  label?: string;
}) {
  return (
    <dl className="z-kv" aria-label={label}>
      {items.map((item, index) => (
        <div className="z-kv__row" key={item.key ?? index}>
          <dt className="z-kv__label">{item.label}</dt>
          <dd className="z-kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One headline number with a label and optional detail line. */
export function Stat({
  label,
  value,
  detail,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="z-stat">
      <span className="z-stat__label">{label}</span>
      <span className="z-stat__value">{value}</span>
      {detail && <span className="z-stat__detail">{detail}</span>}
    </div>
  );
}

/** Responsive grid of Stat tiles. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="z-stats">{children}</div>;
}

/** Single-line text input sharing the field styling of selects and textareas. */
export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={className ? `z-input ${className}` : "z-input"} {...props} />;
}

/** A small set of mutually exclusive choices shown as toggle buttons. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="z-segmented">
      <legend className="z-visually-hidden">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="z-segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
