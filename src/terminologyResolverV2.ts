import { searchTerminology, type TerminologyHit, type TerminologySearchResult } from './tools';
import { getTerminologyServerURL } from './helpers';
import type { Context } from './types';

export interface TerminologyCapabilities {
  supportedSystems: string[];
  bigSystems?: string[];
  builtinFhirCodeSystems?: string[];
}

async function getTerminologyCapabilities(): Promise<TerminologyCapabilities> {
  try {
    const TERMINOLOGY_SERVER = getTerminologyServerURL();
    const response = await fetch(`${TERMINOLOGY_SERVER}/capabilities`);
    if (response.ok) {
      return await response.json();
    }
  } catch {}
  return { supportedSystems: [], bigSystems: [], builtinFhirCodeSystems: [] };
}

interface CodeLocation {
  path: string;
  jsonPointer: string;
  potentialDisplays?: string[];
  potentialSystems?: string[];
  potentialCodes?: string[];
}

/**
 * Process FHIR resources with inline code resolution.
 * - Process max 3 resources concurrently
 * - For each resource, resolve all its codes (max 5 concurrent lookups)
 * - Stitch codes directly into resources (no intermediate artifacts)
 * - All LLM calls use step() for resumability
 */
export async function resolveResourceCodes(
  ctx: Context,
  resources: any[]
): Promise<any[]> {
  
  const capabilities = await getTerminologyCapabilities();
  const RESOURCE_BATCH_SIZE = 3;
  const CODE_BATCH_SIZE = 5;
  
  // Deep clone resources to avoid mutations
  const resolvedResources = JSON.parse(JSON.stringify(resources));
  
  // Process resources in batches of 3
  for (let i = 0; i < resources.length; i += RESOURCE_BATCH_SIZE) {
    const batch = resolvedResources.slice(i, Math.min(i + RESOURCE_BATCH_SIZE, resources.length));
    
    await Promise.all(batch.map(async (resource, batchIndex) => {
      const resourceIndex = i + batchIndex;
      const resourceType = resource.resourceType || 'Unknown';
      
      // Find all code placeholders in this resource
      const placeholders = findPlaceholders(resource);
      
      if (placeholders.length === 0) {
        return; // No codes to resolve in this resource
      }
      
      // Process codes for this resource in batches of 5
      for (let j = 0; j < placeholders.length; j += CODE_BATCH_SIZE) {
        const codeBatch = placeholders.slice(j, Math.min(j + CODE_BATCH_SIZE, placeholders.length));
        
        await Promise.all(codeBatch.map(async (placeholder) => {
          const stepKey = `resolve_code_${resourceType}_${resourceIndex}_${placeholder.path.replace(/\./g, '_')}`;
          
          const resolvedCode = await ctx.step(stepKey, async () => {
            const out = await resolveOneCode(
              ctx,
              placeholder,
              resourceType,
              capabilities
            );
            return out?.code || null;
          }, { 
            title: `Resolve ${resourceType}.${placeholder.path}`,
            tags: { 
              phase: 'terminology',
              resourceType,
              resourceIndex,
              path: placeholder.path 
            }
          });
          
          // Stitch the resolved code directly into the resource
          if (resolvedCode) {
            applyCodeToResource(resource, placeholder.jsonPointer, resolvedCode);
          }
        }));
      }
    }));
  }
  
  return resolvedResources;
}

// Attempt log types for richer provenance on failure
export type TermAttempt = {
  query: string;
  systems?: string[];
  hitCount: number;
  sample: Array<{ system: string; code: string; display?: string }>;
  decision: {
    action: string;
    terms?: string[] | string;
    reason?: string;
    selection?: { system: string; code: string; display?: string };
    justification?: string;
  };
};

export type AttemptLogByPointer = Record<string, { attempts: TermAttempt[]; failureReason?: string } | undefined>;

