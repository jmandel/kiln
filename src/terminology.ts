// Unified terminology module
// Prefer V2 inline resolver and provide a light compatibility wrapper.

export { resolveResourceCodes } from './terminologyResolverV2';
export { resolveResourceCodesWithLogs, type AttemptLogByPointer, type TermAttempt } from './terminologyResolverV2';

// Back-compat alias for external callers that expect a generic name
export { resolveResourceCodes as resolveTerminology } from './terminologyResolverV2';

// Compatibility wrapper for legacy callers expecting { resources, resolutions }
export async function resolveAllPlaceholders(ctx: any, resources: any[]): Promise<{ resources: any[]; resolutions: any[] }> {
  const resolved = await resolveResourceCodes(ctx, resources);
  // V2 stitches codes in place; we don't track per-code decisions here.
  // Return empty resolutions to satisfy old return shape without duplicating logic.
  return { resources: resolved, resolutions: [] };
}
