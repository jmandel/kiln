// src/config/generateConfig.ts
// Ultra-simple, server-side configuration generator. Produces a complete, validated public config.

// Avoid importing the browser config module here to prevent cycles.
import { nowIso } from '../helpers';

export interface PublicConfig {
  // LLM Configuration
  baseURL: string;
  model: string;
  temperature: number;
  llmRequestOptions: Record<string, unknown>;
  apiKeyHint: 'set-in-localstorage' | 'embedded' | 'not-configured';
  publicApiKey?: string | null;

  // FHIR Configuration
  fhirBaseURL: string;
  validationServicesURL: string; // empty string means "auto-detect same-origin server"
  fhirGenConcurrency: number;

  // App Configuration
  debugMode: boolean;
  maxRetries: number;
  llmMaxConcurrency: number;

  // Metadata
  generatedAt: string;
  version: string;
  source: 'build-time' | 'runtime';
  environment: string;
  basePath: string;
}

export function generateConfig(source: 'build-time' | 'runtime' = 'runtime'): PublicConfig {
  const env = process.env;
  const nodeEnv = (env.NODE_ENV || 'development').toLowerCase();
  const isDev = nodeEnv === 'development';

  // Pre-compute values that are reused
  const baseURL = (env.PUBLIC_KILN_LLM_URL || 'https://openrouter.ai/api/v1').replace(/\/+$|\/$/g, '');
  const model = env.PUBLIC_KILN_MODEL || 'openai/gpt-oss-120b:free';
  const temperature = Math.max(0, Math.min(2, Number(env.PUBLIC_KILN_TEMPERATURE || '0.8')));
  const llmRequestOptions = (() => {
    const raw = env.PUBLIC_KILN_LLM_REQUEST_OPTIONS || '{}';
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return {};
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('must be a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid PUBLIC_KILN_LLM_REQUEST_OPTIONS: ${msg}`);
    }
  })();

  const fhirBaseURL = (env.PUBLIC_KILN_FHIR_BASE_URL || 'https://kiln.fhir.me').replace(/\/+$|\/$/g, '');
  const validationServicesURL = env.PUBLIC_KILN_VALIDATION_SERVICES_URL || '';
  const fhirGenConcurrency = Math.max(1, Math.min(8, Number(env.PUBLIC_KILN_FHIR_GEN_CONCURRENCY || '1')));

  const maxRetries = Math.max(1, Math.min(10, Number(env.PUBLIC_KILN_MAX_RETRIES || '3')));
  const llmMaxConcurrency = Math.max(
    1,
    Math.min(
      16,
      Number(env.PUBLIC_KILN_LLM_MAX_CONCURRENCY || String(Math.max(2, fhirGenConcurrency * 2)))
    )
  );

  // Always embed a key: pass through env if set; otherwise supply a placeholder demo key
  const publicApiKey = (env.PUBLIC_KILN_LLM_PUBLIC_KEY || env.PUBLIC_KILN_API_KEY || env.KILN_API_KEY || 'sk-public-demo').trim();

  const config: PublicConfig = {
    // LLM Configuration - COMPLETE VALUES ONLY
    baseURL,
    model,
    temperature,
    llmRequestOptions,
    // API Key handling (always embedded per simplified policy)
    apiKeyHint: 'embedded',
    publicApiKey,

    // FHIR Configuration - COMPLETE VALUES ONLY
    fhirBaseURL,
    validationServicesURL,
    fhirGenConcurrency,

    // App Configuration - COMPLETE VALUES ONLY
    debugMode: env.PUBLIC_KILN_DEBUG_MODE === 'true' || isDev,
    maxRetries,
    llmMaxConcurrency,

    // Metadata
    generatedAt: nowIso(),
    version: '1.0',
    source,
    environment: nodeEnv,
    basePath: env.PUBLIC_KILN_BASE_PATH || '/',
  };

  // Validate required fields
  const required = ['baseURL', 'model', 'fhirBaseURL'] as const;
  for (const key of required) {
    if (!config[key] || config[key] === '') {
      throw new Error(`Missing required configuration: ${String(key)}`);
    }
  }

  // Validate URLs
  if (!config.baseURL.startsWith('http')) {
    throw new Error(`Invalid baseURL: ${config.baseURL}`);
  }
  if (!config.fhirBaseURL.startsWith('http')) {
    throw new Error(`Invalid fhirBaseURL: ${config.fhirBaseURL}`);
  }

  // Clean/validate validationServicesURL - empty string means "auto-detect"
  if (config.validationServicesURL === '') {
    config.validationServicesURL = '';
  } else if (!config.validationServicesURL.startsWith('http')) {
    throw new Error(`Invalid validationServicesURL: ${config.validationServicesURL}`);
  }

  return config;
}

// Export for static build
export const STATIC_CONFIG = generateConfig('build-time');

// Server runtime helper
export function getServerConfig(): PublicConfig {
  if (typeof process === 'undefined') {
    throw new Error('getServerConfig must be called server-side');
  }
  return generateConfig('runtime');
}

// Type exports
export type { PublicConfig as _PublicConfig };
