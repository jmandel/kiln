import { PROMPTS } from './prompts';
import type { Context, Artifact } from './types';

export function buildPrompt(key: keyof typeof PROMPTS, params: any): string {
  const template = PROMPTS[key];
  return template(params as any);
}

type LinkInput = { dir: 'from' | 'to'; role: string; ref: { type: 'artifact' | 'step'; id: string } };

export async function runLLMTask<T = any>(
  ctx: Context,
  modelTask: string,
  promptKey: keyof typeof PROMPTS,
  params: any,
  opts: {
    expect: 'text' | 'json';
    tags?: Record<string, any>;
    artifact?: {
      kind: string;
      version?: number;
      title: string;
      tags?: Record<string, any>;
      links?: LinkInput[];
      contentType?: 'text' | 'json';
    };
  }
): Promise<{ result: T; meta: any; artifactId?: string }> {
  const prompt = buildPrompt(promptKey, params);
  const { result, meta } = await (ctx as any).callLLMEx(modelTask, prompt, { expect: opts.expect, tags: opts.tags || {} });

  if (opts.artifact) {
    const content = opts.artifact.contentType === 'json'
      ? JSON.stringify(result, null, 2)
      : String(result ?? '');
    const links: LinkInput[] = [ ...(opts.artifact.links || []), { dir: 'from', role: 'produced', ref: { type: 'step', id: meta.stepKey } } ];
    const art = await ctx.createArtifact({
      kind: opts.artifact.kind,
      version: opts.artifact.version ?? 1,
      title: opts.artifact.title,
      content,
      tags: { ...(opts.artifact.tags || {}), prompt: meta.prompt, raw: meta.raw },
      links
    } as Artifact);
    return { result, meta, artifactId: art.id };
  }

  return { result, meta };
}
