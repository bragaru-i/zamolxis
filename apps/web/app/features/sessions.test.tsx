import { getFunctionName } from "convex/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
  useQuery: (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    if (name === "orchestrator:messages")
      return [
        {
          _id: "message",
          text: "What is going on?",
          reply: "One session needs your input. I did not open a new Work Session.",
          route: "answer",
          links: [
            {
              _id: "link",
              targetType: "session",
              targetId: "session",
              workSessionId: "session",
              label: "Alpha readiness",
              status: "needs_input",
            },
            {
              _id: "run-link",
              targetType: "run",
              targetId: "run",
              workSessionId: "session",
              label: "Building: Fix totals",
              status: "running",
            },
            {
              _id: "pr-link",
              targetType: "pull_request",
              targetId: "task",
              workSessionId: "session",
              label: "PR: Fix totals",
              url: "https://github.com/acme/shop/pull/7",
            },
            {
              _id: "unsafe-link",
              targetType: "pull_request",
              targetId: "task-2",
              workSessionId: "session",
              label: "PR: Unsafe",
              url: "javascript:alert(1)",
            },
          ],
        },
        {
          _id: "proposal",
          text: "What should we do about checkout?",
          reply: "Totals look wrong.",
          route: "propose",
          status: "answered",
          answeredBy: "model",
          modelActual: "gpt-x",
          totalTokens: 1234,
          proposal: "Fix checkout totals rounding.",
          productId: "product",
          repositoryId: "repository",
          createdAt: Date.now(),
          links: [],
        },
        {
          _id: "thinking",
          text: "Anything blocked?",
          reply: "One session needs your input.",
          route: "answer",
          status: "thinking",
          createdAt: Date.now(),
          links: [],
        },
      ];
    if (name === "supervisor:products") return [];
    if (name === "repositories:computers")
      return [
        { workstationId: "w1", name: "MacBook", online: true, runtimes: ["codex", "claude"] },
        { workstationId: "w2", name: "Linux box", online: false, runtimes: [] },
      ];
    if (name === "orchestrator:conversations")
      return [
        { _id: "c1", title: "What is going on?", lastActivityAt: Date.now(), createdAt: 1 },
        {
          _id: "c2",
          title: "How does the verifier work?",
          lastActivityAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
          createdAt: 1,
        },
      ];
    return undefined;
  },
}));

import { computerDescription, SessionList } from "./sessions";

it("describes a computer by whether it is online and which agents it has", () => {
  expect(computerDescription({ online: true, runtimes: ["codex"] })).toBe("Online · Codex");
  expect(computerDescription({ online: false, runtimes: [] })).toBe("Offline · no agent");
});

it("renders the global answer and its linked session separately from the sessions list", () => {
  const html = renderToStaticMarkup(
    createElement(SessionList, {
      ready: true,
      indicator: null,
      notices: null,
      chatId: "c1",
      onOpenChat: vi.fn(),
      onOpen: vi.fn(),
      onSettings: vi.fn(),
    }),
  );
  expect(html).toContain("Orchestrator");
  expect(html).toContain("z-chat-timeline");
  expect(html).toContain("z-chat-timeline__marker");
  expect(html).toContain("+ New chat");
  expect(html).toContain("z-home-nav__scroll");
  expect(html).toContain("z-home-nav__connection");
  expect(html).toContain(">Today<");
  expect(html).toContain(">Previous 7 days<");
  expect(html).toContain("How does the verifier work?");
  expect(html).toMatch(/z-home-session z-home-session--active[^>]*aria-current="page"/);
  expect(html).toContain("What is going on?");
  expect(html).toContain(">Answer<");
  expect(html).toMatch(/Alpha readiness<\/span><span class="z-chip__status">Needs you</);
  expect(html).not.toContain("needs_input");
  expect(html).toMatch(/Building: Fix totals<\/span><span class="z-chip__status">Running</);
  expect(html).toContain('href="https://github.com/acme/shop/pull/7"');
  expect(html).not.toContain("PR: Unsafe");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Suggestion, nothing started yet · gpt-x");
  expect(html).not.toContain("1,234 tokens");
  expect(html).toContain("Fix checkout totals rounding.");
  expect(html).toContain("Review proposal");
  expect(html).toContain("Open Work Session and start planning");
  // Two computers have the repository: the owner may choose where the work runs.
  expect(html).toContain("Run on");
  expect(html).toContain("Any online computer");
  expect(html).toContain("Online · Codex, Claude");
  expect(html).toContain("Offline · no agent");
  expect(html).toContain("Writing a reply…");
  expect(html).toContain("a fuller answer is on its way");
  expect(html).toContain("No Work Sessions yet");
  expect(html).toContain("Sending a message does not start work");
  expect(html).toContain("Ask Zamolxis");
});

it("opens as a new, empty chat with earlier chats in the sidebar", () => {
  const html = renderToStaticMarkup(
    createElement(SessionList, {
      ready: true,
      indicator: null,
      notices: null,
      chatId: "",
      onOpenChat: vi.fn(),
      onOpen: vi.fn(),
      onSettings: vi.fn(),
    }),
  );
  expect(html).toContain(">New chat<");
  expect(html).not.toContain("What should we do about checkout?");
  expect(html).not.toContain("Loading conversation");
  expect(html).toContain("Earlier chats are in the sidebar.");
  expect(html).toContain("What is going on?");
  expect(html).toMatch(/z-home-link z-home-link--active[^>]*aria-current="page"/);
});
