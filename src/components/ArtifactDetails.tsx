import React from 'react';
import type { Stores, Artifact, Step, Link, ID } from '../types';
import { tryJson, pretty } from './ui';

export default function ArtifactDetails({ stores, documentId, artifactId, onClose, onOpenArtifact, fullPage = false }: { stores: Stores; documentId: ID; artifactId: ID; onClose: () => void; onOpenArtifact?: (id: ID) => void; fullPage?: boolean }): React.ReactElement {
  const [artifact, setArtifact] = React.useState<Artifact | null>(null);
  const [links, setLinks] = React.useState<Link[]>([]);
  const [steps, setSteps] = React.useState<Step[]>([]);

  React.useEffect(() => {
    (async () => {
      const art = await stores.artifacts.get(artifactId);
      setArtifact(art || null);
      const allLinks = await stores.links.listByDocument(documentId);
      setLinks(allLinks);
      const allSteps = await stores.steps.listByDocument(documentId);
      setSteps(allSteps);
    })();
  }, [stores, documentId, artifactId]);

  if (!artifact) return (<div className="p-4">Loading…</div>);

  const prodSteps = steps.filter(s => links.some(l => l.role === 'produced' && l.toType === 'artifact' && l.toId === artifact.id && l.fromType === 'step' && l.fromId === s.key));
  const relatedArtifacts = (role: string) => {
    const ids = links.filter(l => l.role === role && l.fromType === 'artifact' && l.fromId === artifact.id && l.toType === 'artifact').map(l => l.toId);
    return ids;
  };

  const contentIsJson = !!tryJson(artifact.content);
  const renderContent = () => {
    if (!artifact.content) return (<div className="text-sm text-gray-500">No content.</div>);
    if (contentIsJson) return (<pre className="text-sm whitespace-pre-wrap">{pretty(artifact.content)}</pre>);
    // Markdown render minimal: rely on browser; or simple pre
    return (<pre className="text-sm whitespace-pre-wrap">{artifact.content}</pre>);
  };

  const tags = artifact.tags || {} as any;

  const Container = ({ children }: { children: React.ReactNode }) => fullPage
    ? (<div className="min-h-screen bg-white text-gray-900"><div className="max-w-4xl mx-auto p-6">{children}</div></div>)
    : (<div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"><div className="bg-white max-w-4xl w-full max-h-[85vh] overflow-auto rounded-2xl border p-4 shadow-xl">{children}</div></div>);

  const handleClose = () => {
    if (fullPage) {
      if (window.history.length > 1) window.history.back(); else window.close();
    } else onClose();
  };

  return (
    <Container>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">{artifact.title} <span className="text-gray-500 text-sm">({artifact.kind} v{artifact.version})</span></h2>
          <button className="px-3 py-1 border rounded" onClick={handleClose}>Close</button>
        </div>

        <div className="border rounded p-2 mb-3 text-sm">
          <div><strong>ID:</strong> {artifact.id}</div>
          <div><strong>Created:</strong> {artifact.createdAt}</div>
        </div>

        <div className="border rounded p-2 mb-3">
          <h3 className="font-medium mb-1">Producing Steps</h3>
          {prodSteps.length === 0 ? (<div className="text-sm text-gray-500">No explicit producing step link.</div>) : prodSteps.map(s => {
            const stags = s.tagsJson ? JSON.parse(s.tagsJson) : {};
            return (
              <div key={s.key} className="mb-2">
                <div><strong>{s.title || s.key}</strong> — {s.status}</div>
                {s.prompt && (<details open><summary>Prompt</summary><pre className="text-xs whitespace-pre-wrap">{s.prompt}</pre></details>)}
                {s.resultJson && (<details><summary>Result JSON</summary><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(JSON.parse(s.resultJson), null, 2)}</pre></details>)}
                {stags.llmRaw && (<details><summary>Raw LLM</summary><pre className="text-xs whitespace-pre-wrap">{pretty(stags.llmRaw)}</pre></details>)}
              </div>
            );
          })}
        </div>

        <div className="border rounded p-2 mb-3">
          <h3 className="font-medium mb-1">Artifact Metadata</h3>
          {tags.prompt && (<details open><summary>Prompt</summary><pre className="text-xs whitespace-pre-wrap">{String(tags.prompt)}</pre></details>)}
          {tags.raw && (<details open><summary>Raw LLM Response</summary><pre className="text-xs whitespace-pre-wrap">{pretty(tags.raw)}</pre></details>)}
          {tags.responseJson && (<details open><summary>Response JSON</summary><pre className="text-xs whitespace-pre-wrap">{pretty(tags.responseJson)}</pre></details>)}
          {typeof tags.score === 'number' && (<div className="text-sm"><strong>Score:</strong> {tags.score}{tags.threshold ? ` / threshold ${tags.threshold}` : ''}</div>)}
        </div>

        <div className="border rounded p-2 mb-3">
          <h3 className="font-medium mb-1">Artifact Content</h3>
          {renderContent()}
        </div>

        {(relatedArtifacts('uses').length || relatedArtifacts('critiques').length || relatedArtifacts('based_on').length) ? (
          <div className="border rounded p-2 mb-2">
            <h3 className="font-medium mb-1">Related</h3>
            {relatedArtifacts('uses').length ? (
              <div className="text-sm mb-1"><strong>Uses:</strong> {relatedArtifacts('uses').map(id => (<button key={id} className="underline mr-2" onClick={()=> onOpenArtifact && onOpenArtifact(id)}>{id}</button>))}</div>
            ) : null}
            {relatedArtifacts('critiques').length ? (
              <div className="text-sm mb-1"><strong>Critiques:</strong> {relatedArtifacts('critiques').map(id => (<button key={id} className="underline mr-2" onClick={()=> onOpenArtifact && onOpenArtifact(id)}>{id}</button>))}</div>
            ) : null}
            {relatedArtifacts('based_on').length ? (
              <div className="text-sm mb-1"><strong>Based on:</strong> {relatedArtifacts('based_on').map(id => (<button key={id} className="underline mr-2" onClick={()=> onOpenArtifact && onOpenArtifact(id)}>{id}</button>))}</div>
            ) : null}
          </div>
        ) : null}
    </Container>
  );
}
