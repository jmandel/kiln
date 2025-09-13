import { join } from 'path';
import { SqliteTerminologySearch, type TerminologyHit } from './services/terminology';
import { ValidatorService, type ValidationRequest } from './services/validator';

export interface ApiOptions {
  dbPath?: string;
  validatorJarPath?: string;
  javaHeap?: string;
  prefix?: string; // e.g., "/api"; default ""
  cors?: {
    origin?: string; // default "*"
    allowHeaders?: string;
    allowMethods?: string;
  };
}

export interface RouteDef {
  method: string;
  path: string; // absolute path including prefix
  fetch: (req: Request) => Promise<Response> | Response;
}

export interface ApiRoutes {
  routes: RouteDef[];
  shutdown: () => void;
}

export interface ApiFetch {
  fetch: (req: Request) => Promise<Response>;
  shutdown: () => void;
}

function makeCorsHeaders(opts?: ApiOptions['cors']) {
  const origin = opts?.origin ?? '*';
  const allowMethods = opts?.allowMethods ?? 'GET, POST, OPTIONS';
  const allowHeaders = opts?.allowHeaders ?? 'Content-Type';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': allowMethods,
    'Access-Control-Allow-Headers': allowHeaders,
  } as Record<string, string>;
}

export function createApiFetch(options: ApiOptions = {}): ApiFetch {
  const prefix = options.prefix ?? '';
  const corsHeaders = makeCorsHeaders(options.cors);
  const DB_PATH = options.dbPath ?? Bun.env.TERMINOLOGY_DB_PATH ?? './db/terminology.sqlite';
  const VALIDATOR_JAR =
    options.validatorJarPath ?? Bun.env.VALIDATOR_JAR ?? join(import.meta.dir, '..', 'validator.jar');
  const JAVA_HEAP = options.javaHeap ?? Bun.env.VALIDATOR_HEAP ?? '4g';

  const terminologySearch = new SqliteTerminologySearch(DB_PATH);
  const validatorService = new ValidatorService(VALIDATOR_JAR, JAVA_HEAP);

  // Warm validator
  void validatorService.start().catch((e) => {
    console.warn('Validator startup deferred to first request:', e?.message ?? e);
  });

  const notFound = () =>
    Response.json(
      { error: 'Not found' },
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  async function handleTxSearch(request: Request) {
    try {
      const body = (await request.json()) as {
        queries: string[];
        systems?: string[];
        limit?: number;
      };
      const limit = body.limit ?? 20;
      if (!Array.isArray(body.queries) || body.queries.length === 0) {
        return Response.json(
          { error: "Missing 'queries' array" },
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const terms = body.queries.map((q) => String(q || '').trim()).filter(Boolean);
      if (terms.length === 0) {
        return Response.json({ results: [] }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const results = await Promise.all(
        terms.map(async (q) => {
          try {
            const out = await terminologySearch.searchWithGuidance(q, {
              systems: body.systems,
              limit,
            });
            return {
              query: q,
              hits: out.hits as TerminologyHit[],
              count: out.count ?? out.hits?.length ?? 0,
              fullSystem: !!(out as any).fullSystem,
              guidance: (out as any).guidance,
            };
          } catch (e) {
            return { query: q, hits: [] as TerminologyHit[], count: 0 };
          }
        })
      );
      return Response.json({ results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (error) {
      console.error('Search error:', error);
      return Response.json(
        { error: 'Search failed', details: String(error) },
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  async function handleCodesExists(request: Request) {
    try {
      const body = (await request.json()) as { items: Array<{ system?: string; code?: string }> };
      const items = Array.isArray(body.items) ? body.items : [];
      const db = terminologySearch.getDb();
      const results = items.map((it) => {
        const norm = terminologySearch.normalizeSystem(it.system);
        if (!norm || !it.code) return { system: it.system, code: it.code, exists: false };
        try {
          const row = db
            .query<{
              display?: string;
            }>(`SELECT display FROM concepts WHERE system = ? AND code = ? LIMIT 1`)
            .get(norm, String(it.code));
          if (row)
            return {
              system: it.system,
              code: it.code,
              exists: true,
              display: row.display || '',
              normalizedSystem: norm,
            };
          return { system: it.system, code: it.code, exists: false, normalizedSystem: norm };
        } catch {
          return { system: it.system, code: it.code, exists: false, normalizedSystem: norm };
        }
      });
      return Response.json({ results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (error) {
      return Response.json(
        { error: 'Code existence check failed', details: String(error) },
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  async function handleCapabilities() {
    try {
      const caps = await terminologySearch.capabilities();
      return Response.json(caps, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return Response.json(
        { supportedSystems: [], bigSystems: [], builtinFhirCodeSystems: [], error: String(error) },
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  async function handleValidate(request: Request) {
    try {
      const body = (await request.json()) as ValidationRequest;
      if (!body.resource) {
        return Response.json(
          { error: "Missing 'resource' parameter" },
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const result = await validatorService.validate(body.resource, body.profile);
      return Response.json(result, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Validation error:', error);
      return Response.json(
        {
          valid: false,
          issues: [{ severity: 'error', code: 'exception', details: String(error) }],
        },
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  async function handleValidateBatch(request: Request) {
    try {
      const body = (await request.json()) as {
        resources: Array<{ id: string; resource: any; profile?: string }>;
      };
      if (!Array.isArray(body.resources)) {
        return Response.json(
          { error: "Missing 'resources' array" },
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      const results = await Promise.all(
        body.resources.map(async (item) => {
          try {
            const result = await validatorService.validate(item.resource, item.profile);
            return { id: item.id, ...result };
          } catch (error) {
            return {
              id: item.id,
              valid: false,
              issues: [{ severity: 'error', code: 'exception', details: String(error) }],
            };
          }
        })
      );
      return Response.json({ results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (error) {
      console.error('Batch validation error:', error);
      return Response.json(
        { error: 'Batch validation failed', details: String(error) },
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  async function handleHealth() {
    return Response.json(
      {
        status: 'ok',
        services: {
          terminology: true,
          validator: { ready: validatorService.getIsReady() },
        },
      },
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // Prefix filtering
    const path = url.pathname;
    if (prefix && !path.startsWith(prefix)) return notFound();
    const p = prefix ? path.slice(prefix.length) || '/' : path;

    // Routing
    if (p === '/health' && request.method === 'GET') return handleHealth();

    if (p === '/tx/search' && request.method === 'POST') return handleTxSearch(request);
    if (p === '/tx/codes/exists' && request.method === 'POST') return handleCodesExists(request);
    if (p === '/tx/capabilities' && request.method === 'GET') return handleCapabilities();

    if (p === '/validate' && request.method === 'POST') return handleValidate(request);
    if (p === '/validate/batch' && request.method === 'POST') return handleValidateBatch(request);

    return notFound();
  };

  const shutdown = () => {
    validatorService.stop();
  };

  return { fetch, shutdown };
}

export function createApiRoutes(options: ApiOptions = {}): ApiRoutes {
  const { fetch, shutdown } = createApiFetch(options);
  const prefix = options.prefix ?? '';
  const mk = (method: string, path: string) => ({ method, path: `${prefix}${path}`, fetch });
  const routes: RouteDef[] = [
    mk('GET', '/health'),
    mk('POST', '/tx/search'),
    mk('POST', '/tx/codes/exists'),
    mk('GET', '/tx/capabilities'),
    mk('POST', '/validate'),
    mk('POST', '/validate/batch'),
  ];
  return { routes, shutdown };
}
