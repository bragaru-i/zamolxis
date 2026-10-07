import { describe, expect, it } from "vitest";
import { acceptanceEvidence, parseAcceptance } from "./acceptance";

describe("the reviewer's verdict per acceptance point", () => {
  it("fails on a point not met, naming it and where the reviewer looked", () => {
    const reply = `The palette input uses cmdk, but nothing opens it.
\`\`\`json
{"acceptance":[
  {"point":"Opens with Cmd/Ctrl+K","met":false,"where":"no shortcut in workspace.tsx"},
  {"point":"Shows actions and chats","met":false,"where":"only the old session filter"},
  {"point":"Sidebar search removed","met":true,"where":"sessions.tsx"}
]}
\`\`\``;
    expect(acceptanceEvidence(reply)).toEqual({
      modality: "acceptance",
      result: "failed",
      summary:
        "Not met: Opens with Cmd/Ctrl+K (no shortcut in workspace.tsx); Shows actions and chats (only the old session filter)",
    });
  });

  it("passes when every point is met", () => {
    expect(
      acceptanceEvidence(
        '{"acceptance":[{"point":"Button removed","met":true,"where":"sessions.tsx"}]}',
      ),
    ).toMatchObject({
      result: "passed",
      summary: "All 1 checked acceptance point met: Button removed (sessions.tsx)",
    });
    // A point the reviewer could not judge from the repository never blocks.
    expect(
      acceptanceEvidence(
        '{"acceptance":[{"point":"File created","met":true},{"point":"No Git commands run","met":null,"where":"not visible in a commit"}]}',
      ),
    ).toMatchObject({
      result: "passed",
      summary:
        "All 1 checked acceptance point met: File created; could not check: No Git commands run (not visible in a commit)",
    });
    expect(acceptanceEvidence('{"acceptance":[{"point":"x","met":null}]}')).toBeUndefined();
  });

  it("adds nothing for a reply without a usable verdict", () => {
    for (const reply of [
      undefined,
      "Looks good to me.",
      '{"acceptance":[]}',
      '{"acceptance":[{"point":"x","met":"yes"}]}',
      '{"decision":"answer"}',
    ])
      expect(acceptanceEvidence(reply)).toBeUndefined();
    // Malformed entries are skipped; the rest count.
    expect(
      parseAcceptance('{"acceptance":[{"point":"","met":true},{"point":"A","met":true}]}'),
    ).toEqual([{ point: "A", met: true, where: "" }]);
  });
});
