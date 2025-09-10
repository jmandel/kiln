#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "crypto";

// Type definitions
interface TerminologyHit {
  system: string;
  code: string;
  display: string;
  score?: number;
}

interface TerminologyCapabilities {
  supportedSystems: string[];
  bigSystems?: string[];
  builtinFhirCodeSystems?: string[];
}

// Inline SqliteTerminologySearch implementation
class SqliteTerminologySearch {
  private db: Database;
  private systemsCache: string[] | null = null;
  
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  private tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/g).filter(t => t.length >= 2);
  }

  private buildFtsQueryAnd(tokens: string[]): string {
    if (!tokens.length) return "";
    return tokens.map(t => `${t}*`).join(" AND ");
  }

  private escapeLike(lit: string): string {
    return lit.replace(/([%_])/g, "\\$1");
  }

  private jaccard(aTokens: string[], bTokens: string[]): number {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const uni = a.size + b.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }

  private levenshtein(a: string, b: string): number {
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const prev = new Array(bl + 1), curr = new Array(bl + 1);
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

  private fuzzyScore(query: string, text: string): number {
    const qTok = this.tokenize(query);
    const tTok = this.tokenize(text);
    const jac = this.jaccard(qTok, tTok);
    const ld = this.levenshtein(query.toLowerCase(), text.toLowerCase());
    const sim = 1 - ld / Math.max(query.length, text.length, 1);
    return 0.65 * jac + 0.35 * sim;
  }

  async search(query: string, opts?: { systems?: string[]; limit?: number }): Promise<TerminologyHit[]> {
    // KISS: Leverage FTS5 over display field only. Let FTS ranking (bm25) drive order.
    const limit = typeof opts?.limit === 'number' ? opts.limit : 20;
    const requested = (opts?.systems ?? []).map(s =>
      s.startsWith('http') ? s :
      s.toLowerCase() === 'loinc' ? 'http://loinc.org' :
      s.toLowerCase().startsWith('snomed') ? 'http://snomed.info/sct' :
      s.toLowerCase() === 'rxnorm' ? 'http://www.nlm.nih.gov/research/umls/rxnorm' : s
    );
    const systems = await this.expandRequestedSystems(requested);

    // Build a simple FTS query scoped to display: pass through tokens, no wildcards or custom AND logic
    const sanitized = String(query || '').replace(/"/g, '');
    const fts = sanitized.trim() ? `display : ${sanitized}` : '';
    if (!fts) return [];

    let sql = `
      SELECT c.system, c.code, c.display, bm25(concepts_fts) AS rank
      FROM concepts_fts JOIN concepts c ON c.id = concepts_fts.rowid
      WHERE concepts_fts MATCH ?`;
    const params: any[] = [fts];
    if (systems.length) {
      sql += ` AND c.system IN (${systems.map(() => '?').join(',')})`;
      params.push(...systems);
    }
    sql += ` ORDER BY rank ASC LIMIT ?`;
    params.push(limit);

    try {
      const stmt = this.db.query<any>(sql);
      const rows = stmt.all(...params);
      return rows.map((r: any) => ({
        system: r.system,
        code: String(r.code),
        display: String(r.display ?? ''),
        score: Number(r.rank)
      } as TerminologyHit));
    } catch {
      return [];
    }
  }

  // Wrapper that adds guidance for poor results
  async searchWithGuidance(query: string, opts?: { systems?: string[]; limit?: number }) {
    // Check if we're searching within a small code system
    const tokens = this.tokenize(query);
    const requested = (opts?.systems ?? []).map(s =>
      s.startsWith("http") ? s :
      s.toLowerCase() === "loinc" ? "http://loinc.org" :
      s.toLowerCase().startsWith("snomed") ? "http://snomed.info/sct" :
      s.toLowerCase() === "rxnorm" ? "http://www.nlm.nih.gov/research/umls/rxnorm" : s
    );
    const sys = await this.expandRequestedSystems(requested);
    
    // If searching within a single small system, return all concepts
    if (sys.length === 1) {
      const systemSize = this.getSystemSize(sys[0]);
      if (systemSize > 0 && systemSize <= 150) {
        const allConcepts = this.getAllSystemConcepts(sys[0], query, opts?.limit ?? 150);
        return {
          query,
          hits: allConcepts,
          count: allConcepts.length,
          fullSystem: true,
          guidance: `This code system contains only ${systemSize} concepts total, so we're returning all of them ranked by similarity.`
        };
      }
    }
    
    const hits = await this.search(query, opts);
    
    // Determine if we need guidance
    let guidance: string | undefined;
    
    if (hits.length === 0) {
      guidance = "No matches found. Try fewer or different terms - your search may contain incorrect terminology.";
    } else if (hits.length < 3 && tokens.length > 3) {
      guidance = "Limited results found. Consider using fewer or more general terms.";
    } else if (hits[0] && 'matchQuality' in hits[0] && (hits[0] as any).matchQuality < 0.5) {
      const matchPct = Math.round((hits[0] as any).matchQuality * 100);
      guidance = `Only ${matchPct}% of your search terms matched. Consider revising terms that may be incorrect.`;
    }
    
    return {
      query,
      hits: hits.map(h => ({
        system: h.system,
        code: h.code,
        display: h.display,
        score: h.score
      })),
      count: hits.length,
      ...(guidance ? { guidance } : {})
    };
  }

  // Helper function to generate combinations
  private getCombinations<T>(arr: T[], size: number): T[][] {
    if (size === arr.length) return [arr];
    if (size === 1) return arr.map(el => [el]);
    if (size === 0) return [[]];
    
    const combinations: T[][] = [];
    for (let i = 0; i <= arr.length - size; i++) {
      const head = arr.slice(i, i + 1);
      const tailCombos = this.getCombinations(arr.slice(i + 1), size - 1);
      for (const tail of tailCombos) {
        combinations.push([...head, ...tail]);
      }
    }
    return combinations;
  }

  private getSupportedSystems(): string[] {
    if (this.systemsCache) return this.systemsCache;
    try {
      // Prefer code_systems table if present
      const list = this.db.query<{ system: string }>(`SELECT system FROM code_systems`).all();
      this.systemsCache = list.map(r => r.system);
      if (this.systemsCache.length) return this.systemsCache;
    } catch {}
    try {
      const list = this.db.query<{ system: string }>(`SELECT DISTINCT system FROM concepts`).all();
      this.systemsCache = list.map(r => r.system);
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
      const idxCS = parts.findIndex(p => p.toLowerCase() === 'codesystem');
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
      if (supported.has(norm)) { out.add(norm); continue; }

      // Heuristic: HL7 FHIR alias to THO CodeSystem URL
      try {
        const u = new URL(norm);
        const last = this.codeSegment(norm);
        if ((u.hostname.endsWith('hl7.org')) && (u.pathname.includes('/fhir/') || u.pathname.includes('/ValueSet/'))) {
          const tho = `http://terminology.hl7.org/CodeSystem/${last}`;
          if (supported.has(tho)) { out.add(tho); continue; }
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
        const maxAllow = Math.max(2, Math.ceil(Math.min(target.length, (best.sys.length || 1)) * 0.34));
        if (best.dist <= maxAllow) out.add(best.sys);
      }
    }

    // Always keep originals too (just in case)
    for (const s of systems) out.add(s);
    return Array.from(out);
  }

  async capabilities(): Promise<TerminologyCapabilities> {
    try {
      const rows = this.db.query<{ system: string; cnt: number }>(
        `SELECT system, COUNT(*) as cnt FROM concepts GROUP BY system`
      ).all();
      const supported = rows.map(r => r.system);
      const big = rows.filter(r => (r.cnt ?? 0) > 500).map(r => r.system);
      const builtin = supported.filter(s => 
        s.startsWith("http://terminology.hl7.org/CodeSystem/") || 
        s.startsWith("http://hl7.org/fhir/sid/")
      );
      return { supportedSystems: supported, bigSystems: big, builtinFhirCodeSystems: builtin };
    } catch {
      return { supportedSystems: [], bigSystems: [], builtinFhirCodeSystems: [] };
    }
  }

  normalizeSystem(input?: string): string | undefined {
    if (!input) return undefined;
    const supported = new Set(this.getSupportedSystems());
    if (supported.has(input)) return input;
    // Try THO mapping for hl7.org/fhir/...
    try {
      const u = new URL(input);
      const last = this.codeSegment(input);
      if ((u.hostname.endsWith('hl7.org'))) {
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
      const maxAllow = Math.max(2, Math.ceil(Math.min(target.length, (best.sys.length || 1)) * 0.34));
      if (best.dist <= maxAllow) return best.sys;
    }
    return input;
  }

  private getSystemSize(system: string): number {
    try {
      const result = this.db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM concepts WHERE system = ?`
      ).get(system);
      return result?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  private getAllSystemConcepts(system: string, query: string, limit: number = 150): TerminologyHit[] {
    try {
      const rows = this.db.query<any>(
        `SELECT system, code, display FROM concepts WHERE system = ? LIMIT ?`
      ).all(system, limit);
      
      // Rank by similarity to query
      const queryLower = query.toLowerCase();
      const ranked = rows.map(r => {
        const display = String(r.display ?? "");
        const displayLower = display.toLowerCase();
        
        // Calculate Levenshtein distance
        const distance = this.levenshtein(queryLower, displayLower);
        const maxLen = Math.max(query.length, display.length, 1);
        const similarity = 1 - (distance / maxLen);
        
        return {
          system: r.system,
          code: String(r.code),
          display,
          score: similarity
        };
      });
      
      // Sort by similarity score descending
      return ranked.sort((a, b) => b.score - a.score);
    } catch {
      return [];
    }
  }
}

const PORT = Number(Bun.env.PORT ?? Bun.env.TERMINOLOGY_SERVER_PORT ?? 3456);
const DB_PATH = Bun.env.TERMINOLOGY_DB_PATH ?? "./terminology.sqlite";
console.log("DB AT", DB_PATH);

// Initialize the terminology search
const search = new SqliteTerminologySearch(DB_PATH);

// CORS headers for browser access
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

console.log(`Starting terminology server on port ${PORT}...`);
console.log(`Using database: ${DB_PATH}`);

const server = Bun.serve({
  port: PORT,
  
  async fetch(request) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { 
        status: 200, 
        headers: corsHeaders 
      });
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return Response.json(
        { status: "ok", db: DB_PATH },
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Main search endpoint (always returns { results: [{ query, hits, count }] })
    if (url.pathname === "/search" && request.method === "POST") {
      try {
        const body = await request.json() as {
          query?: string;
          queries?: string[];
          systems?: string[];
          limit?: number;
        };

        const limit = body.limit ?? 20;
        // Normalize to array of terms
        const terms = Array.isArray(body.queries) && body.queries.length > 0
          ? body.queries.map(q => String(q || '').trim()).filter(Boolean)
          : (typeof body.query === 'string' && body.query.trim() ? [body.query.trim()] : []);
        if (terms.length === 0) {
          return Response.json(
            { results: [] },
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const results = await Promise.all(terms.map(async (q) => {
          try {
            const hits = await search.search(q, { systems: body.systems, limit });
            return { query: q, hits, count: hits.length };
          } catch {
            return { query: q, hits: [] as TerminologyHit[], count: 0 };
          }
        }));
        return Response.json(
          { results },
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Search error:", error);
        return Response.json(
          { error: "Search failed", details: String(error) },
          { 
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }
    }

    // Batch search endpoint for parallel lookups
    if (url.pathname === "/search/batch" && request.method === "POST") {
      try {
        const body = await request.json() as {
          searches: Array<{
            id: string;
            query: string;
            systems?: string[];
            limit?: number;
          }>;
        };

        if (!Array.isArray(body.searches)) {
          return Response.json(
            { error: "Missing 'searches' array" },
            { 
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            }
          );
        }

        // Process searches in parallel
        const results = await Promise.all(
          body.searches.map(async (searchReq) => {
            try {
              const hits = await search.search(searchReq.query, {
                systems: searchReq.systems,
                limit: searchReq.limit ?? 20,
              });
              return {
                id: searchReq.id,
                query: searchReq.query,
                hits,
                count: hits.length,
                status: "success",
              };
            } catch (error) {
              return {
                id: searchReq.id,
                query: searchReq.query,
                hits: [],
                count: 0,
                status: "error",
                error: String(error),
              };
            }
          })
        );

        return Response.json(
          { results },
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (error) {
        console.error("Batch search error:", error);
        return Response.json(
          { error: "Batch search failed", details: String(error) },
          { 
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }
    }

    // Exact code existence check (batch)
    if (url.pathname === "/codes/exists" && request.method === "POST") {
      try {
        const body = await request.json() as { items: Array<{ system?: string; code?: string }> };
        const items = Array.isArray(body.items) ? body.items : [];
        const results = items.map(it => {
          const norm = search.normalizeSystem(it.system);
          if (!norm || !it.code) return { system: it.system, code: it.code, exists: false };
          try {
            const row = search['db'].query<{ display?: string }>(
              `SELECT display FROM concepts WHERE system = ? AND code = ? LIMIT 1`
            ).get(norm, String(it.code));
            if (row) return { system: it.system, code: it.code, exists: true, display: row.display || '', normalizedSystem: norm };
            return { system: it.system, code: it.code, exists: false, normalizedSystem: norm };
          } catch {
            return { system: it.system, code: it.code, exists: false, normalizedSystem: norm };
          }
        });
        return Response.json({ results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        return Response.json({ results: [], error: String(error) }, { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Suggestions by display within system
    if (url.pathname === "/codes/suggest" && request.method === "POST") {
      try {
        const body = await request.json() as { system?: string; display?: string; limit?: number };
        const limit = body.limit ?? 5;
        const sys = body.system ? [search.normalizeSystem(body.system)!] : undefined;
        const hits = await search.search(String(body.display || ''), { systems: sys, limit });
        return Response.json({ hits }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        return Response.json({ hits: [], error: String(error) }, { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Capabilities endpoint
    if (url.pathname === "/capabilities" && request.method === "GET") {
      try {
        const caps = await search.capabilities();
        return Response.json(
          caps,
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (error) {
        return Response.json(
          { 
            supportedSystems: [],
            bigSystems: [],
            builtinFhirCodeSystems: [],
            error: String(error)
          },
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 404 for unknown routes
    return Response.json(
      { error: "Not found" },
      { 
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  },
});

console.log(`✅ Terminology server running at http://localhost:${PORT}`);
console.log(`
Available endpoints:
  POST /search        - Search for terminology (body: {query, systems?, limit?})
  POST /search/batch  - Batch search (body: {searches: [{id, query, systems?, limit?}]})
  GET  /capabilities  - Get supported code systems
  GET  /health       - Health check
`);
