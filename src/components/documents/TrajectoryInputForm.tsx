import React, { useState } from 'react';
import type { TrajectoryInputs } from '../../types';

export function TrajectoryInputForm({
  initialInputs,
  onSubmit,
  onCancel,
}: {
  initialInputs?: Partial<TrajectoryInputs>;
  onSubmit: (inputs: TrajectoryInputs) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [trajectorySketch, setTrajectorySketch] = useState(initialInputs?.trajectorySketch ?? '');

  const handleSubmit = () => {
    const trimmed = trajectorySketch.trim();
    if (!trimmed) {
      alert('Provide a patient trajectory sketch that describes the longitudinal journey.');
      return;
    }
    onSubmit({ trajectorySketch: trimmed });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-text-charcoal mb-1">Patient Trajectory Sketch</label>
        <textarea
          className="input-kiln w-full min-h-[160px]"
          placeholder="e.g., 45F with breast cancer: diagnosis Jan 2023, chemo Mar, remission check Jul, recurrence signs Dec, follow-up Feb 2024"
          value={trajectorySketch}
          onChange={(e) => setTrajectorySketch(e.target.value)}
        />
        <p className="text-xs text-gray-500 mt-1">
          Describe the longitudinal journey using natural language and timing cues. The system will infer 3-8 episodes automatically.
        </p>
      </div>
      <div className="flex justify-end gap-3">
        <button className="btn-kiln-outline" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-kiln" onClick={handleSubmit}>
          Create Trajectory
        </button>
      </div>
    </div>
  );
}

export function TrajectoryPreview({ document }: { document: { inputs: TrajectoryInputs } }): React.ReactElement {
  const sketch = document.inputs?.trajectorySketch || '';
  return (
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">Trajectory Sketch</h3>
      <p className="text-sm whitespace-pre-line bg-gray-50 border border-gray-200 rounded-md p-3">{sketch || 'No sketch provided.'}</p>
    </div>
  );
}
