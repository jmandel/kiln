import { Database } from 'bun:sqlite';

// Type definitions
export interface TerminologyHit {
  system: string;
  code: string;
  display: string;
  score?: number;
}

export interface TerminologyCapabilities {
  supportedSystems: string[];
  bigSystems?: string[];
  builtinFhirCodeSystems?: string[];
}

// SqliteTerminologySearch implementation
export class SqliteTerminologySearch {
  private db: Database;
  private systemsCache: string[] | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  private tokenize(s: string): string[] {
    return s
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 2);
  }

  private levenshtein(a: string, b: string): number {
    const al = a.length,
      bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const prev = new Array(bl + 1),
      curr = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      curr[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= bl; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= bl; j++) prev[j] = curr[j];
    }
    return prev[bl];
  }

  async search(query: string, opts?: { systems?: string[]; limit?: number }): Promise<TerminologyHit[]> {
    const limit = typeof opts?.limit === 'number' ? opts.limit : 20;
    const requested = (opts?.systems ?? []).map((s) =>
      s.startsWith('http') ? s
      : s.toLowerCase() === 'loinc' ? 'http://loinc.org'
      : s.toLowerCase().startsWith('snomed') ? 'http://snomed.info/sct'
      : s.toLowerCase() === 'rxnorm' ? 'http://www.nlm.nih.gov/research/umls/rxnorm'
      : s
    );
    const systems = await this.expandRequestedSystems(requested);

    // Simple FTS query - just the search terms, no field prefix
    const sanitized = String(query || '').trim();
    if (!sanitized) return [];

    // Query designations FTS table to find matching concepts
    let sql = `
      SELECT DISTINCT c.system, c.code, c.display, bm25(designations_fts) AS rank
      FROM designations_fts 
      JOIN designations d ON d.id = designations_fts.rowid
      JOIN concepts c ON c.id = d.concept_id
      WHERE designations_fts MATCH ?`;

    // Build a conservative FTS expression (quoted OR of tokens) and bind safely
    const ftsExpr = this.buildFtsExpr(sanitized);
    const params: any[] = [ftsExpr];

    if (systems.length) {
      sql += ` AND c.system IN (${systems.map(() => '?').join(',')})`;
      params.push(...systems);
    }

    sql += ` ORDER BY rank ASC LIMIT ?`;
    params.push(limit);

    try {
      const stmt = this.db.query<any>(sql);
      const rows = stmt.all(...params);
      return rows.map(
        (r: any) =>
          ({
            system: r.system,
            code: String(r.code),
            display: String(r.display ?? ''),
            score: Number(r.rank),
          }) as TerminologyHit
      );
    } catch (err) {
      console.error('Search error:', err);
      return [];
    }
  }

  // Build a conservative FTS expression from free text: quoted OR of tokens
  private buildFtsExpr(q: string): string {
    const toks = this.tokenize(q);
    if (!toks.length) return '""';
    const parts = toks.map((t) => `"${t.replace(/"/g, '""')}"`);
    return parts.join(' OR ');
  }

  // Wrapper that adds guidance for poor results and small-system fallbacks
  async searchWithGuidance(query: string, opts?: { systems?: string[]; limit?: number }) {
    const tokens = this.tokenize(query);
    const requested = (opts?.systems ?? []).map((s) =>
      s.startsWith('http') ? s
      : s.toLowerCase() === 'loinc' ? 'http://loinc.org'
      : s.toLowerCase().startsWith('snomed') ? 'http://snomed.info/sct'
      : s.toLowerCase() === 'rxnorm' ? 'http://www.nlm.nih.gov/research/umls/rxnorm'
      : s
    );
    const sys = await this.expandRequestedSystems(requested);
    const hits = await this.search(query, opts);

    // Small vocabulary fallback: only when zero hits for a single small system
    if (sys.length === 1) {
      const systemSize = this.getSystemSize(sys[0]);
      if (hits.length === 0 && systemSize > 0 && systemSize <= 200) {
        const allConcepts = this.getAllSystemConcepts(sys[0], query, Math.max(systemSize, opts?.limit ?? 200));
        return {
          query,
          hits: allConcepts,
          count: allConcepts.length,
          fullSystem: true,
          guidance: `No matches for "${query}" in a small code system (${systemSize} concepts). Returning the complete list so you can choose a valid code from it.`,
        };
      }
    }

    // Determine if we need guidance
    let guidance: string | undefined;

    if (hits.length === 0) {
      guidance = 'No matches found. Try fewer or different terms — your search may contain incorrect terminology.';
    } else if (hits.length < 3 && tokens.length > 3) {
      guidance = 'Limited results found. Consider using fewer or more general terms.';
    }

    return {
      query,
      hits: hits.map((h) => ({
        system: h.system,
        code: h.code,
        display: h.display,
        score: h.score,
      })),
      count: hits.length,
      ...(guidance ? { guidance } : {}),
    };
  }

  private getSupportedSystems(): string[] {
    if (this.systemsCache) return this.systemsCache;
    try {
      // Prefer code_systems table if present
      const list = this.db.query<{ system: string }>(`SELECT system FROM code_systems`).all();
      this.systemsCache = list.map((r) => r.system);
      if (this.systemsCache.length) return this.systemsCache;
    } catch {}
    try {
      const list = this.db.query<{ system: string }>(`SELECT DISTINCT system FROM concepts`).all();
      this.systemsCache = list.map((r) => r.system);
      return this.systemsCache;
    } catch {
      this.systemsCache = [];
      return this.systemsCache;
    }
  }

  private codeSegment(url: string): string {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (!parts.length) return '';
      const idxCS = parts.findIndex((p) => p.toLowerCase() === 'codesystem');
      if (idxCS >= 0 && idxCS + 1 < parts.length) return parts[idxCS + 1].toLowerCase();
      return parts[parts.length - 1].toLowerCase();
    } catch {
      // Not a URL; fall back to last segment-like
      const parts = url.split('/').filter(Boolean);
      return (parts[parts.length - 1] || '').toLowerCase();
    }
  }

  private async expandRequestedSystems(systems: string[]): Promise<string[]> {
    const supported = new Set(this.getSupportedSystems());
    if (!systems.length) return [];
    const out = new Set<string>();

    for (const s of systems) {
      const norm = s.trim();
      if (!norm) continue;
      if (supported.has(norm)) {
        out.add(norm);
        continue;
      }

      // Heuristic: HL7 FHIR alias to THO CodeSystem URL
      try {
        const u = new URL(norm);
        const last = this.codeSegment(norm);
        if (u.hostname.endsWith('hl7.org') && (u.pathname.includes('/fhir/') || u.pathname.includes('/ValueSet/'))) {
          const tho = `http://terminology.hl7.org/CodeSystem/${last}`;
          if (supported.has(tho)) {
            out.add(tho);
            continue;
          }
        }
      } catch {}

      // Otherwise choose closest supported by code segment (edit distance)
      let best: { sys: string; dist: number } | null = null;
      const target = this.codeSegment(norm);
      for (const sup of supported) {
        const seg = this.codeSegment(sup);
        const d = this.levenshtein(target, seg);
        if (!best || d < best.dist) best = { sys: sup, dist: d };
      }
      if (best) {
        const maxAllow = Math.max(2, Math.ceil(Math.min(target.length, best.sys.length || 1) * 0.34));
        if (best.dist <= maxAllow) {
          out.add(best.sys);
        }
      }
    }

    return Array.from(out);
  }

  async capabilities(): Promise<TerminologyCapabilities> {
    try {
      const rows = this.db
        .query<{
          system: string;
          cnt: number;
        }>(`SELECT system, COUNT(*) as cnt FROM concepts GROUP BY system`)
        .all();
      const supported = rows.map((r) => r.system);
      const big = rows.filter((r) => (r.cnt ?? 0) > 500).map((r) => r.system);
      const builtin = supported.filter(
        (s) => s.startsWith('http://terminology.hl7.org/CodeSystem/') || s.startsWith('http://hl7.org/fhir/sid/')
      );
      return { supportedSystems: supported, bigSystems: big, builtinFhirCodeSystems: builtin };
    } catch {
      return { supportedSystems: [], bigSystems: [], builtinFhirCodeSystems: [] };
    }
  }

  normalizeSystem(input?: string): string | undefined {
    if (!input) return undefined;

    // First check common aliases
    const lowered = input.toLowerCase();
    if (lowered === 'loinc') return 'http://loinc.org';
    if (lowered === 'snomed' || lowered.startsWith('snomed')) return 'http://snomed.info/sct';
    if (lowered === 'rxnorm') return 'http://www.nlm.nih.gov/research/umls/rxnorm';

    const supported = new Set(this.getSupportedSystems());
    if (supported.has(input)) return input;

    // Try THO mapping for hl7.org/fhir/...
    try {
      const u = new URL(input);
      const last = this.codeSegment(input);
      if (u.hostname.endsWith('hl7.org')) {
        const tho = `http://terminology.hl7.org/CodeSystem/${last}`;
        if (supported.has(tho)) return tho;
      }
    } catch {}

    // Choose closest by segment edit distance
    const target = this.codeSegment(input);
    let best: { sys: string; dist: number } | null = null;
    for (const sup of supported) {
      const seg = this.codeSegment(sup);
      const d = this.levenshtein(target, seg);
      if (!best || d < best.dist) best = { sys: sup, dist: d };
    }
    if (best) {
      const maxAllow = Math.max(2, Math.ceil(Math.min(target.length, best.sys.length || 1) * 0.34));
      if (best.dist <= maxAllow) return best.sys;
    }
    return undefined; // Return undefined if no match found
  }

  private getSystemSize(system: string): number {
    try {
      const result = this.db
        .query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM concepts WHERE system = ?`)
        .get(system);
      return result?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  private getAllSystemConcepts(system: string, query: string, limit: number = 150): TerminologyHit[] {
    try {
      const rows = this.db
        .query<any>(`SELECT system, code, display FROM concepts WHERE system = ? LIMIT ?`)
        .all(system, limit);

      // Rank by similarity to query
      const queryLower = query.toLowerCase();
      const ranked = rows.map((r) => {
        const display = String(r.display ?? '');
        const displayLower = display.toLowerCase();

        // Calculate Levenshtein distance
        const distance = this.levenshtein(queryLower, displayLower);
        const maxLen = Math.max(query.length, display.length, 1);
        const similarity = 1 - distance / maxLen;

        return {
          system: r.system,
          code: String(r.code),
          display,
          score: similarity,
        };
      });

      // Sort by similarity score descending
      return ranked.sort((a, b) => b.score - a.score);
    } catch {
      return [];
    }
  }

  getDb(): Database {
    return this.db;
  }
}
