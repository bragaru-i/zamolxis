import type { ReactNode } from "react";

/*
 * Safe Markdown subset for agent and Supervisor replies.
 *
 * The source is parsed into a small tree and rendered as React elements, so every piece of
 * text is escaped by React. Raw HTML is never interpreted and links are limited to http(s).
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; children: Inline[] }
  | { type: "code"; text: string; language?: string }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", children: inlineLines(paragraph) });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const closing = candidate.trim();
        if (
          closing.length >= marker.length &&
          closing[0] === marker[0] &&
          /^(?:`+|~+)$/.test(closing)
        ) {
          break;
        }
        body.push(candidate);
        index += 1;
      }
      index += 1; // Skip the closing fence (or step past the end).
      const language = fence[2];
      blocks.push({ type: "code", text: body.join("\n"), ...(language ? { language } : {}) });
      continue;
    }
    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", children: parseInline(heading[1] ?? "") });
      index += 1;
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const pattern = ordered ? NUMBERED : BULLET;
      const start = numbered ? Number(numbered[1]) : 1;
      const items: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = pattern.exec(current);
        if (match) {
          items.push([(ordered ? match[2] : match[1]) ?? ""]);
        } else if (
          current.trim() !== "" &&
          /^\s/.test(current) &&
          !FENCE.test(current) &&
          !(ordered ? BULLET : NUMBERED).test(current)
        ) {
          // Indented continuation of the previous item.
          items[items.length - 1]?.push(current.trim());
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ type: "list", ordered, start, items: items.map(inlineLines) });
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}

function inlineLines(lines: string[]): Inline[] {
  const result: Inline[] = [];
  lines.forEach((line, position) => {
    if (position > 0) result.push({ type: "break" });
    result.push(...parseInline(line));
  });
  return result;
}

export function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  if (!/^https?:\/\//i.test(href)) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let buffer = "";
  const push = (node: Inline) => {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
    nodes.push(node);
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index];
    if (
      char === "\\" &&
      index + 1 < text.length &&
      /[\\`*_[\]()#+\-.!>]/.test(text[index + 1] ?? "")
    ) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`";
      const close = text.indexOf(ticks, index + ticks.length);
      if (close !== -1) {
        push({ type: "code", text: text.slice(index + ticks.length, close).trim() || " " });
        index = close + ticks.length;
        continue;
      }
      buffer += ticks;
      index += ticks.length;
      continue;
    }
    if (char === "[") {
      const link = /^\[([^\]]*)\]\(\s*([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\s*\)/.exec(rest);
      if (link) {
        const href = safeHref(link[2] ?? "");
        if (href) push({ type: "link", href, children: parseInline(link[1] ?? "") });
        else buffer += link[0];
        index += link[0].length;
        continue;
      }
    }
    if ((char === "h" || char === "H") && (index === 0 || /[\s(]/.test(text[index - 1] ?? ""))) {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        const url = bare[0].replace(/[.,;:!?)]+$/, "");
        const href = safeHref(url);
        if (href) {
          push({ type: "link", href, children: [{ type: "text", text: url }] });
          index += url.length;
          continue;
        }
      }
    }
    if (char === "*" || char === "_") {
      const double = text[index + 1] === char;
      const marker = double ? char + char : char;
      const before = text[index - 1] ?? "";
      const after = text[index + marker.length] ?? "";
      // Underscores inside words (snake_case) are literal.
      const opens = after !== "" && !/\s/.test(after) && (char === "*" || !/\w/.test(before));
      if (opens) {
        const close = findClose(text, marker, index + marker.length);
        if (close !== -1) {
          const inner = parseInline(text.slice(index + marker.length, close));
          push(double ? { type: "strong", children: inner } : { type: "em", children: inner });
          index = close + marker.length;
          continue;
        }
      }
      buffer += marker;
      index += marker.length;
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (buffer) nodes.push({ type: "text", text: buffer });
  return nodes;
}

function findClose(text: string, marker: string, from: number): number {
  let position = text.indexOf(marker, from);
  while (position !== -1) {
    const before = text[position - 1] ?? "";
    const after = text[position + marker.length] ?? "";
    const single = marker.length === 1;
    const doubled = single && (after === marker || before === marker);
    const wordy = marker[0] === "_" && /\w/.test(after);
    if (position > from && !/\s/.test(before) && !doubled && !wordy) return position;
    position = text.indexOf(marker, position + (doubled ? 2 : 1));
  }
  return -1;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
        return <br key={key} />;
      case "code":
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
        return <code key={key}>{node.text}</code>;
      case "strong":
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
        return <strong key={key}>{renderInline(node.children)}</strong>;
      case "em":
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
        return <em key={key}>{renderInline(node.children)}</em>;
      case "link":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={key}>{renderInline(block.children)}</p>;
    case "heading":
      return (
        <p key={key} className="z-md__heading">
          <strong>{renderInline(block.children)}</strong>
        </p>
      );
    case "code":
      return (
        <pre key={key} className="z-md__code" data-language={block.language}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, position) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content.
        <li key={position}>{renderInline(item)}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    default:
      return null;
  }
}

/** Renders a safe Markdown subset with the shared conversation typeset. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `z-md ${className}` : "z-md"}>
      {parseMarkdown(children).map(renderBlock)}
    </div>
  );
}
