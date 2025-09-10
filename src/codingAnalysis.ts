import { getTerminologyServerURL } from './helpers';

export type CodingEntry = {
  pointer: string;
  system?: string;
  code?: string;
  display?: string;
};

export type CodingReportItem = {
  pointer: string;
  original: { system?: string; code?: string; display?: string };
  status: 'ok' | 'recoding' | 'recoded' | 'unresolved';
  reason?: string;
  resourceType?: string;
  id?: string;
  resourceRef?: string;
};

function isObject(x: any): x is Record<string, any> {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function collectCodings(node: any, basePointer = ''): CodingEntry[] {
  const out: CodingEntry[] = [];
  const walk = (n: any, p: string) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach((item, i) => walk(item, `${p}/${i}`)); return; }
    if (!isObject(n)) return;

    if (Array.isArray(n.coding)) {
      n.coding.forEach((c: any, i: number) => {
        if (isObject(c)) out.push({ pointer: `${p}/coding/${i}`, system: c.system, code: c.code, display: c.display });
      });
    }
    const lastSeg = (p.split('/').filter(Boolean).pop() || '').toString();
    const lastKey = decodeURIComponent(lastSeg);
    const pointerSuggestsQuantity = /Quantity$/i.test(lastKey) || lastKey === 'low' || lastKey === 'high';
    const looksLikeQuantity = pointerSuggestsQuantity && Object.prototype.hasOwnProperty.call(n, 'value');
    if (!looksLikeQuantity && typeof n.system === 'string' && typeof n.code === 'string' && p) {
      out.push({ pointer: p, system: n.system, code: n.code, display: n.display });
    }

    for (const k of Object.keys(n)) {
      if (k === 'coding') continue;
      if (k.startsWith('_')) continue;
      walk(n[k], `${p}/${encodeURIComponent(k)}`);
    }
  };
  walk(node, basePointer || '');
  return out;
}