export async function resolveResourceCodesWithLogs(
  ctx: Context,
  resources: any[]
): Promise<{ resources: any[]; attempts: AttemptLogByPointer }> {
  const attempts: AttemptLogByPointer = {};
  const capabilities = await getTerminologyCapabilities();
  const RESOURCE_BATCH_SIZE = 3;
  const CODE_BATCH_SIZE = 5;
  const resolvedResources = JSON.parse(JSON.stringify(resources));

  for (let i = 0; i < resources.length; i += RESOURCE_BATCH_SIZE) {
    const batch = resolvedResources.slice(i, Math.min(i + RESOURCE_BATCH_SIZE, resources.length));
    await Promise.all(batch.map(async (resource, batchIndex) => {
      const resourceIndex = i + batchIndex;
      const resourceType = resource.resourceType || 'Unknown';
      const placeholders = findPlaceholders(resource);
      if (placeholders.length === 0) return;
      for (let j = 0; j < placeholders.length; j += CODE_BATCH_SIZE) {
        const codeBatch = placeholders.slice(j, Math.min(j + CODE_BATCH_SIZE, placeholders.length));
        await Promise.all(codeBatch.map(async (placeholder) => {
          const stepKey = `resolve_code_${resourceType}_${resourceIndex}_${placeholder.path.replace(/\./g, '_')}`;
          const out = await ctx.step(stepKey, async () => {
            return await resolveOneCode(ctx, placeholder, resourceType, capabilities, true);
          }, {
            title: `Resolve ${resourceType}.${placeholder.path}`,
            tags: { phase: 'terminology', resourceType, resourceIndex, path: placeholder.path }
          });
          if (out?.code) {
            applyCodeToResource(resource, placeholder.jsonPointer, out.code);
          } else {
            // Store attempts/failure for later extension payload
            const rid = resource?.id;
            const resourceRef = `${resourceType}/${rid || ''}`;
            const key = `${resourceRef}:${placeholder.jsonPointer}`;
            attempts[key] = { attempts: out?.attempts || [], failureReason: out?.failureReason };
          }
        }));
      }
    }));
  }

  return { resources: resolvedResources, attempts };
}

export async function resolveOneCode(
  ctx: Context,
  placeholder: CodeLocation,
  resourceType: string,
  capabilities: TerminologyCapabilities,
  collectAttempts = false
): Promise<{ code: any | null; attempts?: TermAttempt[]; failureReason?: string } | null> {
  
  const targetDisplay = placeholder.potentialDisplays?.[0] || placeholder.path;
  const systems = placeholder.potentialSystems;
  const maxIterations = 5;
  let currentQuery = targetDisplay;
  const attemptedQueries: string[] = [];
  const attemptLog: TermAttempt[] = [];
  
  for (let iter = 0; iter < maxIterations; iter++) {
    // Search terminology (skip network call if query is empty; let LLM propose terms)
    const q = String(currentQuery || '').trim();
    const res: TerminologySearchResult = q.length > 0 ? await searchTerminology(q, systems, 200) : { hits: [] };
    const hits = res.hits || [];
    attemptedQueries.push(currentQuery);
    
    // Build prompt for LLM to pick or refine
    const prompt = buildPickerPrompt(
      placeholder,
      resourceType,
      hits,
      attemptedQueries,
      maxIterations - iter,
      capabilities,
      res.guidance,
      { count: res.count, fullSystem: res.fullSystem }
    );
    
    // Use callLLM which internally uses step() for resumability
    const decision = await ctx.callLLM('terminology_picker', prompt, { 
      expect: 'json',
      tags: { 
        phase: 'terminology',
        resourceType,
        path: placeholder.path 
      }
    });

    if (collectAttempts) {
      attemptLog.push({
        query: q,
        systems: systems,
        hitCount: hits.length,
        sample: hits.slice(0, 3).map(h => ({ system: h.system, code: h.code, display: h.display })),
        decision: {
          action: decision?.action,
          terms: decision?.terms,
          reason: decision?.reason,
          selection: decision?.selection,
          justification: decision?.justification
        }
      });
    }
    
    if (decision.action === 'pick' && decision.selection) {
      // Verify selection is in hits
      const valid = hits.find(h => 
        h.system === decision.selection.system && 
        h.code === decision.selection.code
      );
      
      if (valid) {
        return {
          code: {
            system: decision.selection.system,
            code: decision.selection.code,
            display: decision.selection.display || valid.display
          },
          attempts: collectAttempts ? attemptLog : undefined
        };
      }
    }
    
    if (decision.action === 'search' && decision.terms && iter < maxIterations - 1) {
      const nextQuery = Array.isArray(decision.terms) ? decision.terms.join(' ') : decision.terms;
      // Repeat-guard: if suggested next query was already tried, bail out to avoid loops
      if (attemptedQueries.map(q => String(q).toLowerCase()).includes(String(nextQuery).toLowerCase())) {
        return { code: null, attempts: collectAttempts ? attemptLog : undefined, failureReason: 'repeat_query' };
      }
      currentQuery = nextQuery;
      continue;
    }
    
    // Unresolved or final iteration
    break;
  }
  
  // Could not resolve - return null with attempts
  return { code: null, attempts: collectAttempts ? attemptLog : undefined, failureReason: (attemptLog.at(-1)?.decision?.reason) || (String(currentQuery || '').trim() ? 'no_valid_pick' : 'empty_query') };
}

