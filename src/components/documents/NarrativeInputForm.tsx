import React, { useState } from 'react';
import type { NarrativeInputs } from '../../types';

export const NarrativeInputForm: React.FC<{
  stores?: any;
  initialInputs?: Partial<NarrativeInputs>;
  onSubmit: (inputs: NarrativeInputs) => void;
  onCancel: () => void;
}> = ({ initialInputs, onSubmit, onCancel }) => {
  const [sketch, setSketch] = useState(initialInputs?.sketch || '');

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Patient Sketch</label>
        <textarea
          value={sketch}
          onChange={(e) => setSketch(e.target.value)}
          placeholder="E.g., '52F with chest pain, onset 2 weeks ago'"
          className="input-kiln w-full h-32"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-kiln-outline px-4 py-2" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-kiln px-4 py-2"
          onClick={() => {
            if (sketch.trim()) onSubmit({ sketch });
          }}
        >
          Create
        </button>
      </div>
    </div>
  );
};

export const NarrativePreview: React.FC<{ document: { inputs: NarrativeInputs } }> = ({ document }) => {
  const text = document?.inputs?.sketch || '';
  return (
    <div className="prose max-w-none">
      <pre className="whitespace-pre-wrap text-sm">{text}</pre>
    </div>
  );
};
