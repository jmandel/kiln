import React, { useState } from 'react';
import { tolerantJsonParse, resolveTaskConfig } from '../helpers';
import { searchTerminology } from '../tools';
import { buildPickerPrompt } from '../terminologyResolverV2';

type LogItem = { type: string; data: any };

export default function CodingResolverTester({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState<string>(`{
  "system": "http://snomed.info/sct",
  "display": "Referral to rheumatologist (procedure)"
}`);
  const [systems, setSystems] = useState<string>("");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [running, setRunning] = useState(false);
  const append = (item: LogItem) => setLogs(prev => [...prev, item]);

  async function uiCallLLM(task: string, prompt: string): Promise<{ raw: string; parsed: any }> {
    const cfg = resolveTaskConfig(task);
    const headers: any = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const body = {
      model: cfg.model,
      temperature: cfg.temperature,
      messages: [ { role: 'user', content: prompt } ]
    };
    const res = await fetch(`${cfg.baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? '';
    const parsed = tolerantJsonParse(raw);
    return { raw, parsed };
  }

  async function run() {
    setRunning(true); setLogs([]);
    try {
      const coding = tolerantJsonParse(input) || {};
      const potentialDisplays = coding.display ? [String(coding.display)] : [];
      let potentialSystems: string[] = [];
      if (systems.trim()) potentialSystems = systems.split(',').map((s: string)=>s.trim()).filter(Boolean);
      else if (coding.system) potentialSystems = [String(coding.system)];

      let currentQuery = potentialDisplays[0] || '';
      const attempted: string[] = [];
      const maxTurns = 5;
      const resourceType = 'TestResource';
      const placeholder = { path: 'code', jsonPointer: '/code', potentialDisplays, potentialSystems } as any;
      for (let turn = 0; turn < maxTurns; turn++) {
        const q = String(currentQuery || '').trim();
        const res = q ? await searchTerminology(q, potentialSystems, 200) : { hits: [] } as any;
        attempted.push(currentQuery);
        append({ type: 'search', data: { query: q, systems: potentialSystems, count: res.count, guidance: res.guidance, fullSystem: res.fullSystem } });
        const prompt = buildPickerPrompt(placeholder, resourceType, res.hits || [], attempted, maxTurns - turn, { supportedSystems: [], bigSystems: [], builtinFhirCodeSystems: [] }, res.guidance, { count: res.count, fullSystem: res.fullSystem });
        append({ type: 'prompt', data: prompt });
        const { raw, parsed } = await uiCallLLM('terminology_picker', prompt);
        append({ type: 'response', data: raw });

        const decision = parsed || {};
        append({ type: 'decision', data: decision });
        if (decision.action === 'pick' && decision.selection) {
          const valid = (res.hits || []).find((h: any) => h.system === decision.selection.system && h.code === decision.selection.code);
          if (valid) {
            append({ type: 'final', data: { system: decision.selection.system, code: decision.selection.code, display: decision.selection.display || valid.display } });
            break;
          }
        }
        if (decision.action === 'search' && decision.terms && turn < maxTurns - 1) {
          const nextQuery = Array.isArray(decision.terms) ? decision.terms.join(' ') : String(decision.terms || '');
          if (attempted.map(s => s.toLowerCase()).includes(String(nextQuery).toLowerCase())) {
            append({ type: 'repeat_guard', data: { nextQuery } });
            break;
          }
          currentQuery = nextQuery;
          continue;
        }
        append({ type: 'unresolved', data: { reason: decision.reason || 'no_valid_pick' } });
        break;
      }
    } catch (e: any) {
      append({ type: 'error', data: String(e?.message || e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-4 w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Coding Resolver Tester</h2>
          <button className="text-sm px-2 py-1 border rounded" onClick={onClose}>Close</button>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Coding JSON</label>
            <textarea className="w-full h-40 border rounded p-2 font-mono text-xs" value={input} onChange={e=>setInput(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Systems (comma-separated, optional)</label>
            <input className="w-full border rounded p-2 text-sm" placeholder="http://snomed.info/sct,http://loinc.org" value={systems} onChange={e=>setSystems(e.target.value)} />
            <div className="mt-3">
              <button className="px-3 py-1.5 border rounded shadow-sm text-sm" disabled={running} onClick={run}>{running ? 'Running…' : 'Run'}</button>
            </div>
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-1">Log</h3>
          <div className="space-y-2">
            {logs.map((l, i)=> (
              <details key={i} open>
                <summary className="text-sm"><strong>{l.type}</strong></summary>
                <pre className="bg-gray-50 border rounded p-2 text-xs overflow-auto">{typeof l.data === 'string' ? l.data : JSON.stringify(l.data, null, 2)}</pre>
              </details>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

