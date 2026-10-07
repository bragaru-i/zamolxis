// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Picker, Sheet, useScrollLock } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.body.style.cssText = "color: red;";
  document.documentElement.style.cssText = "";
  Object.defineProperty(window, "scrollY", { configurable: true, value: 420 });
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
  scrollTo = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Lock({ active }: { active: boolean }) {
  useScrollLock(active);
  return null;
}

function Pair({ first, second }: { first: boolean; second: boolean }) {
  return (
    <>
      <Lock active={first} />
      <Lock active={second} />
    </>
  );
}

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

/** Settings-like: a sheet holding a picker, both owned by the test through buttons. */
function Overlays() {
  const [sheet, setSheet] = useState(false);
  const [value, setValue] = useState("a");
  return (
    <>
      <button type="button" id="open-sheet" onClick={() => setSheet(true)}>
        open
      </button>
      <Picker label="Outside" value={value} options={options} onChange={setValue} />
      <Sheet open={sheet} title="Settings" onClose={() => setSheet(false)}>
        <Picker label="Inside" value={value} options={options} onChange={setValue} />
      </Sheet>
    </>
  );
}

const click = (element: Element | null) =>
  act(() => (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const trigger = (label: string) =>
  [...container.querySelectorAll(".z-field--picker")]
    .find((field) => field.textContent?.includes(label))
    ?.querySelector(".z-picker") ?? null;
const keydown = (target: EventTarget, key: string) =>
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

function setWide(wide: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: wide,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const render = (element: React.ReactElement) => act(() => root.render(element));
const locked = () => document.body.style.position === "fixed";

describe("useScrollLock", () => {
  it("fixes the body at the current scroll position and restores it on release", () => {
    render(<Lock active />);
    expect(locked()).toBe(true);
    expect(document.body.style.top).toBe("-420px");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overscrollBehavior).toBe("none");

    render(<Lock active={false} />);
    expect(locked()).toBe(false);
    expect(document.body.style.cssText).toBe("color: red;");
    expect(document.documentElement.style.cssText).toBe("");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 420, behavior: "instant" });
  });

  it("does nothing while inactive", () => {
    render(<Lock active={false} />);
    expect(locked()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the page locked until the last of two overlapping locks is released", () => {
    render(<Pair first second={false} />);
    render(<Pair first second />);
    expect(locked()).toBe(true);

    render(<Pair first={false} second />);
    expect(locked()).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();

    render(<Pair first={false} second={false} />);
    expect(locked()).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the overlay unmounts while open", () => {
    render(<Lock active />);
    expect(locked()).toBe(true);
    render(<div />);
    expect(locked()).toBe(false);
    expect(document.body.style.cssText).toBe("color: red;");
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 420, behavior: "instant" });
  });

  it("leaves the page unlocked after repeated opening and closing", () => {
    for (let index = 0; index < 5; index += 1) {
      render(<Pair first second={index % 2 === 0} />);
      render(<Pair first={false} second={false} />);
    }
    expect(locked()).toBe(false);
    expect(document.body.style.cssText).toBe("color: red;");
    expect(scrollTo).toHaveBeenCalledTimes(5);
    // A fresh lock after all of that still locks and releases normally.
    render(<Lock active />);
    expect(locked()).toBe(true);
    render(<Lock active={false} />);
    expect(locked()).toBe(false);
  });

  it("restores the scroll position the page had when the first lock was taken", () => {
    render(<Pair first second={false} />);
    // The page is fixed now, so the live value no longer reflects where the reader was.
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    render(<Pair first second />);
    render(<Pair first={false} second={false} />);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 420, behavior: "instant" });
  });

  it("locks while a Sheet is open and releases on its close button and on Escape", () => {
    setWide(false);
    render(<Overlays />);
    click(container.querySelector("#open-sheet"));
    expect(locked()).toBe(true);
    click(container.querySelector('dialog[open] button[aria-label="Close"]'));
    expect(locked()).toBe(false);

    click(container.querySelector("#open-sheet"));
    expect(locked()).toBe(true);
    keydown(container.querySelector("dialog[open] .z-sheet__title") as Element, "Escape");
    expect(locked()).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("keeps the page locked while a phone Picker drawer inside a Sheet closes", () => {
    setWide(false);
    render(<Overlays />);
    click(container.querySelector("#open-sheet"));
    click(trigger("Inside"));
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(2);
    // Choosing an option closes only the picker's drawer; Settings is still open.
    click(
      [...container.querySelectorAll("dialog[open] [role=option]")].find(
        (option) => option.textContent === "Beta",
      ) ?? null,
    );
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(locked()).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    click(container.querySelector('dialog[open] button[aria-label="Close"]'));
    expect(locked()).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("locks while a wide-screen Picker popover is open and releases on Escape and outside press", () => {
    setWide(true);
    render(<Overlays />);
    click(trigger("Outside"));
    expect(container.querySelector(".z-popover")).not.toBeNull();
    expect(locked()).toBe(true);
    keydown(document, "Escape");
    expect(container.querySelector(".z-popover")).toBeNull();
    expect(locked()).toBe(false);

    click(trigger("Outside"));
    expect(locked()).toBe(true);
    act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(locked()).toBe(false);
  });

  it("renders on the server without touching the document", () => {
    expect(renderToStaticMarkup(<Lock active />)).toBe("");
  });
});
