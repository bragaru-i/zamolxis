import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args === "skip" ? undefined : state.data[getFunctionName(reference)],
}));

import { explainArchiveError, type ProductRow, productSummary, ProductsSection } from "./products";

const product = (overrides: Partial<ProductRow> = {}): ProductRow => ({
  _id: "p1" as ProductRow["_id"],
  name: "Zamolxis",
  sessions: 3,
  repositories: [{ _id: "r1" as ProductRow["repositories"][number]["_id"], name: "zamolxis" }],
  canArchive: false,
  reason: "A repository of this product exists in no other product.",
  ...overrides,
});
const render = () => renderToStaticMarkup(createElement(ProductsSection));

beforeEach(() => {
  state.data = {};
});

describe("Settings → Products", () => {
  it("summarizes repositories and sessions", () => {
    expect(productSummary(product())).toBe("1 repository · 3 sessions");
    expect(productSummary(product({ repositories: [], sessions: 1 }))).toBe(
      "0 repositories · 1 session",
    );
  });
  it("offers to archive only a product whose repositories another product already has", () => {
    state.data = {
      "products:list": [
        product(),
        product({
          _id: "p2" as ProductRow["_id"],
          name: "zamolxis",
          sessions: 0,
          repositories: [
            {
              _id: "r2" as ProductRow["repositories"][number]["_id"],
              name: "zamolxis",
              duplicateOf: { productId: "p1" as ProductRow["_id"], name: "Zamolxis" },
            },
          ],
          canArchive: true,
        }),
      ],
    };
    const html = render();
    expect(html).toContain("same repository as in Zamolxis");
    expect(html.match(/Archive duplicate/g)).toHaveLength(1);
    expect(html).toContain("exists in no other product");
    expect(html).toContain("matched by its remote origin");
  });
  it("shows nothing to archive and no reason when there is a single product", () => {
    state.data = { "products:list": [product()] };
    const html = render();
    expect(html).not.toContain("Archive duplicate");
    expect(html).not.toContain("exists in no other product");
    expect(html).toContain("1 repository · 3 sessions");
  });
  it("explains refusals in plain language", () => {
    expect(explainArchiveError(new ConvexError({ code: "PRODUCT_IN_USE" }))).toContain(
      "exists nowhere else",
    );
    expect(explainArchiveError(new ConvexError({ code: "LOCATION_BUSY" }))).toContain(
      "still running",
    );
  });
});
