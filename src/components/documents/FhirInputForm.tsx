import React, { useEffect, useState } from 'react';
import type { FhirInputs, Stores } from '../../types';

export const FhirInputForm: React.FC<{
  stores?: Stores;
  initialInputs?: Partial<FhirInputs>;
  onSubmit: (inputs: FhirInputs) => void;
  onCancel: () => void;
}> = ({ stores, initialInputs, onSubmit, onCancel }) => {
  const [noteText, setNoteText] = useState(initialInputs?.noteText || '');
  const [sourceJobId, setSourceJobId] = useState(initialInputs?.source?.jobId || '');
  const [sourceArtId, setSourceArtId] = useState(initialInputs?.source?.artifactId || '');
  const [availableDocs, setAvailableDocs] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    if (!stores) return;
    (async () => {
      const jobs = await stores.jobs.all();
      const narr = jobs.filter((d: any) => d.type === 'narrative');
      setAvailableDocs(narr.map((d: any) => ({ id: d.id, title: d.title })));
    })();
  }, [stores]);

  const handleChainSelect = async (jobId: string) => {
    if (!stores || !jobId) {
      setSourceJobId('');
      setSourceArtId('');
      return;
    }
    const arts = await stores.artifacts.listByJob(jobId, (a) => a.kind === 'ReleaseCandidate');
    const latest = arts.sort((a, b) => b.version - a.version)[0];
    if (latest?.content) {
      setNoteText(latest.content);
      setSourceJobId(jobId);
      setSourceArtId(latest.id);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Note Text</label>
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Paste or enter note text here..."
          className="input-kiln w-full h-32"
        />
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-1">Or chain from an existing Narrative:</p>
        <select className="input-kiln w-full" onChange={(e) => handleChainSelect(e.target.value)} value={sourceJobId}>
          <option value="">Select a Narrative job...</option>
          {availableDocs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title} ({d.id.slice(-6)})
            </option>
          ))}
        </select>
      </div>
      {sourceJobId && sourceArtId && (
        <div className="text-xs text-green-700 p-2 bg-green-50 rounded">
          Chained from: {sourceJobId.slice(-8)} / {sourceArtId.slice(-8)}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button className="btn-kiln-outline px-4 py-2" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-kiln px-4 py-2"
          onClick={() => {
            if (noteText.trim())
              onSubmit({
                noteText,
                source: sourceJobId && sourceArtId ? { jobId: sourceJobId, artifactId: sourceArtId } : undefined,
              });
          }}
        >
          Create
        </button>
      </div>
    </div>
  );
};

export const FhirPreview: React.FC<{ document: { inputs: FhirInputs } }> = ({ document }) => {
  const text = document?.inputs?.noteText || '';
  return (
    <div className="prose max-w-none">
      <pre className="whitespace-pre-wrap text-sm">{text}</pre>
    </div>
  );
};
