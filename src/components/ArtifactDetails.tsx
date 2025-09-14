import React from 'react';
import type { Stores, Artifact, Step, Link, ID } from '../types';
import { tryJson, pretty } from './ui';

export default function ArtifactDetails({
  stores,
  jobId,
  artifactId,
  onClose,
  onOpenArtifact,
  fullPage = false,
}: {
  stores: Stores;
  jobId: ID;
  artifactId: ID;
  onClose: () => void;
  onOpenArtifact?: (id: ID) => void;
  fullPage?: boolean;
}): React.ReactElement {
  const [artifact, setArtifact] = React.useState<Artifact | null>(null);
  const [links, setLinks] = React.useState<Link[]>([]);
  const [steps, setSteps] = React.useState<Step[]>([]);
  const [expandAll, setExpandAll] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      const art = await stores.artifacts.get(artifactId);
      setArtifact(art || null);
      const allLinks = await stores.links.listByJob(jobId);
      setLinks(allLinks);
      const allSteps = await stores.steps.listByJob(jobId);
      setSteps(allSteps);
    })();
  }, [stores, jobId, artifactId]);

  if (!artifact) return <div className="p-4">Loading…</div>;

  // Build a single, interleaved list of producing + contributing steps
  const roleByStepId = new Map<string, 'produced' | 'contributed'>();
  for (const l of links) {
    if (l.toType === 'artifact' && l.toId === artifact.id && l.fromType === 'step') {
      const role =
        l.role === 'produced' ? 'produced'
        : l.role === 'contributed' ? 'contributed'
        : undefined;
      if (role) {
        // If a step is both contributed and produced, prefer produced
        const prev = roleByStepId.get(l.fromId);
        if (!prev || role === 'produced') roleByStepId.set(l.fromId, role);
      }
    }
  }
  const stepList = steps
    .filter((s) => roleByStepId.has(s.key))
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .map((s) => ({ step: s, role: roleByStepId.get(s.key) as 'produced' | 'contributed' }));
  // Flat chronological list only; no iteration headers (reduces confusion)
  const hideMetaLLM = stepList.length > 0; // If steps are present, their prompts/raw supersede artifact-level copies
  const relatedArtifacts = (role: string) => {
    const ids = links
      .filter(
        (l) => l.role === role && l.fromType === 'artifact' && l.fromId === artifact.id && l.toType === 'artifact'
      )
      .map((l) => l.toId);
    return ids;
  };

  const contentIsJson = !!tryJson(artifact.content);
  const renderContent = () => {
    if (!artifact.content) return <div className="text-sm text-gray-500">No content.</div>;
    if (contentIsJson) return <pre className="text-sm whitespace-pre-wrap">{pretty(artifact.content)}</pre>;
    // Markdown render minimal: rely on browser; or simple pre
    return <pre className="text-sm whitespace-pre-wrap">{artifact.content}</pre>;
  };

  const tags = artifact.tags || ({} as any);

  const Container = ({ children }: { children: React.ReactNode }) =>
    fullPage ?
      <div className="min-h-screen bg-white text-gray-900">
        <div className="max-w-4xl mx-auto p-6">{children}</div>
      </div>
    : <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
        <div className="bg-white max-w-4xl w-full max-h-[85vh] overflow-auto rounded-2xl border p-4 shadow-xl">
          {children}
        </div>
      </div>;

  const handleClose = () => {
    if (fullPage) {
      if (window.history.length > 1) window.history.back();
      else window.close();
    } else onClose();
  };

  return (
    <Container>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">
          {artifact.title}{' '}
          <span className="text-gray-500 text-sm">
            ({artifact.kind} v{artifact.version})
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1 text-sm border rounded" onClick={() => setExpandAll((v) => !v)}>
            {expandAll ? 'Collapse all' : 'Expand all'}
          </button>
          <button className="px-3 py-1 border rounded" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>

      <div className="border rounded p-2 mb-3 text-sm">
        <div>
          <strong>ID:</strong> {artifact.id}
        </div>
        <div>
          <strong>Created:</strong> {artifact.createdAt}
        </div>
      </div>

      <div className="border rounded p-2 mb-3">
        <h3 className="font-medium mb-1">Steps</h3>
        {stepList.length === 0 ?
          <div className="text-sm text-gray-500">No step links for this artifact.</div>
        : stepList.map(({ step: s, role }) => {
            const stags = s.tagsJson ? JSON.parse(s.tagsJson) : {};
            const title = s.title || s.key;
            const hasResult = !!s.resultJson && s.resultJson.length > 0;
            const isValidation = (title || '').toLowerCase().includes('validate');
            let parsed: any = undefined;
            try {
              parsed = s.resultJson ? JSON.parse(s.resultJson) : undefined;
            } catch {}
            const hasInputOutput =
              isValidation && parsed && typeof parsed === 'object' && parsed.input && parsed.result;
            return (
              <div key={s.key} className="mb-2">
                <div className="flex items-center gap-2">
                  <div>
                    <strong>{title}</strong> — {s.status}{' '}
                    {role ?
                      <span className="text-xs text-gray-500">[{role}]</span>
                    : null}
                  </div>
                  {stags.refineDecision && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${stags.refineDecision === 'accepted' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
                    >
                      {String(stags.refineDecision)}
                    </span>
                  )}
                </div>
                {s.prompt && (
                  <details open={expandAll}>
                    <summary>Prompt</summary>
                    <pre className="text-xs whitespace-pre-wrap">{s.prompt}</pre>
                  </details>
                )}
                {hasInputOutput ?
                  <>
                    <details open={expandAll}>
                      <summary>Input Resource</summary>
                      <pre className="text-xs whitespace-pre-wrap">{pretty(JSON.stringify(parsed.input))}</pre>
                    </details>
                    <details open={expandAll}>
                      <summary>Validation Result</summary>
                      <pre className="text-xs whitespace-pre-wrap">{pretty(JSON.stringify(parsed.result))}</pre>
                    </details>
                    {parsed?.terminology ?
                      <details open={expandAll}>
                        <summary>Terminology Report</summary>
                        <pre className="text-xs whitespace-pre-wrap">{pretty(JSON.stringify(parsed.terminology))}</pre>
                      </details>
                    : null}
                  </>
                : s.resultJson && (
                    <details open={expandAll}>
                      <summary>Result JSON</summary>
                      <pre className="text-xs whitespace-pre-wrap">
                        {JSON.stringify(JSON.parse(s.resultJson), null, 2)}
                      </pre>
                    </details>
                  )
                }
                {(() => {
                  const invalid = (stags as any)?.refineDetails?.invalid;
                  if (!Array.isArray(invalid) || invalid.length === 0) return null;
                  const looksLikePatch = (arr: any[]) =>
                    arr.some((x) => x && (typeof x.op === 'string' || typeof x.path === 'string'));
                  let toShow: any[] = invalid;
                  if (!looksLikePatch(invalid)) {
                    try {
                      const raw = (stags as any)?.llmRaw;
                      const parsed = raw ? JSON.parse(raw) : null;
                      const p = parsed && Array.isArray(parsed.patch) ? parsed.patch : null;
                      if (p && p.length) toShow = p;
                    } catch {}
                  }
                  return (
                    <details open={expandAll}>
                      <summary>Invalid Proposals</summary>
                      <pre className="text-xs whitespace-pre-wrap">{pretty(JSON.stringify(toShow))}</pre>
                    </details>
                  );
                })()}
                {stags?.refineDetails?.partials &&
                  Array.isArray(stags.refineDetails.partials) &&
                  stags.refineDetails.partials.length > 0 && (
                    <details open={expandAll}>
                      <summary>Partial Update Issues</summary>
                      <pre className="text-xs whitespace-pre-wrap">
                        {pretty(JSON.stringify(stags.refineDetails.partials))}
                      </pre>
                    </details>
                  )}
                {stags.llmRaw && !hasResult && (
                  <details open={expandAll}>
                    <summary>LLM Response</summary>
                    <pre className="text-xs whitespace-pre-wrap">{pretty(stags.llmRaw)}</pre>
                  </details>
                )}
              </div>
            );
          })
        }
      </div>

      <div className="border rounded p-2 mb-3">
        <h3 className="font-medium mb-1">Artifact Metadata</h3>
        {!hideMetaLLM && tags.prompt && (
          <details open={expandAll}>
            <summary>Prompt</summary>
            <pre className="text-xs whitespace-pre-wrap">{String(tags.prompt)}</pre>
          </details>
        )}
        {!hideMetaLLM && tags.raw && !tags.responseJson && (
          <details open={expandAll}>
            <summary>LLM Response</summary>
            <pre className="text-xs whitespace-pre-wrap">{pretty(tags.raw)}</pre>
          </details>
        )}
        {tags.responseJson && (
          <details open={expandAll}>
            <summary>Response JSON</summary>
            <pre className="text-xs whitespace-pre-wrap">{pretty(tags.responseJson)}</pre>
          </details>
        )}
        {typeof tags.score === 'number' && (
          <div className="text-sm">
            <strong>Score:</strong> {tags.score}
            {tags.threshold ? ` / threshold ${tags.threshold}` : ''}
          </div>
        )}
      </div>

      <div className="border rounded p-2 mb-3">
        <h3 className="font-medium mb-1">Artifact Content</h3>
        {renderContent()}
      </div>

      {relatedArtifacts('uses').length || relatedArtifacts('critiques').length || relatedArtifacts('based_on').length ?
        <div className="border rounded p-2 mb-2">
          <h3 className="font-medium mb-1">Related</h3>
          {relatedArtifacts('uses').length ?
            <div className="text-sm mb-1">
              <strong>Uses:</strong>{' '}
              {relatedArtifacts('uses').map((id) => (
                <button key={id} className="underline mr-2" onClick={() => onOpenArtifact && onOpenArtifact(id)}>
                  {id}
                </button>
              ))}
            </div>
          : null}
          {relatedArtifacts('critiques').length ?
            <div className="text-sm mb-1">
              <strong>Critiques:</strong>{' '}
              {relatedArtifacts('critiques').map((id) => (
                <button key={id} className="underline mr-2" onClick={() => onOpenArtifact && onOpenArtifact(id)}>
                  {id}
                </button>
              ))}
            </div>
          : null}
          {relatedArtifacts('based_on').length ?
            <div className="text-sm mb-1">
              <strong>Based on:</strong>{' '}
              {relatedArtifacts('based_on').map((id) => (
                <button key={id} className="underline mr-2" onClick={() => onOpenArtifact && onOpenArtifact(id)}>
                  {id}
                </button>
              ))}
            </div>
          : null}
        </div>
      : null}
    </Container>
  );
}
