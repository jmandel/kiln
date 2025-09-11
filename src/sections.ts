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

export function renderSectionNarrative(noteText: string, sectionTitle: string): string | undefined {
  const sections = extractSections(noteText);
  const content = sections.get(canonicalizeHeader(sectionTitle));
  if (content == null) return undefined;
  const escaped = content
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>' );
  return `<div xmlns="http://www.w3.org/1999/xhtml">${escaped}</div>`;
}
