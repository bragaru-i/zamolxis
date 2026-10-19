---
name: ui-check
description: Use before shipping any change under apps/web or packages/ui. Owns opening the real app with the preview harness and checking it with Playwright on phone and laptop sizes; not design rules (docs/ui-ux-design-system.md).
---

# UI check

**Invariant:** the owner uses the app on an iPhone. Open the app and test it yourself on phone and laptop; screenshots or tests alone are not a check.

## Process

1. Start the real app on the fixture backend:
   ```bash
   cd apps/web && ZAMOLXIS_PREVIEW=1 pnpm exec next dev -p 3123
   ```
   Pages: `/?scenario=owner` (also `empty`, `attention`, `busy`), `/?session=s1&run=r1` (running Session, Run detail). Scenarios live in `apps/web/preview/fixtures.ts`; add one when your screen has no fixture.
2. Install Playwright in the scratchpad, not the repository: `npm i playwright && npx playwright install chromium webkit`.
3. Drive each changed screen with `devices["iPhone 14 Pro Max"]` (WebKit) and a 1280px Chromium viewport. Click through the flow the change touches, not just the first screen.
4. Assert on every screen: `document.documentElement.scrollWidth <= clientWidth` (iOS zooms the whole layout out on any overflow) and no console errors.
5. Look at the screenshots yourself: labels in plain words, statuses that tell the truth, styled pickers (no bare native selects on iOS), nothing hidden under the safe areas.
6. Report what you checked and on which sizes, and what the harness cannot show (real backend, real iPhone).

## Pair with

`plain-writing`, `shipping-a-change`.
