#!/usr/bin/env bun
/**
 * Static build script for Kiln
 * 1. Generates complete dist/config.json from PUBLIC_KILN_* env vars
 * 2. Builds HTML/JS/CSS with minimal injection (no config duplication)
 * 3. Copies assets and examples
 * 4. Validates complete output
 */

import { $ } from 'bun';
import { mkdir, writeFile, cp, readdir, stat } from 'fs/promises';
import { resolve, join, basename } from 'path';
import { generateConfig } from '../src/config/generateConfig';
import tailwind from 'bun-plugin-tailwind';

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true }).catch(() => {});
}

async function generateStaticConfig() {
  console.log('📋 Generating static configuration...');
  const config = generateConfig('build-time');
  const configPath = resolve('dist', 'config.json');
  await ensureDir(resolve('dist'));
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('✅ dist/config.json created:');
  console.log(`   Model: ${config.model}`);
  console.log(`   Base URL: ${config.baseURL}`);
  console.log(`   FHIR Base: ${config.fhirBaseURL}`);
  console.log(`   Validation: ${config.validationServicesURL || '[auto-detect]'}`);
  console.log(`   Concurrency: ${config.fhirGenConcurrency}`);
  console.log(`   Source: ${config.source} (${config.environment})`);
  console.log(`   Generated: ${new Date(config.generatedAt).toLocaleString()}`);
  return config;
}

async function buildHtmlAndAssets() {
  console.log('🧱 Building HTML and assets...');
  const sourcemap = process.env.NODE_ENV === 'production' ? 'external' : 'inline';
  const result = await Bun.build({
    entrypoints: ['./src/app.tsx', './index.html', './viewer.html'],
    outdir: './dist',
    target: 'browser',
    format: 'esm',
    minify: process.env.NODE_ENV === 'production',
    sourcemap,
    plugins: [tailwind],
  });

  if (!result.success) {
    console.error('❌ Bun.build failed');
    for (const message of result.logs ?? []) {
      console.error(message);
    }
    throw new Error('Static asset build failed');
  }
  console.log('✅ HTML and assets built successfully');
}

async function copyPublicAssets() {
  const src = resolve('public');
  const dst = resolve('dist', 'public');
  try {
    const publicStat = await stat(src).catch(() => null);
    if (!publicStat || !publicStat.isDirectory()) {
      console.log('ℹ️  No public/ directory found (skipping)');
      return;
    }
    await ensureDir(dst);
    console.log('📦 Copying public assets...');
    await cp(src, dst, { recursive: true });
    console.log('✅ Public assets copied');
  } catch (error) {
    console.warn('⚠️  Public assets copy failed:', error);
  }
}

async function copyExamples() {
  const src = resolve('examples');
  const dst = resolve('dist', 'examples');
  try {
    const examplesStat = await stat(src).catch(() => null);
    if (!examplesStat || !examplesStat.isDirectory()) {
      console.log('ℹ️  No examples/ directory found (skipping)');
      return;
    }
    await ensureDir(dst);
    console.log('📦 Copying examples...');
    await cp(src, dst, { recursive: true });
    console.log('✅ Examples copied');
  } catch (error) {
    console.warn('⚠️  Examples copy failed:', error);
  }
}

async function generateExamplesIndex() {
  const examplesDir = resolve('examples');
  const outDir = resolve('dist', 'examples');
  const outFile = join(outDir, 'index.json');
  try {
    const examplesStat = await stat(examplesDir).catch(() => null);
    if (!examplesStat || !examplesStat.isDirectory()) {
      console.log('ℹ️  No examples to index (skipping)');
      return;
    }
    const files = await readdir(examplesDir);
    const examples = await Promise.all(
      files
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .map(async (f) => {
          const filePath = join(examplesDir, f);
          const fileStat = await stat(filePath);
          return {
            name: basename(f, '.json'),
            path: `examples/${f}`,
            size: fileStat.size,
            modified: fileStat.mtime.toISOString(),
            type: 'example',
          };
        })
    );
    examples.sort((a, b) => a.name.localeCompare(b.name));
    const index = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      total: examples.length,
      examples,
    };
    await ensureDir(outDir);
    await writeFile(outFile, JSON.stringify(index, null, 2), 'utf8');
    console.log(`✅ Generated examples index: ${examples.length} files`);
  } catch (error) {
    console.warn('⚠️  Failed to generate examples index:', error);
  }
}

