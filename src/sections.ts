// Utilities for parsing Markdown note sections and stitching XHTML narratives

export function canonicalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Capture each H2 section (## Title) through the next H2 or end-of-text.
// Supports both LF and CRLF newlines.
// Fixed: match H2 across LF/CRLF; avoid multiline '$' early termination
export const H2_SECTION_REGEX = /(?:^|\r?\n)##\s*(.*?)\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/g;

export function extractSections(noteText: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = H2_SECTION_REGEX.exec(noteText)) !== null) {
    const title = (m[1] || '').trim();
    const content = (m[2] || '').trim();
    map.set(canonicalizeHeader(title), content);
  }
  return map;
}

import { marked } from 'marked';

export function renderSectionNarrative(noteText: string, sectionTitle: string): string | undefined {
  const sections = extractSections(noteText);
  const content = sections.get(canonicalizeHeader(sectionTitle));
  if (content == null) return undefined;

  // Keep options minimal to satisfy current marked typings
  marked.setOptions({ gfm: true, breaks: false } as any);
  const html = marked.parse(content) as string;

  const xhtml = simpleSanitize(html)
    .replace(/<br\s*>/gi,'<br/>')
    .replace(/<hr\s*>/gi,'<hr/>')
    .trim();
  return `<div xmlns="http://www.w3.org/1999/xhtml">${xhtml}</div>`;
}

// Minimal sanitizer sufficient for our Markdown output: remove dangerous tags and attributes,
// keep only basic formatting elements commonly produced by marked.
function simpleSanitize(html: string): string {
  let out = String(html || '');
  // Drop dangerous element blocks
  out = out.replace(/<\s*(script|iframe|object|embed|style)[\s\S]*?<\/\s*\1\s*>/gi, '');
  // Drop self-closing dangerous elements
  out = out.replace(/<\s*(script|iframe|object|embed|style)[^>]*\/>/gi, '');
  // Drop images entirely
  out = out.replace(/<img\b[^>]*>/gi, '');
  // Strip event handler attributes and style attributes from all tags
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Constrain <a href> to safe schemes
  out = out.replace(/<a\b([^>]*?)>/gi, (m, attrs) => {
    // Remove all attributes except href and name
    let hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    let nameMatch = /\bname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    let href = hrefMatch ? (hrefMatch[2] || hrefMatch[3] || hrefMatch[4] || '') : '';
    const safe = /^(https?:|mailto:)/i.test(href) ? href : '';
    const name = nameMatch ? (nameMatch[2] || nameMatch[3] || nameMatch[4] || '') : '';
    const parts: string[] = [];
    if (safe) parts.push(`href="${escapeAttr(safe)}"`);
    if (name) parts.push(`name="${escapeAttr(name)}"`);
    return `<a ${parts.join(' ')}>`;
  });
  // Remove unknown tags by whitelisting allowed tag names via a simple pass: keep tag names and angle brackets as-is for allowed tags; strip others.
  const allowed = new Set(['div','p','span','b','strong','i','em','u','sub','sup','br','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','h1','h2','h3','h4','h5','h6','a']);
  out = out.replace(/<\/?([a-z0-9]+)(\b[^>]*)?>/gi, (m, name) => {
    return allowed.has(String(name).toLowerCase()) ? m : '';
  });
  return out;
}

function escapeAttr(s: string): string { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
