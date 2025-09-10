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
  const response = await fetch(`${TERMINOLOGY_SERVER}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries, systems, limit })
  });
  
  if (!response.ok) {
    throw new Error(`Terminology search failed: ${response.status}`);
  }
  
  const data = await response.json();
  const results = (Array.isArray(data?.results) ? data.results : []) as Array<{ query: string; hits: TerminologyHit[]; count?: number }>;
  const flatHits = results.flatMap(r => Array.isArray(r.hits) ? r.hits : []);
  const perQuery = results.map(r => ({ query: r.query, count: Array.isArray(r.hits) ? r.hits.length : (r.count ?? 0) }));
  return {
    hits: flatHits,
    count: flatHits.length,
    perQuery,
    perQueryHits: results
  };
}
