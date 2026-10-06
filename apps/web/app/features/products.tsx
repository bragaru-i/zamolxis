"use client";
import { Button, Notice } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError } from "./errors";

/** One of the owner's Products as `products.list` reports it. */
export interface ProductRow {
  _id: Id<"products">;
  name: string;
  sessions: number;
  repositories: Array<{
    _id: Id<"repositories">;
    name: string;
    /** The Product that already has this repository (same remote origin). */
    duplicateOf?: { productId: Id<"products">; name: string };
  }>;
  canArchive: boolean;
  reason?: string;
}

const ARCHIVE_ERRORS: Record<string, string> = {
  PRODUCT_IN_USE: "This product still has work running or a repository that exists nowhere else.",
  LOCATION_BUSY: "Work is still running in this repository on a computer. Try again when it ends.",
  NOT_FOUND: "This product no longer exists.",
};

export function explainArchiveError(error: unknown): string {
  const code = errorCode(error);
  return (code && ARCHIVE_ERRORS[code]) ?? explainError(error, "Could not archive this product.");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 repositories · 3 sessions", with a note for a repository another Product also has. */
export function productSummary(product: ProductRow): string {
  return `${plural(product.repositories.length, "repository", "repositories")} · ${plural(product.sessions, "session")}`;
}

/**
 * Settings → Computers & repositories → Products: every live Product with its repositories,
 * and a way to archive a duplicate (one whose repositories all exist in another Product,
 * matched by remote origin). Archiving keeps the Product's history readable.
 */
export function ProductsSection() {
  const products = useQuery(api.products.list, {}) as ProductRow[] | undefined;
  const archive = useMutation(api.products.archive);
  const [confirming, setConfirming] = useState<Id<"products">>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [message, setMessage] = useState("");
  return (
    <section className="z-stack" aria-label="Products">
      <h4 className="z-section-title">Products</h4>
      <p className="z-xsmall z-muted">
        One product per repository, matched by its remote origin wherever it is checked out. A
        product that only repeats repositories of another one can be archived; its sessions stay
        readable.
      </p>
      {products === undefined ? (
        <p className="z-muted z-small" role="status">
          Loading products…
        </p>
      ) : products.length === 0 ? (
        <p className="z-muted z-small">No products yet. Pair a computer with a repository.</p>
      ) : (
        <div className="z-list">
          {products.map((product) => (
            <div className="z-stack z-list-item z-list-item--static" key={product._id}>
              <div className="z-row z-row--between">
                <span className="z-list-item__title">{product.name}</span>
                <span className="z-xsmall z-muted">{productSummary(product)}</span>
              </div>
              {product.repositories.map((repository) => (
                <span className="z-xsmall z-muted" key={repository._id}>
                  {repository.name}
                  {repository.duplicateOf
                    ? ` · same repository as in ${repository.duplicateOf.name}`
                    : ""}
                </span>
              ))}
              {product.canArchive ? (
                confirming === product._id ? (
                  <div className="z-row">
                    <Button
                      variant="danger"
                      size="small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setProblem("");
                        try {
                          await archive({ productId: product._id });
                          setMessage(
                            `${product.name} is archived. Its repositories now belong to the product that already had them.`,
                          );
                        } catch (error) {
                          setProblem(explainArchiveError(error));
                        } finally {
                          setBusy(false);
                          setConfirming(undefined);
                        }
                      }}
                    >
                      {busy ? "Archiving…" : "Confirm archive"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={busy}
                      onClick={() => setConfirming(undefined)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <div className="z-row">
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => setConfirming(product._id)}
                    >
                      Archive duplicate
                    </Button>
                  </div>
                )
              ) : (
                product.reason &&
                products.length > 1 && <span className="z-xsmall z-muted">{product.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
    </section>
  );
}
