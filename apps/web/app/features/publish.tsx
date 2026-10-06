"use client";
import { Button, KeyValueList, Notice, Sheet, safeHref, Thinking } from "@zamolxis/ui";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { errorCode, explainError, explainFailure } from "./errors";

export interface Publication {
  ready: boolean;
  status: "none" | "pending" | "published" | "failed";
  title: string;
  branch?: string;
  base?: string;
  prUrl?: string;
  compareUrl?: string;
  error?: string;
}

// Node failure codes for publishing, in plain language.
const PUBLISH_FAILURES: Record<string, string> = {
  PUBLISH_DIRTY: "The integration branch on your computer has uncommitted changes.",
  PUBLISH_SHA_MISMATCH:
    "The integration branch on your computer no longer matches the trusted commit.",
  PUBLISH_PUSH_FAILED:
    "Your computer couldn't push the branch. The repository's GitHub token or account may only allow reading (it needs Contents: Read and write), a push check on your computer may have refused it, or the branch name is already taken.",
  PUBLISH_GITHUB_NOT_CONNECTED:
    "This repository isn't connected to GitHub on your computer yet. On your computer, run pnpm zamolxis github-token to add a token for it, or choose a signed-in GitHub account for it in pnpm zamolxis setup, then try again.",
  PUBLISH_GITHUB_AUTH_REQUIRED:
    "The GitHub account chosen for this repository isn't signed in on your computer anymore. On your computer, sign it in again with gh auth login, or add a token with pnpm zamolxis github-token, then try again.",
  PUBLISH_GITHUB_TOKEN_INVALID:
    "GitHub no longer accepts this repository's token (it was revoked, expired or mistyped). On your computer, run pnpm zamolxis github-token to add a new one, then try again.",
  PUBLISH_GITHUB_TOKEN_EXPIRED:
    "This repository's GitHub token has expired. On your computer, run pnpm zamolxis github-token to add a new one, then try again.",
  PUBLISH_GITHUB_NO_PUSH:
    "The GitHub token or account used for this repository can't push to it. Add a token that includes this repository with Contents and Pull requests set to Read and write (pnpm zamolxis github-token on your computer), or choose an account with write access in setup, then try again.",
  PUBLISH_GITHUB_UNREACHABLE:
    "Your computer couldn't reach GitHub. Check its internet connection and try again.",
  PUBLISH_GITHUB_TOKEN_UNREADABLE:
    "Your computer couldn't read this repository's GitHub token. Unlock your computer (its login Keychain), then try again.",
  PUBLISH_PR_FAILED:
    "The branch was pushed, but the pull request couldn't be opened. Check that the repository's GitHub token or account may open pull requests (Pull requests: Read and write), then try again, or open it on GitHub.",
  PUBLISH_NO_REMOTE: "The repository has no origin remote to push to.",
  PUBLISH_BASE_UNKNOWN: "The repository's default branch isn't known on your computer.",
  PUBLISH_DEFAULT_BRANCH: "Zamolxis never pushes to the default branch.",
  PUBLISH_INVALID_BRANCH: "Zamolxis only pushes to its own branches.",
  PUBLISH_NOT_INTEGRATION: "This work isn't on an integration branch.",
  PUBLISH_INTERRUPTED: "Your computer stopped while publishing. It's safe to try again.",
};

export function explainPublishFailure(code: string | undefined): string {
  if (!code) return "Publishing failed.";
  return PUBLISH_FAILURES[code] ?? `Publishing failed: ${explainFailure(code)}.`;
}

/** Publishes trusted work as a pull request, only when the owner asks. */
export function PublishTask({ taskId }: { taskId: Id<"tasks"> }) {
  const publication = useQuery(api.integration.publication, { taskId }) as Publication | undefined;
  const publish = useMutation(api.integration.publish);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!publication) return null;
  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await publish({ taskId });
      setConfirming(false);
    } catch (failure) {
      setError(
        errorCode(failure) === "PUBLISH_NOT_READY"
          ? "This work is no longer ready to publish."
          : explainError(failure, "Could not start publishing. Try again."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PublishStatus publication={publication} onPublish={() => setConfirming(true)} />
      {error && !confirming && <Notice tone="danger">{error}</Notice>}
      {confirming && (
        <PublishConfirm
          publication={publication}
          busy={busy}
          error={error}
          onConfirm={start}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

export function PublishStatus({
  publication,
  onPublish,
}: {
  publication: Publication;
  onPublish: () => void;
}) {
  if (publication.status === "pending")
    return <Thinking label="Pushing…" detail={publication.branch} />;
  if (publication.status === "published") {
    const pr = publication.prUrl ? safeHref(publication.prUrl) : undefined;
    const compare = publication.compareUrl ? safeHref(publication.compareUrl) : undefined;
    return (
      <div className="z-stack">
        <Notice tone="success">
          {pr
            ? "Pull request opened. Merging is your decision."
            : `Branch ${publication.branch ?? ""} pushed. Open the pull request yourself.`}
        </Notice>
        {(pr ?? compare) && (
          <a
            className="z-button z-button--secondary z-button--small"
            href={pr ?? compare}
            target="_blank"
            rel="noopener noreferrer"
          >
            {pr ? "View pull request" : "Create pull request"}
          </a>
        )}
      </div>
    );
  }
  if (!publication.ready) return null;
  return (
    <div className="z-stack">
      {publication.status === "failed" && (
        <Notice tone="danger">{explainPublishFailure(publication.error)}</Notice>
      )}
      <div className="z-row">
        <Button variant="secondary" size="small" onClick={onPublish}>
          {publication.status === "failed" ? "Try again" : "Open pull request"}
        </Button>
      </div>
    </div>
  );
}

export function PublishConfirm({
  publication,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  publication: Publication;
  busy: boolean;
  error?: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open title="Open pull request" onClose={onClose}>
      <div className="z-stack">
        <p>
          Your computer pushes the trusted commit to a new branch and opens a pull request. Nothing
          is merged.
        </p>
        <KeyValueList
          label="Pull request"
          items={[
            { key: "title", label: "Title", value: publication.title },
            { key: "branch", label: "Branch", value: <code>{publication.branch}</code> },
            {
              key: "base",
              label: "Into",
              value: publication.base ? (
                <code>{publication.base}</code>
              ) : (
                "the repository's default branch"
              ),
            },
          ]}
        />
        {error && <Notice tone="danger">{error}</Notice>}
        <Button block disabled={busy} onClick={onConfirm}>
          {busy ? "Starting…" : "Push and open pull request"}
        </Button>
        <Button block variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
