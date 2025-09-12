import type { Context } from '../types';

export async function emitJsonArtifact(
  ctx: Context,
  opts: {
    kind: string;
    title: string;
    version?: number;
    content: any;
    tags?: Record<string, any>;
    links?: Array<{ dir: 'from' | 'to'; role: string; ref: { type: 'artifact' | 'step' | 'document' | 'workflow'; id: string } }>;
    autoProduced?: boolean; // default false to avoid accidental linking to whatever step is active
  }
) {
  const { kind, title, version = 1, content, tags, links, autoProduced = false } = opts;
  const json = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return ctx.createArtifact({ kind, version, title, content: json, tags, links, autoProduced });
}
