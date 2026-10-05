import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Collapsible, Markdown, parseMarkdown, safeHref, Thinking } from "./index";

const html = (source: string) => renderToStaticMarkup(<Markdown>{source}</Markdown>);

describe("Markdown", () => {
  it("renders paragraphs and line breaks", () => {
    expect(html("one\ntwo\n\nthree")).toBe(
      '<div class="z-md"><p>one<br/>two</p><p>three</p></div>',
    );
  });

  it("renders inline code, bold and italic", () => {
    expect(html("Run `pnpm test` **now** and *carefully*")).toBe(
      '<div class="z-md"><p>Run <code>pnpm test</code> <strong>now</strong> and <em>carefully</em></p></div>',
    );
    expect(html("__strong__ and _soft_")).toContain("<strong>strong</strong> and <em>soft</em>");
  });

  it("keeps snake_case identifiers and lone markers literal", () => {
    expect(html("use snake_case_name and 2 * 3")).toContain("use snake_case_name and 2 * 3");
    expect(html("**unclosed")).toContain("**unclosed");
  });

  it("renders fenced code blocks verbatim without parsing markdown inside", () => {
    const out = html("Before\n```ts\nconst a = **b**;\n<b>x</b>\n```\nAfter");
    expect(out).toContain(
      '<pre class="z-md__code" data-language="ts"><code>const a = **b**;\n&lt;b&gt;x&lt;/b&gt;</code></pre>',
    );
    expect(out).toContain("<p>After</p>");
  });

  it("treats an unclosed fence as code until the end", () => {
    expect(parseMarkdown("```\nopen")).toEqual([{ type: "code", text: "open" }]);
  });

  it("renders bullet and numbered lists", () => {
    expect(html("- one\n- **two**\n  continued")).toBe(
      '<div class="z-md"><ul><li>one</li><li><strong>two</strong><br/>continued</li></ul></div>',
    );
    expect(html("1. first\n2. second")).toBe(
      '<div class="z-md"><ol><li>first</li><li>second</li></ol></div>',
    );
    expect(html("3. third\n4. fourth")).toContain('<ol start="3">');
  });

  it("renders headings as bold text, not heading elements", () => {
    const out = html("## Summary\nDone");
    expect(out).toContain('<p class="z-md__heading"><strong>Summary</strong></p>');
    expect(out).not.toMatch(/<h\d/);
  });

  it("renders http(s) links safely", () => {
    expect(html("[PR](https://github.com/o/r/pull/1)")).toContain(
      '<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">PR</a>',
    );
    expect(html("See https://example.com/a.")).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.',
    );
  });

  it("renders javascript: and other non-http links as text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "/relative",
    ]) {
      const out = html(`[click](${href})`);
      expect(out).not.toContain("<a");
      expect(out).toContain("[click]");
    }
    expect(html("javascript:alert(1)")).not.toContain("<a");
    expect(safeHref(" javascript:alert(1)")).toBeUndefined();
    expect(safeHref("https://ok.example")).toBe("https://ok.example/");
  });

  it("renders raw HTML, including script tags, as text", () => {
    const out = html('<script>alert("x")</script>\n<img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes markup inside link text", () => {
    const out = html('[<b onclick="x">t</b>](https://example.com)');
    expect(out).toContain("&lt;b onclick=&quot;x&quot;&gt;t&lt;/b&gt;</a>");
  });
});

describe("Thinking and Collapsible", () => {
  it("announces thinking as a status", () => {
    const out = renderToStaticMarkup(<Thinking detail="Reading the repository" />);
    expect(out).toContain('role="status"');
    expect(out).toContain("Thinking…");
    expect(out).toContain("Reading the repository");
  });

  it("offers an accessible toggle when content is likely long", () => {
    const out = renderToStaticMarkup(<Collapsible likelyLong>body</Collapsible>);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("aria-controls=");
    expect(out).toContain("Show more");
    expect(out).toContain("z-collapsible__body--clamped");
    expect(renderToStaticMarkup(<Collapsible>short</Collapsible>)).not.toContain("Show more");
  });
});
