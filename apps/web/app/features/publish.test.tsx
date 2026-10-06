import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) =>
    state.data[getFunctionName(reference)],
}));

import {
  explainPublishFailure,
  type Publication,
  PublishConfirm,
  PublishStatus,
  PublishTask,
} from "./publish";
import { SessionView } from "./session-view";

const ready: Publication = {
  ready: true,
  status: "none",
  title: "Fix the login form",
  branch: "zamolxis/fix-the-login-form-a1b2c3d",
  base: "main",
};
const status = (publication: Publication) =>
  renderToStaticMarkup(createElement(PublishStatus, { publication, onPublish: () => {} }));

beforeEach(() => {
  state.data = {};
});

describe("publishing trusted work", () => {
  it("offers to open a pull request only for ready work", () => {
    expect(status(ready)).toContain("Open pull request");
    expect(status({ ...ready, ready: false })).toBe("");
  });

  it("confirms the branch, base and title before anything is pushed", () => {
    const html = renderToStaticMarkup(
      createElement(PublishConfirm, {
        publication: ready,
        busy: false,
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("zamolxis/fix-the-login-form-a1b2c3d");
    expect(html).toContain("<code>main</code>");
    expect(html).toContain("Fix the login form");
    expect(html).toContain("Nothing is merged.");
    expect(html).toContain("Push and open pull request");
  });

  it("shows pushing, the opened pull request, a compare link or the failure explained", () => {
    expect(status({ ...ready, status: "pending" })).toContain("Pushing…");
    const opened = status({
      ...ready,
      status: "published",
      prUrl: "https://github.com/team/repo/pull/5",
      compareUrl: "https://github.com/team/repo/compare/main...x",
    });
    expect(opened).toContain("Pull request opened");
    expect(opened).toContain('href="https://github.com/team/repo/pull/5"');
    expect(opened).toContain('rel="noopener noreferrer"');
    const pushed = status({
      ...ready,
      status: "published",
      compareUrl: "https://github.com/team/repo/compare/main...x",
    });
    expect(pushed).toContain("Create pull request");
    expect(pushed).toContain('href="https://github.com/team/repo/compare/main...x"');
    expect(status({ ...ready, status: "published", prUrl: "javascript:alert(1)" })).not.toContain(
      "javascript:",
    );
    const failed = status({ ...ready, status: "failed", error: "PUBLISH_PUSH_FAILED" });
    expect(failed).toContain("couldn&#x27;t push the branch");
    expect(failed).toContain("Try again");
    expect(explainPublishFailure("PUBLISH_GITHUB_TOKEN_MISSING")).toContain(
      "On your Mac, run pnpm zamolxis github-token",
    );
    for (const code of [
      "PUBLISH_GITHUB_TOKEN_INVALID",
      "PUBLISH_GITHUB_TOKEN_EXPIRED",
      "PUBLISH_GITHUB_NO_PUSH",
      "PUBLISH_GITHUB_UNREACHABLE",
      "PUBLISH_GITHUB_TOKEN_UNREADABLE",
    ])
      expect(explainPublishFailure(code)).not.toContain("Publishing failed:");
    expect(explainPublishFailure("WORKSPACE_MISSING")).toBe(
      "Publishing failed: workspace missing.",
    );
  });

  it("reads the publication for the task and appears on completed task cards", () => {
    state.data = { "integration:publication": ready };
    expect(
      renderToStaticMarkup(createElement(PublishTask, { taskId: "t" as Id<"tasks"> })),
    ).toContain("Open pull request");
    state.data = {
      "sessions:get": { _id: "s", title: "Session", status: "completed" },
      "supervisor:messages": [],
      "tasks:listBySession": [
        { _id: "t1", _creationTime: 1, title: "Done", status: "completed", phase: "completed" },
        { _id: "t2", _creationTime: 2, title: "Busy", status: "running", phase: "building" },
      ],
      "runs:listBySession": [],
      "integration:publication": ready,
    };
    const html = renderToStaticMarkup(
      createElement(SessionView, {
        sessionId: "s" as Id<"workSessions">,
        ready: true,
        indicator: null,
        notices: null,
        onBack: () => {},
        onOpen: () => {},
      }),
    );
    expect(html.match(/Open pull request/g)).toHaveLength(1);
    expect(html).toContain("merging stays with you");
  });
});
