export function tryJson(s?: string): any | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function pretty(s: any): string {
  try {
    const obj = typeof s === 'string' ? JSON.parse(s) : s;
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(s ?? '');
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

