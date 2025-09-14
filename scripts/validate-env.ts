// scripts/validate-env.ts
#!/usr/bin/env bun
/**
 * Validates PUBLIC_KILN_* environment variables
 * Ensures config.json will be complete and valid
 */

import { generateConfig } from '../src/config/generateConfig';

function validateEnvironment() {
  console.log('🔍 Validating environment for Kiln...\n');
  try {
    const config = generateConfig('runtime');
    console.log('📋 Generated Configuration Preview:');
    console.log('='.repeat(50));
    console.log(`Environment: ${config.environment}`);
    console.log(`Source: ${config.source}`);
    console.log(`Version: ${config.version}`);
    console.log('');
    console.log(`LLM Base URL: ${config.baseURL}`);
    console.log(`Model: ${config.model}`);
    console.log(`Temperature: ${config.temperature}`);
    console.log('');
    console.log(`FHIR Base URL: ${config.fhirBaseURL}`);
    console.log(`Validation Services: ${config.validationServicesURL || '[auto-detect]'}`);
    console.log(`FHIR Concurrency: ${config.fhirGenConcurrency}`);
    console.log('');
    console.log(`Debug Mode: ${config.debugMode ? 'enabled' : 'disabled'}`);
    console.log(`Max Retries: ${config.maxRetries}`);
    console.log(`LLM Max Concurrency: ${config.llmMaxConcurrency}`);
    console.log('');
    console.log(`Generated: ${new Date(config.generatedAt).toLocaleString()}`);

    const required = ['baseURL', 'model', 'fhirBaseURL'] as const;
    const issues: string[] = [];
    for (const key of required) {
      const value = config[key];
      if (!value || value === '') issues.push(`❌ ${String(key)} is empty`);
    }
    if (!config.baseURL.startsWith('http')) issues.push(`❌ baseURL must start with http:// or https://`);
    if (!config.fhirBaseURL.startsWith('http')) issues.push(`❌ fhirBaseURL must start with http:// or https://`);
    if (!config.model.includes('/')) issues.push(`⚠️  Model should use "provider/model" format: ${config.model}`);
    if (config.temperature < 0 || config.temperature > 2)
      issues.push(`⚠️  Temperature should be 0-2: ${config.temperature}`);
    if (config.fhirGenConcurrency < 1 || config.fhirGenConcurrency > 8)
      issues.push(`⚠️  FHIR concurrency should be 1-8: ${config.fhirGenConcurrency}`);

    console.log('\n' + '='.repeat(50));
    if (issues.length === 0) {
      console.log('✅ All validations passed!');
      console.log('\n🚀 Ready to build or deploy');
      console.log('\n💡 Commands:');
      console.log('   bun run dev              # Development server');
      console.log('   bun run build            # Production static build');
      console.log('   bun run preview          # Production server');
      console.log('   bun run serve:static     # Serve static build');
      process.exit(0);
    } else {
      console.log('\n⚠️  Issues found:');
      issues.forEach((issue) => console.log(`   ${issue}`));
      console.log('\n🔧 Fix these issues:');
      console.log('   1. Check .env.local or environment variables');
      console.log('   2. Set PUBLIC_KILN_LLM_URL and PUBLIC_KILN_FHIR_BASE_URL');
      console.log('   3. Ensure URLs start with http:// or https://');
      console.log('   4. See .env.example for format');
      if (issues.some((i) => i.startsWith('❌'))) process.exit(1);
      console.log('\nℹ️  Warnings only - build will succeed but review settings');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n💥 Configuration generation failed:', error);
    console.error('\n🔧 This is a critical error. Check:');
    console.error('   1. All PUBLIC_KILN_* variables are properly set');
    console.error('   2. URLs are valid (start with http:// or https://)');
    console.error('   3. No syntax errors in .env.local');
    process.exit(1);
  }
}

if (import.meta.main) {
  validateEnvironment();
}

