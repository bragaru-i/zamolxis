# Zamolxis artwork review

Design candidate prepared from repository context
`c1b5baff5da4b811600e171df3bfcda0bd5090e5`. Owner design approval is pending.
All implementation edits remain in the assigned worktree; no publication or merge.

Open [the review board](preview.html) or [its rendered preview](review.png).
The board includes light/dark variants, 16/24/32/56 px samples, favicon and
installation samples, and screenshots of actual product placements.

## Placement inventory

The tracked-asset inventory contained only `apps/web/app/icon.svg`: a blue Z on
a dark rounded square. No existing PNG, ICO, Apple touch icon, native application
icon, social image or separate logo artwork was tracked. Repository-wide searches
covered image files, logo/favicon/icon/branding references, metadata, manifest,
shared components, Node code, public files and documentation.

| Placement | Existing source | Replacement |
| --- | --- | --- |
| Access gate: configuration, loading, sign-in, pending and blocked states | `apps/web/app/page.tsx`, shared `ProductMark` at 56 px | Detailed crowned face, inline SVG |
| Render error screen | `apps/web/app/error.tsx`, shared `ProductMark` at 56 px | Same detailed face |
| Desktop Home navigation and phone Sessions drawer | `apps/web/app/features/sessions.tsx`, shared `ProductMark` at 36 px | Compact crowned face |
| Browser favicon | Next file convention, `apps/web/app/icon.svg` | Compact face on a navy tile |
| Standalone application icon | `apps/web/app/manifest.ts`, formerly `/icon.svg` only | Updated SVG plus 192/512 px PNG and 512 px maskable PNG |
| Apple home-screen icon | Absent | `apps/web/app/apple-icon.png`, 180 px, opaque with mask-safe padding |

The page title, Apple web app metadata and manifest names remain Zamolxis. Text-only
placements (conversation authors, offline page, startup watchdog, CLI/setup messages)
had no logo to replace. Vendor/runtime icons and the development indicator are
unrelated branding. No existing documentation described the old Z design or asset
paths, so existing documentation required no logo-reference correction.

## Artwork

Original, symmetric geometric interpretation of a majestic divine ruler: a broad
three-point crown, strong brow, eye apertures, nose and angular beard. This is a
stylized interpretation, not a claim of historical likeness. The compact version
merges the crown band and opens the facial details for small displays.

`packages/ui/src/product-mark.ts` is the geometry source. The component uses it
directly; `node scripts/export-brand.mjs` exports all SVG/PNG assets using Sharp
from the installed Next dependency. Missing geometry stops export.

Use `apps/web/public/brand/zamolxis-light.svg` on light backgrounds and
`zamolxis-dark.svg` on dark backgrounds; the corresponding `zamolxis-small-*`
variants are intended below 40 px. Preserve the square viewBox and aspect ratio.
The app retains its existing navy/white palette; exported dark-background artwork
uses pale gold. Installation tiles are opaque; maskable artwork fits inside the
central safe circle. No fonts, external resources, raster tracing or gradients are
required by the vector artwork.

## Verification

- `pnpm check`: passed (lint, boundaries, workspace and Convex typechecks,
  workspace tests, Convex/integration tests and production build). Existing Biome
  schema/deprecation and environment warnings and Turbo output warnings remain.
  The root integration suite reported 172 passed and 14 opt-in tests skipped.
- `node scripts/export-brand.mjs`: passed, including regeneration after formatting.
- `node_modules/.bin/biome lint scripts/export-brand.mjs scripts/preview-brand.mjs
  packages/ui/src/product-mark.ts packages/ui/src/index.tsx apps/web/app/manifest.ts`:
  passed.
- `git diff --check`: passed. The generated `next-env.d.ts` build change was restored.
- `node scripts/preview-brand.mjs access`: passed against the built app on port 3124.
  Verified favicon and Apple metadata, Apple icon route and every manifest icon
  returned HTTP 200 with nonempty bodies. Captured actual configuration access gate.
- `node scripts/preview-brand.mjs home`: passed against the dev fixture harness on
  port 3123, Chromium 1280 × 900 and iPhone 14 Pro Max WebKit. Verified square marks,
  no horizontal overflow or page errors; captured desktop and fully opened drawer.
- `node scripts/preview-brand.mjs board`: passed; every review image loaded.
  Visually inspected artwork and screenshots, including both backgrounds and
  representative small sizes. Facial detail is necessarily reduced at 16 px;
  the crown and angular face silhouette remain visible.

To reproduce browser checks, install Playwright with
`npm install --prefix .review-tools playwright --no-save --package-lock=false`
and install its Chromium/WebKit browsers if absent. The review script documents
the two server modes. Screenshots hide only Next's development overlay.

Untested boundaries: actual iPhone/Android home-screen installation and masks,
deployed Google sign-in, installed-icon/browser cache refresh, and production
deployment. The access screenshot uses the configuration gate; other access states
and the render-error screen share the same component but were not separately
captured. Remote PR reviews and CI were not queried or changed; no external CI run
was initiated. Native runtime acceptance is not applicable to this artwork/UI-only
change. Visual evidence is available for owner review and does not imply approval.
