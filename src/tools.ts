export interface TerminologyHit {
  system: string;
  code: string;
  display: string;
  score?: number; // optional relevance score if provided by the server
}

/**
 * Searches for terminology codes using the local terminology server.
 * @param query The search query string (e.g., a clinical finding).
 * @param systems Optional array of FHIR system URLs to search within.
 * @param limit Maximum number of results to return (default 200).
 * @returns A promise that resolves to an array of terminology hits.
 */
import { getTerminologyServerURL } from './helpers';

export interface TerminologySearchResult {
  hits: TerminologyHit[];
  count?: number;
  guidance?: string;
  fullSystem?: boolean;
  perQuery?: Array<{ query: string; count: number }>;
  perQueryHits?: Array<{ query: string; hits: TerminologyHit[]; count?: number }>;
}

export async function searchTerminology(query: string | string[], systems?: string[], limit: number = 200): Promise<TerminologySearchResult> {
  const TERMINOLOGY_SERVER = getTerminologyServerURL();

  const queries = Array.isArray(query) ? query : [query];
  const body = JSON.stringify({ queries, systems, limit });
  // Use unified server (/tx/search)
  const response = await fetch(`${TERMINOLOGY_SERVER}/tx/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  
  if (!response.ok) {
    throw new Error(`Terminology search failed: ${response.status}`);
  }
  
  const data = await response.json();
  const results = (Array.isArray(data?.results) ? data.results : []) as Array<{ query: string; hits: TerminologyHit[]; count?: number; fullSystem?: boolean; guidance?: string }>;
  const flatHits = results.flatMap(r => Array.isArray(r.hits) ? r.hits : []);
  const perQuery = results.map(r => ({ query: r.query, count: Array.isArray(r.hits) ? r.hits.length : (r.count ?? 0) }));
  const fullSystem = results.some(r => !!r.fullSystem);
  const guidance = (results.find(r => typeof r.guidance === 'string' && String(r.guidance).trim())?.guidance) as string | undefined;
  return {
    hits: flatHits,
    count: flatHits.length,
    guidance,
    fullSystem,
    perQuery,
    perQueryHits: results
  };
}
