import React from 'react';
import type { Step } from '../types';
import { pretty } from './ui';

export default function StepDetails({ step, onClose }: { step: Step; onClose: () => void }): React.ReactElement {
  const tags = (() => { try { return step.tagsJson ? JSON.parse(step.tagsJson) : {}; } catch { return {}; } })() as any;
  const hasResult = !!step.resultJson && step.resultJson.length > 0;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white max-w-3xl w-full max-h-[85vh] overflow-auto rounded-2xl border p-4 shadow-xl">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">{step.title || step.key} <span className="text-gray-500 text-sm">— {step.status}</span></h2>
          <button className="px-3 py-1 border rounded" onClick={onClose}>Close</button>
        </div>
        <div className="border rounded p-2 mb-3 text-sm">
          <div><strong>Key:</strong> {step.key}</div>
          <div><strong>Job:</strong> {step.jobId}</div>
          {step.durationMs != null && (<div><strong>Duration:</strong> {step.durationMs} ms</div>)}
          {step.llmTokens != null && (<div><strong>Tokens:</strong> {step.llmTokens}</div>)}
          {tags?.refineDecision && (
            <div><strong>Refine decision:</strong> {String(tags.refineDecision)}{tags?.refineDetails?.count != null ? ` (${tags.refineDetails.count})` : ''}</div>
          )}
        </div>
        {step.prompt && (
          <div className="border rounded p-2 mb-3">
            <h3 className="font-medium mb-1">Prompt</h3>
            <pre className="text-xs whitespace-pre-wrap">{step.prompt}</pre>
          </div>
        )}
        {hasResult && (
          <div className="border rounded p-2 mb-3">
            <h3 className="font-medium mb-1">Result JSON</h3>
            <pre className="text-xs whitespace-pre-wrap">{pretty(step.resultJson)}</pre>
          </div>
        )}
        {!hasResult && tags.llmRaw && (
          <div className="border rounded p-2 mb-3">
            <h3 className="font-medium mb-1">LLM Response</h3>
            <pre className="text-xs whitespace-pre-wrap">{pretty(tags.llmRaw)}</pre>
          </div>
        )}
        {step.error && (
          <div className="border rounded p-2 mb-3">
            <h3 className="font-medium mb-1 text-rose-700">Error</h3>
            <pre className="text-xs whitespace-pre-wrap text-rose-700">{String(step.error)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
