import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.data[getFunctionName(reference)],
}));

import { DevicesSection, deviceLabel, type SignIn } from "./devices";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

beforeEach(() => {
  state.data = {};
});

describe("deviceLabel", () => {
  it("keeps only the browser family and device kind", () => {
    expect(deviceLabel(IPHONE)).toBe("Safari on iPhone");
    expect(deviceLabel(MAC_SAFARI)).toBe("Safari on Mac");
    // iPadOS reports a Mac user agent but has a touch screen.
    expect(deviceLabel(MAC_SAFARI, 5)).toBe("Safari on iPad");
    expect(deviceLabel(MAC_CHROME)).toBe("Chrome on Mac");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Chrome on iPhone");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox on Linux");
    expect(deviceLabel("")).toBe("Browser");
    // Never more than the backend accepts, and no version numbers.
    for (const ua of [IPHONE, MAC_CHROME, "x".repeat(500)]) {
      expect(deviceLabel(ua).length).toBeLessThanOrEqual(64);
      expect(deviceLabel(ua)).not.toMatch(/\d/);
    }
  });
});

describe("DevicesSection", () => {
  const signIn = (overrides: Partial<SignIn>): SignIn => ({
    sessionId: "s" as SignIn["sessionId"],
    createdAt: 0,
    expiresAt: 86_400_000,
    lastActiveAt: 0,
    current: false,
    label: null,
    ...overrides,
  });
  it("shows each sign-in's device label and falls back to time-only entries", () => {
    state.data = {
      "admin:mySignIns": [
        signIn({ sessionId: "a" as SignIn["sessionId"], current: true, label: "Safari on iPhone" }),
        signIn({ sessionId: "b" as SignIn["sessionId"], label: "Chrome on Mac" }),
        signIn({ sessionId: "c" as SignIn["sessionId"] }),
      ],
    };
    const html = renderToStaticMarkup(createElement(DevicesSection, { active: true, now: 1000 }));
    expect(html).toContain("Safari on iPhone · this device");
    expect(html).toContain("Chrome on Mac");
    expect(html).toContain("Another browser");
  });
});
