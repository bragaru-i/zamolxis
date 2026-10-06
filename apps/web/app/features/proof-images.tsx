"use client";
import { Sheet } from "@zamolxis/ui";
import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";

export interface ProofImage {
  _id: Id<"artifacts">;
  runId: Id<"agentRuns">;
  name: string;
  source: "proof" | "changed";
  url: string;
}

export function proofCaption(image: Pick<ProofImage, "source">, role: string): string {
  return image.source === "changed"
    ? "An image this change added or edited"
    : `Saved by the ${role} as proof`;
}

/** Thumbnails of a run's proof images; a tap shows one full size. */
export function ProofImages({ images, role }: { images: ProofImage[]; role: string }) {
  const [open, setOpen] = useState<ProofImage>();
  if (!images.length) return null;
  return (
    <div className="z-proof">
      <span className="z-xsmall z-muted">
        {images.length === 1 ? "1 image" : `${images.length} images`} from the {role}
      </span>
      <div className="z-proof__strip">
        {images.map((image) => (
          <button
            type="button"
            key={image._id}
            className="z-proof__thumb"
            aria-label={`Open image ${image.name}`}
            onClick={() => setOpen(image)}
          >
            {/* biome-ignore lint/performance/noImgElement: storage URLs are not optimizable assets. */}
            <img src={image.url} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      <Sheet
        open={open !== undefined}
        title={open?.name ?? "Image"}
        description={open ? proofCaption(open, role) : undefined}
        size="lg"
        onClose={() => setOpen(undefined)}
      >
        {open && (
          <div className="z-stack">
            {/* biome-ignore lint/performance/noImgElement: storage URLs are not optimizable assets. */}
            <img className="z-proof__full" src={open.url} alt={open.name} />
            <a className="z-small" href={open.url} target="_blank" rel="noreferrer">
              Open full size
            </a>
          </div>
        )}
      </Sheet>
    </div>
  );
}
