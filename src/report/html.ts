// A deliberately small Markdown-subset renderer for exactly the
// constructs render.ts emits (# / ## headings, paragraphs, bullet
// lists, pipe tables, **bold**, _italic_) — output is ONE
// self-contained HTML file: inline <style>, zero external
// references (SPEC FR-10; asserted in tests).

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");

const isSeparatorRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

const STYLE = `
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  max-width: 880px; margin: 2rem auto; padding: 0 1rem; color: #1c1c1c;
  line-height: 1.55; }
h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.92rem; }
th, td { border: 1px solid #c9c9c9; padding: 0.35rem 0.6rem; text-align: left; }
th { background: #f2f2f2; }
td:nth-child(n+2) { font-variant-numeric: tabular-nums; }
ul { padding-left: 1.2rem; } li { margin: 0.3rem 0; }
`.trim();

export function renderHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let title = "Ledger Sloth — statement review";
  let i = 0;

  const startsBlock = (line: string): boolean =>
    line.startsWith("# ") ||
    line.startsWith("## ") ||
    line.startsWith("|") ||
    line.startsWith("- ");

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push(`<h2>${inline(line.slice(3))}</h2>`);
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      title = line.slice(2);
      blocks.push(`<h1>${inline(title)}</h1>`);
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (!isSeparatorRow(cells)) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        `<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${inline(para.join(" "))}</p>`);
  }

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    blocks.join("\n"),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
