// Export the shared vector geometry. Raster export uses Next.js's sharp dependency.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const sharp = require(require.resolve("sharp", { paths: [require.resolve("next/package.json")] }));
const root = new URL("../", import.meta.url);
const source = await readFile(new URL("packages/ui/src/product-mark.ts", root), "utf8");
const paths = Object.fromEntries(
  [...source.matchAll(/export const (\w+) =\s*"([^"]+)";/g)].map((m) => [m[1], m[2]]),
);
for (const key of ["crownPath", "facePath", "compactPath"]) {
  if (!paths[key]) throw new Error(`Missing logo geometry: ${key}`);
}
const art = (compact, color) =>
  `<g fill="${color}" fill-rule="evenodd">${(compact ? [paths.compactPath] : [paths.crownPath, paths.facePath]).map((d) => `<path d="${d}"/>`).join("")}</g>`;
const svg = (content) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>Zamolxis — crowned ruler</title>${content}</svg>\n`;
const tile = (compact, inset = false) =>
  svg(
    `<rect width="64" height="64" rx="${inset ? 0 : 12}" fill="#18202b"/><g transform="translate(${inset ? 12 : 6} ${inset ? 12 : 6}) scale(${inset ? 0.625 : 0.8125})">${art(compact, "#f5dfae")}</g>`,
  );
await mkdir(new URL("apps/web/public/brand/", root), { recursive: true });
for (const [name, color] of [
  ["light", "#18202b"],
  ["dark", "#f5dfae"],
]) {
  await writeFile(
    new URL(`apps/web/public/brand/zamolxis-${name}.svg`, root),
    svg(art(false, color)),
  );
  await writeFile(
    new URL(`apps/web/public/brand/zamolxis-small-${name}.svg`, root),
    svg(art(true, color)),
  );
}
await writeFile(new URL("apps/web/app/icon.svg", root), tile(true));
for (const size of [192, 512]) {
  await sharp(Buffer.from(tile(false)))
    .resize(size, size)
    .png()
    .toFile(fileURLToPath(new URL(`apps/web/public/brand/icon-${size}.png`, root)));
}
await sharp(Buffer.from(tile(false, true)))
  .resize(512, 512)
  .png()
  .toFile(fileURLToPath(new URL("apps/web/public/brand/icon-maskable-512.png", root)));
await sharp(Buffer.from(tile(false, true)))
  .resize(180, 180)
  .png()
  .toFile(fileURLToPath(new URL("apps/web/app/apple-icon.png", root)));
