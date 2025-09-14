// src/config/index.tsx
// Single init + sync getters. Fetches /config.json or uses static injection.

export type { PublicConfig } from './generateConfig';

export interface Config {
  baseURL: string;
  model: string;
  temperature: number;
  apiKeyHint: 'set-in-localstorage' | 'embedded' | 'not-configured';
  publicApiKey?: string | null;
  fhirBaseURL: string;
  validationServicesURL: string;
  fhirGenConcurrency: number;
  debugMode: boolean;
  maxRetries: number;
  llmMaxConcurrency: number;
  generatedAt: string;
  version: string;
  source: 'build-time' | 'runtime' | 'fallback' | 'error';
  environment: string;
  basePath: string;
}

let resolvedConfig: Config | null = null;
let initPromise: Promise<void> | null = null;

export const config = {
  async init(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      console.group('[Config] Initializing...');
      try {
        const anyWin = window as any;
        if (anyWin && anyWin.STATIC_CONFIG) {
          resolvedConfig = anyWin.STATIC_CONFIG as Config;
          console.log('[Config] Using STATIC_CONFIG');
          return;
        }
        const basePathMeta = document.querySelector('meta[name="app-base-path"]');
        const basePath = basePathMeta?.getAttribute('content') || '/';
        const url = new URL('config.json', new URL(basePath, window.location.origin)).toString();
        console.log(`[Config] Fetching ${url}`);
        const resp = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        const data = (await resp.json()) as unknown;
        if (!data || typeof data !== 'object' || !(data as any).model || !(data as any).baseURL) {
          throw new Error('Invalid configuration format');
        }
        resolvedConfig = data as Config;
        console.log(`✅ Loaded: ${resolvedConfig.model} (${resolvedConfig.source})`);
      } catch (err) {
        console.error('[Config] Failed to load', err);
        // Re-throw to let app bootstrap handle errors (no client defaults)
        throw err;
      } finally {
        try {
          Object.defineProperty(window as any, '__kilnConfig', {
            value: resolvedConfig,
            enumerable: false,
            configurable: true,
          });
        } catch {}
        console.groupEnd();
      }
    })();
    await initPromise;
  },
  async ready(): Promise<void> {
    return this.init();
  },
  get(): Config {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig;
  },
  baseURL: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.baseURL;
  },
  model: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.model;
  },
  temperature: (): number => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.temperature;
  },
  apiKeyHint: (): Config['apiKeyHint'] => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.apiKeyHint;
  },
  publicApiKey: (): string | null | undefined => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.publicApiKey;
  },
  fhirBaseURL: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.fhirBaseURL;
  },
  validationServicesURL: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.validationServicesURL;
  },
  fhirGenConcurrency: (): number => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.fhirGenConcurrency;
  },
  debugMode: (): boolean => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.debugMode;
  },
  maxRetries: (): number => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.maxRetries;
  },
  llmMaxConcurrency: (): number => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.llmMaxConcurrency;
  },
  environment: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.environment;
  },
  source: (): Config['source'] => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.source;
  },
  basePath: (): string => {
    if (!resolvedConfig) throw new Error('Configuration not loaded');
    return resolvedConfig.basePath;
  },
  isReady: (): boolean => !!resolvedConfig,
  isLoading: (): boolean => !!initPromise && !resolvedConfig,
};

// React helpers (optional)
import React, { createContext, useContext, useEffect, useState } from 'react';

interface ConfigState {
  config: Config;
  loading: boolean;
  error: string | null;
}

const ConfigContext = createContext<ConfigState | null>(null);

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<ConfigState>({ config: config.get(), loading: true, error: null });
  useEffect(() => {
    config
      .init()
      .then(() => setState({ config: config.get(), loading: false, error: null }))
      .catch((e) => setState({ config: config.get(), loading: false, error: String(e) }));
  }, []);
  return <ConfigContext.Provider value={state}>{children}</ConfigContext.Provider>;
};

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider');
  return ctx;
}