function findPlaceholders(obj: any, path = ''): CodeLocation[] {
  const placeholders: CodeLocation[] = [];
  
  function scan(node: any, currentPath: string, jsonPtr: string) {
    if (!node || typeof node !== 'object') return;
    
    // Check for placeholder markers
    if (node._potential_displays || node._potential_systems || node._potential_codes) {
      placeholders.push({
        path: currentPath || 'root',
        jsonPointer: jsonPtr || '/',
        potentialDisplays: parseList(node._potential_displays),
        potentialSystems: parseList(node._potential_systems),
        potentialCodes: parseList(node._potential_codes)
      });
      return;
    }
    
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        scan(
          item,
          currentPath ? `${currentPath}[${index}]` : `[${index}]`,
          `${jsonPtr}/${index}`
        );
      });
    } else {
      Object.keys(node).forEach(key => {
        if (!key.startsWith('_')) {
          scan(
            node[key],
            currentPath ? `${currentPath}.${key}` : key,
            `${jsonPtr}/${key}`
          );
        }
      });
    }
  }
  
  scan(obj, '', '');
  return placeholders;
}

function parseList(value: any): string[] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  return undefined;
}

function applyCodeToResource(resource: any, jsonPointer: string, code: any): void {
  // Navigate to the location using JSON pointer
  const segments = jsonPointer.substring(1).split('/');
  let current = resource;
  
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!current[segment]) return;
    current = current[segment];
  }
  
  const lastSegment = segments[segments.length - 1];
  const target = current[lastSegment];
  
  if (target && typeof target === 'object') {
    // Apply the resolved code
    target.system = code.system;
    target.code = code.code;
    target.display = code.display;
    
    // Remove placeholder markers
    delete target._potential_displays;
    delete target._potential_systems;
    delete target._potential_codes;
    delete (target as any)._proposed_coding;
  }
}

export function buildPickerPrompt(
  placeholder: CodeLocation,
  resourceType: string,
  hits: TerminologyHit[],
  previousQueries: string[],
  remainingTurns: number,
  capabilities: TerminologyCapabilities,
  guidance?: string,
  meta?: { count?: number; fullSystem?: boolean }
): string {
  
  const targetDisplay = placeholder.potentialDisplays?.[0] || placeholder.path;
  const systemsList = placeholder.potentialSystems?.join(', ') || 'any';
  
  // Format capabilities info
  const bigList = (capabilities?.bigSystems ?? []).slice(0, 10).join(", ") || "(none detected)";
  const builtins = (capabilities?.builtinFhirCodeSystems ?? []).slice(0, 10).join(", ") || "(none detected)";
  
  const metaLines: string[] = [];
  if (typeof meta?.count === 'number') metaLines.push(`Total hits (server): ${meta.count}`);
  if (meta?.fullSystem) metaLines.push(`Note: full system listing returned`);

  return `You help pick the best terminology code strictly from the provided hits.

Rules (Query Strategy only):
- Keep each search query concise (2–4 tokens). Avoid long concatenations.
- Start with the head concept. If hits are only very specific subtypes, broaden with synonyms/hypernyms rather than adding more words.
- Use 2–3 targeted queries. When a query yields viable hits, prefer selecting from them over continuing to search.
- If an expansion yields zero hits after a query that had hits, back off to the earlier hit list and choose the best general-fit candidate.
- Search only within the allowed systems passed in (do not cross into other systems).
- Examples of broadening: “neurodegenerative disorder” → “degenerative disease of the central nervous system”, “degenerative brain disorder”, “nervous system degeneration”.

Selection constraints:
- Only pick from the current hits; NEVER invent codes.
- When action is "pick", copy the exact display from the chosen hit.
- If remainingTurns = 1, do NOT return action "search"; choose "pick" or "unresolved".

Context:
- Resource Type: ${resourceType}
- Attribute Path: ${placeholder.path}
- Target Display: ${targetDisplay}
- Preferred Systems: ${systemsList}

Previous Searches: ${previousQueries.map((q, i) => `${i + 1}. "${q}"`).join(', ')}
Remaining Turns: ${remainingTurns}

${metaLines.length ? `Result Meta: ${metaLines.join(' | ')}` : ''}
${guidance ? `Guidance: ${guidance}` : ''}

Current Results (${hits.length} hits shown):
${JSON.stringify(hits.slice(0, 50), null, 2)}

Return JSON:
{ "action":"pick", "selection": { "system":"...", "code":"...", "display":"..." }, "confidence": 0..1 }
OR
{ "action":"search", "terms":["term1","term2",...], "justification":"..." }
OR
{ "action":"unresolved", "reason":"..." }`;
}