function normDisplay(s?: string): string {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function batchExists(items: Array<{ system?: string; code?: string }>): Promise<Array<{ system?: string; code?: string; exists: boolean; display?: string; normalizedSystem?: string }>> {
  const base = getTerminologyServerURL();
  const res = await fetch(`${base}/codes/exists`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items })
  });
  if (!res.ok) throw new Error(`codes/exists failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

export async function analyzeCodings(resources: any[]): Promise<{ report: CodingReportItem[]; recodePointers: string[] }> {
  const allEntries: Array<{ resIdx: number; entry: CodingEntry }> = [];
  resources.forEach((r: any, idx: number) => {
    const entries = collectCodings(r, '');
    entries.forEach(e => allEntries.push({ resIdx: idx, entry: e }));
  });

  const pairs = allEntries.map(({ entry }) => ({ system: entry.system, code: entry.code }));
  const exists = await batchExists(pairs);
  const report: CodingReportItem[] = [];
  const recodePointers: string[] = [];

  for (let i = 0; i < allEntries.length; i++) {
    const { resIdx, entry } = allEntries[i];
    const ex = exists[i] || { exists: false } as any;
    const original = { system: entry.system, code: entry.code, display: entry.display };
    const rt = resources[resIdx]?.resourceType;
    const rid = resources[resIdx]?.id;
    const resourceRef = rt ? `${rt}/${rid || ''}` : undefined;

    if (entry.system && entry.code && ex.exists) {
      const canonicalDisp = ex.display || '';
      const matches = normDisplay(canonicalDisp) === normDisplay(entry.display);
      if (matches) {
        report.push({ pointer: entry.pointer, original, status: 'ok', resourceType: rt, id: rid, resourceRef });
        continue;
      }
    }

    // Needs recoding (not found or display mismatch)
    recodePointers.push(entry.pointer);
    report.push({
      pointer: entry.pointer,
      original,
      status: 'recoding',
      reason: (entry.system && entry.code && ex.exists) ? 'display_mismatch' : 'not_found',
      resourceType: rt,
      id: rid,
      resourceRef
    });
  }

  return { report, recodePointers };
}

export function finalizeUnresolved(
  resources: any[],
  unresolvedPointers: string[],
  attemptLogs?: Record<string, { attempts: any[]; failureReason?: string } | undefined>
): any[] {
  const cloned = JSON.parse(JSON.stringify(resources));
  const seen = new Set(unresolvedPointers);
  const uniquePointers = Array.from(seen);
  const get = (root: any, pointer: string) => {
    const segs = pointer.split('/').filter(Boolean).map(s => decodeURIComponent(s));
    let cur = root;
    for (const s of segs) { if (!cur) return null; cur = Array.isArray(cur) ? cur[Number(s)] : cur[s]; }
    return cur && typeof cur === 'object' ? cur : null;
  };
  const EXT_URL = 'http://example.org/fhir/StructureDefinition/coding-issue';
  for (const p of uniquePointers) {
    for (const r of cloned) {
      const tgt = get(r, p);
      if (!tgt) continue;
      const proposed = (tgt as any)._proposed_coding || {};
      const potentials = ((tgt as any)._potential_displays || '').split(',').map((x: string) => x.trim()).filter(Boolean);
      const rt = (r as any)?.resourceType;
      const rid = (r as any)?.id;
      const resourceRef = rt ? `${rt}/${rid || ''}` : undefined;
      const compositeKey = resourceRef ? `${resourceRef}:${p}` : p;
      const log = attemptLogs?.[compositeKey];
      delete (tgt as any)._proposed_coding;
      delete (tgt as any)._potential_displays;
      delete (tgt as any)._potential_systems;
      delete (tgt as any)._potential_codes;
      const payload = {
        pointer: p,
        proposed: { system: proposed.system, display: proposed.display },
        potentials,
        queries: log?.attempts ? log.attempts.map(a => ({ query: a.query, hits: a.hitCount })) : undefined,
        attempts: log?.attempts ? compactAttempts(log.attempts) : undefined,
        failure: log?.failureReason,
        note: 'unresolved_after_recoding'
      };
      const ex: any = { url: EXT_URL, valueString: JSON.stringify(payload) };
      const curExt = Array.isArray((tgt as any).extension) ? (tgt as any).extension : [];
      const filtered = curExt.filter((e: any) => e?.url !== EXT_URL);
      filtered.push(ex);
      (tgt as any).extension = filtered;
    }
  }
  sweepLeftoverPlaceholders(cloned, EXT_URL);
  return cloned;
}

function compactAttempts(atts: any[]): any[] {
  return atts.slice(-3).map(a => ({
    query: a.query,
    systems: a.systems,
    hitCount: a.hitCount,
    sample: (a.sample || []).slice(0,3),
    decision: {
      action: a.decision?.action,
      terms: a.decision?.terms,
      reason: a.decision?.reason,
      selection: a.decision?.selection,
      justification: a.decision?.justification ? String(a.decision.justification).slice(0, 240) : undefined
    }
  }));
}

function sweepLeftoverPlaceholders(resources: any[], EXT_URL: string) {
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && (node._proposed_coding || node._potential_displays || node._potential_systems || node._potential_codes)) {
      const proposed = (node as any)._proposed_coding || {};
      const potentials = ((node as any)._potential_displays || '').split(',').map((x: string)=>x.trim()).filter(Boolean);
      delete (node as any)._proposed_coding;
      delete (node as any)._potential_displays;
      delete (node as any)._potential_systems;
      delete (node as any)._potential_codes;
      const payload = { proposed: { system: proposed.system, display: proposed.display }, potentials, note: 'unresolved_after_recoding' };
      const ex: any = { url: EXT_URL, valueString: JSON.stringify(payload) };
      const curExt = Array.isArray((node as any).extension) ? (node as any).extension : [];
      const filtered = curExt.filter((e: any) => e?.url !== EXT_URL);
      filtered.push(ex);
      (node as any).extension = filtered;
    }
    Object.keys(node).forEach(k => { if (!k.startsWith('_')) walk((node as any)[k]); });
  };
  resources.forEach(walk);
}

