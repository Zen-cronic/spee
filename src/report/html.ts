// Minimal Markdown-to-HTML for the report (headings, tables, lists, code, quotes, bold/italic/code spans).
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) =>
  escHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");

export function mdToHtml(md: string, title: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) buf.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4}) (.*)$/);
    if (h) {
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = lines[i]!.slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      out.push(
        `<div class="t"><table><thead><tr>${rows[0]!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .slice(1)
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^(- |\d+\. )/.test(l)) {
      const ordered = /^\d+\. /.test(l);
      const items: string[] = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i]!)) items.push(lines[i++]!.replace(/^(- |\d+\. )/, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (l.startsWith("> ")) {
      out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`);
      i++;
      continue;
    }
    if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    i++;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:16px;color:#1d1d1f}h1{font-size:1.5em}h2{margin-top:2em;border-bottom:1px solid #ddd}
.t{overflow-x:auto}table{border-collapse:collapse;font-size:13px;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}th{background:#f3f3f3}
blockquote{border-left:4px solid #e0a800;background:#fff8e1;margin:8px 0;padding:8px 12px}pre{background:#f6f6f6;padding:8px;overflow-x:auto;font-size:12px}code{background:#f1f1f1;padding:0 3px}</style>
</head><body>${out.join("\n")}</body></html>`;
}
