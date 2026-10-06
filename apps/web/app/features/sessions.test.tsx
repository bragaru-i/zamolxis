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
              label: "builder: Fix totals",
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
    return undefined;
  },
}));

import { SessionList } from "./sessions";

it("renders the global answer and its linked session separately from the sessions list", () => {
  const html = renderToStaticMarkup(
    createElement(SessionList, {
      ready: true,
      indicator: null,
      notices: null,
      onOpen: vi.fn(),
      onSettings: vi.fn(),
    }),
  );
  expect(html).toContain("Orchestrator");
  expect(html).toContain("What is going on?");
  expect(html).toContain("Answered without opening work");
  expect(html).toContain("Alpha readiness · needs_input");
  expect(html).toContain("builder: Fix totals · running");
  expect(html).toContain('href="https://github.com/acme/shop/pull/7"');
  expect(html).not.toContain("PR: Unsafe");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Proposed work, nothing started · gpt-x · 1,234 tokens");
  expect(html).toContain("Fix checkout totals rounding.");
  expect(html).toContain("Open this work");
  expect(html).toContain("Writing a reply…");
  expect(html).toContain("the Orchestrator is writing a reply");
  expect(html).toContain("No work sessions yet");
  expect(html).toContain("Ask Zamolxis, or tell it to start work");
});
