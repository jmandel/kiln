import type { ID, Artifact, Event, Link, Step } from './types';
import { EventHub } from './types';

export function sortByUpdatedAtAsc<T extends { updatedAt?: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
}

export function sortByTsAsc<T extends { ts?: string }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}

export function emitArtifactSaved(events: EventHub, a: Artifact): void {
  events.emit({
    type: 'artifact_saved',
    jobId: a.jobId,
    id: a.id,
    kind: a.kind,
    version: a.version,
    tags: a.tags || {}
  } as Event);
}

export function emitLinkSaved(events: EventHub, l: Link): void {
  events.emit({
    type: 'link_saved',
    jobId: l.jobId,
    id: l.id,
    role: l.role,
    fromType: l.fromType,
    fromId: l.fromId,
    toType: l.toType,
    toId: l.toId,
    tags: l.tags || {}
  } as Event);
}

export function emitStepSaved(
  events: EventHub,
  rec: Partial<Step> & { jobId: ID; key: string; status: Step['status']; ts: string }
): void {
  events.emit({
    type: 'step_saved',
    jobId: rec.jobId,
    key: rec.key,
    title: rec.title,
    status: rec.status,
    parentKey: rec.parentKey,
    tags: rec.tagsJson ? JSON.parse(rec.tagsJson) : {},
    durationMs: rec.durationMs,
    llmTokens: rec.llmTokens,
    prompt: rec.prompt,
    ts: rec.ts
  } as Event);
}
