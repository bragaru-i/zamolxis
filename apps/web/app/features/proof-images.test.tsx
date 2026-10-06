import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { type ProofImage, ProofImages, proofCaption } from "./proof-images";

const image = (overrides: Partial<ProofImage>): ProofImage => ({
  _id: "a1" as ProofImage["_id"],
  runId: "r1" as ProofImage["runId"],
  name: "preview.png",
  source: "proof",
  url: "https://files.example/preview.png",
  ...overrides,
});

it("shows a run's images as thumbnails and nothing without images", () => {
  const html = renderToStaticMarkup(
    createElement(ProofImages, {
      role: "Builder",
      images: [
        image({}),
        image({ _id: "a2" as ProofImage["_id"], name: "logo.svg", source: "changed" }),
      ],
    }),
  );
  expect(html).toContain("2 images from the Builder");
  expect(html).toContain('src="https://files.example/preview.png"');
  expect(html).toContain('aria-label="Open image logo.svg"');
  expect(renderToStaticMarkup(createElement(ProofImages, { role: "Builder", images: [] }))).toBe(
    "",
  );
  expect(proofCaption({ source: "changed" }, "Builder")).toBe(
    "An image this change added or edited",
  );
  expect(proofCaption({ source: "proof" }, "Verifier")).toBe("Saved by the Verifier as proof");
});
