// Review-only: npm install --prefix .review-tools playwright --no-save --package-lock=false
// Run access against next start :3124; home against ZAMOLXIS_PREVIEW=1 next dev :3123.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, webkit, devices } from "../.review-tools/node_modules/playwright/index.mjs";
const root = new URL("../", import.meta.url);
const output = new URL("docs/branding/", root);
await mkdir(output, { recursive: true });
const phase = process.argv[2] ?? "home";
const errors = [];
const inspect = (page) => {
  page.on("pageerror", (error) => errors.push(error.message));
};
const check = async (page) => {
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "horizontal overflow",
  );
  for (const mark of await page.locator(".z-mark:visible").all()) {
    const box = await mark.boundingBox();
    assert(Math.abs(box.width - box.height) < 0.1, "logo must remain square");
    assert.equal(await mark.locator("svg").getAttribute("viewBox"), "0 0 64 64");
  }
};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  inspect(page);
  if (phase === "access") {
    await page.setViewportSize({ width: 430, height: 820 });
    await page.goto("http://localhost:3124", { waitUntil: "networkidle" });
    await page.locator(".z-mark--lg svg").waitFor();
    await check(page);
    await page.screenshot({ path: fileURLToPath(new URL("access.png", output)) });
    const manifest = await (
      await page.request.get("http://localhost:3124/manifest.webmanifest")
    ).json();
    for (const icon of manifest.icons) {
      const response = await page.request.get(`http://localhost:3124${icon.src}`);
      assert.equal(response.status(), 200, icon.src);
      assert((await response.body()).length > 100);
    }
    assert(await page.locator('link[rel="apple-touch-icon"]').count());
    assert(await page.locator('link[rel="icon"]').count());
    assert.equal((await page.request.get("http://localhost:3124/apple-icon.png")).status(), 200);
  } else if (phase === "home") {
    await page.goto("http://localhost:3123/?scenario=owner", { waitUntil: "networkidle" });
    await page.locator(".z-home-nav .z-mark svg").waitFor();
    await check(page);
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: fileURLToPath(new URL("desktop.png", output)) });
    const phoneBrowser = await webkit.launch();
    try {
      const phone = await phoneBrowser.newPage({ ...devices["iPhone 14 Pro Max"] });
      inspect(phone);
      await phone.goto("http://localhost:3123/?scenario=owner", { waitUntil: "networkidle" });
      await phone.getByRole("button", { name: "Sessions", exact: true }).click();
      await phone.locator(".z-mark:visible").waitFor();
      await phone.waitForFunction(() => {
        const nav = document.querySelector(".z-home-nav");
        return nav && Math.abs(nav.getBoundingClientRect().left) < 1;
      });
      await phone.addStyleTag({ content: "nextjs-portal { display: none; }" });
      await check(phone);
      await phone.screenshot({ path: fileURLToPath(new URL("phone.png", output)), scale: "css" });
    } finally {
      await phoneBrowser.close();
    }
  } else {
    await page.goto(new URL("preview.html", output).href);
    await page.waitForFunction(() =>
      [...document.images].every((img) => img.complete && img.naturalWidth > 0),
    );
    await page.screenshot({ path: fileURLToPath(new URL("review.png", output)), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(`${phase}: passed — square marks, no overflow/page errors, assets loaded`);
  await writeFile(
    new URL(`${phase}-verification.json`, output),
    `${JSON.stringify({ phase, errors, passed: true }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
