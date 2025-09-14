import ui from '../index.html';
import viewer from '../viewer.html';
import { createApiFetch } from '../server/src/api';
import { join } from 'path';
import { generateConfig } from './config/generateConfig';

const dbPath = join(import.meta.dir, '..', 'server', 'db', 'terminology.sqlite');
const { fetch: apiFetch } = createApiFetch({ prefix: '', dbPath });

const development = (process.env.NODE_ENV || '').toLowerCase() !== 'production';

// Config cache - 5 minutes in production
let configCache: { config: ReturnType<typeof generateConfig>; timestamp: string } | null = null;

const server = Bun.serve({
  routes: { '/': ui, '/viewer': viewer },
  development,
  async fetch(req) {
    const url = new URL(req.url);

    // === CONFIG ENDPOINT ===
    if (url.pathname === '/config.json') {
      if (development) {
        const config = generateConfig('runtime');
        return new Response(JSON.stringify(config, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'X-Config-Source': 'server-fresh',
            'X-Config-Version': config.version,
          },
          status: 200,
        });
      }
      const cacheAge = configCache ? Date.now() - new Date(configCache.timestamp).getTime() : Infinity;
      if (cacheAge < 5 * 60 * 1000) {
        return new Response(JSON.stringify(configCache!.config, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'X-Config-Source': 'server-cached',
            'X-Config-Version': configCache!.config.version,
            'X-Cache-Age': String(Math.round(cacheAge / 1000)) + 's',
          },
          status: 200,
        });
      }
      const config = generateConfig('runtime');
      configCache = { config, timestamp: new Date().toISOString() };
      return new Response(JSON.stringify(config, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300, s-maxage=300',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'X-Config-Source': 'server-fresh',
          'X-Config-Version': config.version,
        },
        status: 200,
      });
    }

    // === CORS PREFLIGHT ===
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // === ROOT ROUTES ===
    if (url.pathname === '/') {
      return new Response(ui, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': development ? 'no-cache' : 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    if (url.pathname === '/viewer') {
      return new Response(viewer, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': development ? 'no-cache' : 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // === STATIC ASSETS ===
    if (url.pathname.startsWith('/public/')) {
      const filePath = join(import.meta.dir, '..', url.pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': development ? 'no-cache' : 'public, max-age=31536000, immutable',
          },
          status: 200,
        });
      }
    }

    // === API ROUTES ===
    return apiFetch(req);
  },
});

// Startup logging
console.log('\n🚀 Kiln Server v1.0');
console.log(`📍 URL: ${server.url}`);
console.log(`🔧 Mode: ${development ? 'DEVELOPMENT' : 'PRODUCTION'}`);
console.log(`📋 Config: ${server.url}config.json`);
console.log(`📦 Assets: ${server.url}public/`);

if (development) {
  try {
    const devConfig = generateConfig('runtime');
    console.log('\n🔧 Development Configuration Preview:');
    console.log(`   Model: ${devConfig.model}`);
    console.log(`   LLM Base: ${devConfig.baseURL}`);
    console.log(`   FHIR Base: ${devConfig.fhirBaseURL}`);
    console.log(`   Validation: ${devConfig.validationServicesURL || '[auto]'} (${devConfig.source})`);
    console.log(`   Concurrency: ${devConfig.fhirGenConcurrency}`);
    console.log(`   Debug Mode: ${devConfig.debugMode}`);
  } catch (error) {
    console.error('\n❌ Configuration validation failed:', error);
    process.exit(1);
  }
} else {
  console.log('\n🔒 Production Mode:');
  console.log('   • Config cached: 5 minutes');
  console.log('   • Assets cached: 1 year');
}
