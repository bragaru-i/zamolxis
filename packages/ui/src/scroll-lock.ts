import { useLayoutEffect } from "react";

interface Saved {
  readonly x: number;
  readonly y: number;
  readonly body: string;
  readonly html: string;
}

// One lock for the whole document, shared by every open overlay (a Picker inside a Sheet,
// the phone sidebar), so the page is released only when the last of them closes.
let count = 0;
let saved: Saved | undefined;

function lock() {
  count += 1;
  if (count > 1) return;
  const html = document.documentElement;
  const body = document.body;
  const x = window.scrollX;
  const y = window.scrollY;
  // The scrollbar disappears with the lock; padding takes its place so nothing shifts sideways.
  const gutter = Math.max(0, window.innerWidth - html.clientWidth);
  saved = { x, y, body: body.style.cssText, html: html.style.cssText };
  // A fixed body is the one lock iOS Safari honours for touch scrolling; the negative top keeps
  // the page where it was under the overlay.
  Object.assign(body.style, {
    position: "fixed",
    top: `${-y}px`,
    left: `${-x}px`,
    right: "0",
    width: "100%",
    overflow: "hidden",
  });
  if (gutter) body.style.paddingRight = `${gutter}px`;
  html.style.overscrollBehavior = "none";
}

function unlock() {
  if (count === 0) return;
  count -= 1;
  if (count > 0 || !saved) return;
  const { x, y, body, html } = saved;
  saved = undefined;
  document.body.style.cssText = body;
  document.documentElement.style.cssText = html;
  // "instant" so a page-wide smooth scroll setting cannot animate the way back.
  window.scrollTo({ left: x, top: y, behavior: "instant" });
}

/**
 * Keeps the page behind an overlay from scrolling while `active` is true. Locks nest: the page
 * scrolls again when the last active lock is released, at exactly the position it had before.
 * Unmounting releases the lock, so every close path (button, backdrop, Escape, navigation)
 * frees the page.
 */
export function useScrollLock(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    lock();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
    };
  }, [active]);
}
