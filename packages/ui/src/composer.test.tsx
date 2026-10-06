// @vitest-environment happy-dom
import { act, type ComponentProps, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, formatFileSize } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Partial<ComponentProps<typeof Composer>>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** A parent that owns the text and clears it after a submit, like both call sites do. */
function Harness({ initial = "", onSubmit, ...props }: Props & { initial?: string }) {
  const [text, setText] = useState(initial);
  return (
    <Composer
      placeholder="Ask Zamolxis…"
      {...props}
      value={text}
      onChange={setText}
      onSubmit={(files) => {
        onSubmit?.(files);
        setText("");
      }}
    />
  );
}

const render = (element: React.ReactElement) => act(() => root.render(element));
const field = () => container.querySelector("textarea") as HTMLTextAreaElement;
const button = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const chipNames = () =>
  Array.from(container.querySelectorAll(".z-composer__chip-name")).map((chip) => chip.textContent);

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

function attach(files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Composer", () => {
  it("grows with the text, caps at eight lines and shrinks again", () => {
    // 24px per line, as the 1.5 line height gives at 16px.
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      return this.value.split("\n").length * 24;
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: `${8 * 24}px`,
    } as CSSStyleDeclaration);
    render(<Harness />);
    expect(field().getAttribute("rows")).toBe("1");
    type("one\ntwo\nthree");
    expect(field().style.height).toBe("72px");
    expect(field().style.overflowY).toBe("hidden");
    type(Array.from({ length: 30 }, (_, line) => `line ${line}`).join("\n"));
    expect(field().style.height).toBe("192px");
    expect(field().style.overflowY).toBe("auto");
    type("one");
    expect(field().style.height).toBe("24px");
  });

  it("caps at eight lines from the line height when no max-height is set", () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "none",
      lineHeight: "24px",
      paddingTop: "8px",
      paddingBottom: "8px",
    } as CSSStyleDeclaration);
    render(<Harness initial="long" />);
    expect(field().style.height).toBe(`${8 * 24 + 16}px`);
  });

  it("sends on Enter and Cmd/Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("hello");
    const event = press({});
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("");
    type("again");
    press({ ctrlKey: true });
    press({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps Shift+Enter as a newline", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("hello");
    const event = press({ shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not send while an IME composes", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    type("にほん");
    press({ isComposing: true });
    const legacy = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(legacy, "keyCode", { value: 229 });
    act(() => {
      field().dispatchEvent(legacy);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("にほん");
  });

  it("disables send for empty or whitespace-only text, while busy and when disabled", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    expect(button("Send")?.disabled).toBe(true);
    type("   \n ");
    expect(button("Send")?.disabled).toBe(true);
    press({});
    expect(onSubmit).not.toHaveBeenCalled();
    type("hi");
    expect(button("Send")?.disabled).toBe(false);
    render(<Harness initial="hi" busy />);
    expect(button("Send")?.disabled).toBe(true);
    const html = renderToStaticMarkup(
      <Composer value="hi" onChange={() => {}} onSubmit={() => {}} placeholder="x" disabled />,
    );
    expect(html).toMatch(/<button type="submit"[^>]*aria-label="Send"[^>]*disabled=""/);
  });

  it("shows a working Stop button while streaming with onStop", () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial="hi" streaming onStop={onStop} onSubmit={onSubmit} />);
    const stop = button("Stop generating");
    expect(stop?.type).toBe("button");
    expect(button("Send")).toBeNull();
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    // Streaming without a way to stop keeps the send button.
    render(<Harness initial="hi" streaming />);
    expect(button("Send")).not.toBeNull();
  });

  it("adds files from the picker as chips and removes one", () => {
    render(<Harness />);
    attach([
      new File(["x".repeat(2048)], "notes.md", { type: "text/markdown" }),
      new File(["png"], "shot.png", { type: "image/png" }),
    ]);
    expect(chipNames()).toEqual(["notes.md", "shot.png"]);
    expect(container.textContent).toContain("2.0 KB");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Attached notes.md, shot.png",
    );
    act(() => button("Remove notes.md")?.click());
    expect(chipNames()).toEqual(["shot.png"]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Removed notes.md");
  });

  it("hands the files to onSubmit and clears the chips after sending", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const file = new File(["%PDF"], "spec.pdf", { type: "application/pdf" });
    attach([file]);
    type("see attached");
    act(() => button("Send")?.click());
    expect(onSubmit).toHaveBeenCalledWith([file]);
    expect(chipNames()).toEqual([]);
  });

  it("reports picked and removed files when the parent controls them", () => {
    const onAddFiles = vi.fn();
    const onRemoveFile = vi.fn();
    const file = new File(["a"], "a.txt", { type: "text/plain" });
    render(<Harness files={[file]} onAddFiles={onAddFiles} onRemoveFile={onRemoveFile} />);
    const added = new File(["b"], "b.bin");
    attach([added]);
    expect(onAddFiles).toHaveBeenCalledWith([added]);
    expect(chipNames()).toEqual(["a.txt"]);
    act(() => button("Remove a.txt")?.click());
    expect(onRemoveFile).toHaveBeenCalledWith(0);
  });

  it("formats sizes in B, KB and MB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(200 * 1024)).toBe("200 KB");
    expect(formatFileSize(13 * 1024 * 1024)).toBe("13 MB");
  });
});