async function generateBuildManifest(config: ReturnType<typeof generateConfig>) {
  const manifest = {
    version: process.env.npm_package_version || '0.0.0',
    builtAt: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    buildMode: 'static',
    configSource: config.source,
    files: {
      config: 'config.json',
      html: ['index.html', 'viewer.html'],
      assets: 'public/',
      examples: true,
    },
    configSummary: {
      model: config.model,
      baseURL: config.baseURL,
      fhirBaseURL: config.fhirBaseURL,
      validationServicesURL: config.validationServicesURL || '[auto-detect]',
      concurrency: config.fhirGenConcurrency,
    },
    buildHash: process.env.BUILD_ID || Date.now().toString(36),
  } as const;
  const manifestPath = resolve('dist', 'build-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('📋 Build manifest generated');
  return manifest;
}

async function injectStaticConfig() {
  try {
    const cfgText = await Bun.file(resolve('dist', 'config.json')).text();
    const injectTag = `<script>window.STATIC_CONFIG=${cfgText};</script>`;
    for (const fname of ['index.html', 'viewer.html']) {
      const p = resolve('dist', fname);
      try {
        let html = await Bun.file(p).text();
        if (html.includes('window.STATIC_CONFIG')) continue;
        // Prefer to inject before the first script tag or at end of head
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${injectTag}\n</head>`);
        } else if (html.includes('<body')) {
          html = html.replace('<body', `${injectTag}\n<body`);
        } else {
          html = injectTag + '\n' + html;
        }
        await writeFile(p, html, 'utf8');
      } catch {}
    }
    console.log('🧩 Injected STATIC_CONFIG into HTML');
  } catch (err) {
    console.warn('⚠️  Failed to inject STATIC_CONFIG:', err);
  }
}

async function validateStaticBuild() {
  console.log('\n🔍 Validating static build...');
  const requiredFiles = [
    { path: resolve('dist', 'config.json'), type: 'config' },
    { path: resolve('dist', 'index.html'), type: 'html' },
    { path: resolve('dist', 'viewer.html'), type: 'html' },
  ];
  const missing: string[] = [];
  const validationErrors: string[] = [];
  for (const { path, type } of requiredFiles) {
    try {
      const stats = await stat(path);
      if (!stats.isFile()) missing.push(`${type}: ${path.split('/').pop()}`);
    } catch {
      missing.push(`${type}: ${path.split('/').pop()}`);
    }
  }
  try {
    const configPath = resolve('dist', 'config.json');
    const configData = await Bun.file(configPath).json();
    if (!configData || typeof configData !== 'object') {
      validationErrors.push('config.json: Invalid JSON format');
    } else if (!configData.model || !configData.baseURL || !configData.fhirBaseURL) {
      validationErrors.push('config.json: Missing required fields (model, baseURL, fhirBaseURL)');
    } else if (!String(configData.baseURL).startsWith('http')) {
      validationErrors.push('config.json: Invalid baseURL (must start with http:// or https://)');
    } else if (!String(configData.fhirBaseURL).startsWith('http')) {
      validationErrors.push('config.json: Invalid fhirBaseURL (must start with http:// or https://)');
    }
  } catch (error) {
    validationErrors.push(`config.json: ${error}`);
  }
  if (missing.length > 0) {
    console.error('❌ Missing files:');
    missing.forEach((f) => console.error(`   ${f}`));
    throw new Error(`Validation failed: ${missing.length} file(s) missing`);
  }
  if (validationErrors.length > 0) {
    console.error('❌ Configuration validation errors:');
    validationErrors.forEach((e) => console.error(`   ${e}`));
    throw new Error(`Config validation failed: ${validationErrors.length} error(s)`);
  }
  console.log('✅ All validations passed');
}

async function main() {
  console.log('🔨 Kiln Static Build');
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`🎯 Target: Static deployment with complete config.json`);
  console.log('='.repeat(60));

  let buildConfig: ReturnType<typeof generateConfig>;
  try {
    console.log('🧹 Cleaning dist/ directory...');
    await $`rm -rf dist`.catch(() => {});
    buildConfig = await generateStaticConfig();
    await buildHtmlAndAssets();
    await copyPublicAssets();
    await copyExamples();
    await generateExamplesIndex();
    await generateBuildManifest(buildConfig);
    await injectStaticConfig();
    await validateStaticBuild();
    console.log('\n🎉 Static build completed successfully!');
    console.log('\n📁 Deployment Structure:');
    console.log('   dist/');
    console.log('   ├── config.json                 # Complete configuration');
    console.log('   ├── index.html                  # Main application');
    console.log('   ├── viewer.html                 # Viewer page');
    console.log('   ├── public/                     # CSS, JS, assets');
    console.log('   ├── examples/                   # Sample documents');
    console.log('   └── build-manifest.json         # Build metadata');
    console.log('\n🚀 Serve with any static server:');
    console.log('   npx serve dist -l 3001 --cors');
    console.log('   python -m http.server 3001 dist/');
    console.log('   # Or deploy to Netlify, Vercel, GitHub Pages, etc.');
    console.log('\n🔍 Configuration available at:');
    console.log('   https://your-domain.com/config.json');
    console.log('   https://your-domain.com/kiln/config.json (subpath)');
    console.log('\n✅ Build verified: All files present and valid');
    process.exit(0);
  } catch (error) {
    console.error('\n💥 Build failed:', error);
    await $`rm -rf dist`.catch(() => {});
    console.error('\n🔧 Troubleshooting:');
    console.error('   1. Check PUBLIC_KILN_* environment variables');
    console.error('   2. Ensure PUBLIC_KILN_LLM_URL and PUBLIC_KILN_FHIR_BASE_URL are valid URLs');
    console.error('   3. Run `bun run config:check` for validation');
    process.exit(1);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--validate-only')) {
    generateStaticConfig()
      .then((config) => {
        console.log('\n✅ Configuration validation passed');
        console.log(`Model: ${config.model}`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('❌ Configuration validation failed:', err);
        process.exit(1);
      });
  } else {
    main().catch((err) => {
      console.error('Build script error:', err);
      process.exit(1);
    });
  }
}

export { main as buildStatic };
export { generateStaticConfig };
