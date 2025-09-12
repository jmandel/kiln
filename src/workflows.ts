import type { Stores, ID, Artifact, Context } from './types';
import { extractSections, canonicalizeHeader, renderSectionNarrative } from './sections';
import { sha256, nowIso } from './helpers';
import { getTargets, PROMPTS } from './prompts';
import { runLLMTask, buildPrompt as buildLLMPrompt } from './llmTask';
import { makeContext, runWorkflow, PauseForApprovalError } from './engine';
import { validateResource } from './validator';
import { analyzeCodings, finalizeUnresolved } from './codingAnalysis';
import { generateAndRefineResources } from './services/fhirGeneration';
import { emitJsonArtifact } from './services/artifacts';
import { IPS_NOTES } from './ips-notes';

// Helpers

async function readBrief(ctx: Context, section: string): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'SectionBrief' && a.tags?.section === section);
  return list.at(-1);
}

async function latestDraftVersion(ctx: Context, section: string): Promise<number> {
  const list = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'SectionDraft' && a.tags?.section === section);
  if (!list.length) return 1;
  return Math.max(...list.map((a: Artifact) => Number(a.version)));
}

async function readDraft(ctx: Context, section: string, version: number): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) =>
    a.kind === 'SectionDraft' && a.tags?.section === section && Number(a.version) === version
  );
  return list[0];
}

async function readNote(ctx: Context, version?: number): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'NoteDraft');
  const arr = list.sort((a: Artifact, b: Artifact) => Number(b.version) - Number(a.version));
  if (version != null) return arr.find((a: Artifact) => Number(a.version) === version);
  return arr[0];
}

async function getPriorSectionsSummary(ctx: Context, currentSectionIndex: number, outline: any): Promise<string> {
  const approvedList = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) =>
    a.kind === 'SectionDraft' && a.tags?.action === 'approve'
  ) || [];
  const approvedSections = approvedList.sort((a: any, b: any) =>
    outline.sections.findIndex((s: any) => s.title === (a.tags?.section || '')) -
    outline.sections.findIndex((s: any) => s.title === (b.tags?.section || ''))
  );
  const priors = approvedSections
    .slice(0, currentSectionIndex)
    .map((a: Artifact) => `<section name="${a.tags?.section}">${(a.content || '').substring(0, 200)}...</section>`) 
    .join('\n');
  return priors || '<priorSections>No prior sections.</priorSections>';
}

async function getOutlineFromSteps(ctx: Context): Promise<any> {
  const outlines = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'NarrativeOutline');
  const last = outlines.at(-1);
  if (last?.content) {
    try { return JSON.parse(last.content); } catch { /* ignore */ }
  }
  return await (ctx as any).getStepResult?.('phase:planning:plan_outline');
}

function buildPrompt(key: keyof typeof PROMPTS, params: any): string { return buildLLMPrompt(key, params); }

function definePhase(_name: string, _boundaryTags: Record<string, any>, taskFns: Array<(ctx: Context, params?: any) => Promise<void>>): (ctx: Context, params?: any) => Promise<void> {
  return async (ctx: Context, params?: any) => {
    for (const taskFn of taskFns) await taskFn(ctx, params);
  };
}

// Produce a short id suffix from a hash so we keep ids consistent (e.g., "composition-<8>")
async function shortHash(seed: string, len: number = 8): Promise<string> {
  const h = await sha256(seed);
  return h.slice(0, len);
}

function revisionLoop(options: {
  title?: string;
  target: number;
  maxRevs: number;
  approvalThreshold?: number;
  getLatestVersion: (ctx: Context, key: string) => Promise<number>;
  draftTask: (ctx: Context, version: number, params: any) => Promise<void>;
  critiqueTask: (ctx: Context, version: number, params: any) => Promise<{ score: number }>;
  decideTask: (ctx: Context, version: number, score: number, params: any) => Promise<void>;
}) {
  return async (ctx: Context, params: any) => {
    let version = await options.getLatestVersion(ctx, (params).section || 'note') ?? 1;
    let attempt = 1;
    while (attempt <= options.maxRevs) {
      await options.draftTask(ctx, version, params);
      const { score } = await options.critiqueTask(ctx, version, params);
      if (options.approvalThreshold && score < options.approvalThreshold) {
        throw new PauseForApprovalError(`rev:${options.title || 'loop'}:v${version}`, `Score ${score} < threshold ${options.approvalThreshold}; approve/revise?`);
      }
      await options.decideTask(ctx, version, score, params);
      if (score >= options.target || attempt >= options.maxRevs) break;
      version++;
      attempt++;
    }
  };
}

// Workflow Tasks
function createPlanOutlineTask(sketch: string) {
  return async (ctx: Context) => {
    const { result: outline } = await runLLMTask<any>(ctx, 'plan_outline', 'plan_outline', { sketch }, {
      expect: 'json',
      tags: { phase: 'planning' },
      artifact: { kind: 'NarrativeOutline', version: 1, title: 'Outline v1', tags: { phase: 'planning', responseJson: undefined }, contentType: 'json' }
    });
  };
}

function createRealizeOutlineTask() {
  return async (ctx: Context) => {
    const outline = await getOutlineFromSteps(ctx);
    // Find the NarrativeOutline artifact to propagate prompt/raw
    const outlineArtifacts = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: any) => a.kind === 'NarrativeOutline');
    const outlineArt = outlineArtifacts.at(-1);
    const oTags = outlineArt?.tags || {};
    for (const s of outline.sections) {
      await emitJsonArtifact(ctx, {
        kind: 'SectionBrief',
        title: `Brief: ${s.title}`,
        content: s.brief,
        tags: { section: s.title, phase: 'planning', prompt: oTags.prompt, raw: oTags.raw },
        links: outlineArt ? [ { dir: 'from' as const, role: 'derived_from', ref: { type: 'artifact' as const, id: outlineArt.id } } ] : undefined
      });
    }
  };
}

function createSectionDraftTask(section: string, sectionIndex: number) {
  return async (ctx: Context, version: number, { section: sec, outline, sketch }: any) => {
    const brief = await readBrief(ctx, sec);
    const guidance = outline?.guidance || '';
    const priorSummary = await getPriorSectionsSummary(ctx, sectionIndex, outline);
    await runLLMTask<string>(ctx, 'draft_section', 'draft_section', { section: sec, brief: brief?.content || '', sketch, guidance, priorSummary }, {
      expect: 'text',
      tags: { phase: 'sections', section: sec, version },
      artifact: { kind: 'SectionDraft', version, title: `Draft ${sec} v${version}`, tags: { section: sec, verb: 'draft' }, links: [ ...(brief ? [{ dir: 'from' as const, role: 'uses', ref: { type: 'artifact' as const, id: brief.id } }] : []) ], contentType: 'text' }
    });
  };
}

function createSectionCritiqueTask(section: string, sectionIndex: number) {
  return async (ctx: Context, version: number, { section: sec, outline, sketch }: any) => {
    const draft = await readDraft(ctx, sec, version);
    const brief = await readBrief(ctx, sec);
    const guidance = outline?.guidance || '';
    const priorSummary = await getPriorSectionsSummary(ctx, sectionIndex, outline);
    const TARGETS = getTargets();
    const { result: c, artifactId } = await runLLMTask<any>(ctx, 'critique_section', 'critique_section', { section: sec, draft: draft?.content || '', brief: brief?.content || '', sketch, guidance, priorSummary }, {
      expect: 'json', tags: { phase: 'sections', section: sec, version },
      artifact: { kind: 'SectionCritique', version: 1, title: `Critique ${sec} for v${version}`, tags: { section: sec, draftVersion: version, threshold: TARGETS.SECTION, verb: 'critique', responseJson: undefined }, links: [ ...(draft ? [{ dir: 'from' as const, role: 'critiques', ref: { type: 'artifact' as const, id: draft.id } }] : []) ], contentType: 'json' }
    });
    // Update tags with computed score/responseJson on the created artifact if available
    if (artifactId) {
      const art = await ctx.stores.artifacts.get(artifactId);
      if (art) {
        await ctx.stores.artifacts.upsert({ ...art, tags: { ...(art.tags || {}), score: c.score, responseJson: c } });
      }
    }
    return { score: (c as any).score };
  };
}

function createSectionDecideTask(section: string) {
  const TARGETS = getTargets();
  return async (ctx: Context, version: number, score: number, { section: sec }: any) => {
    const approved = score >= TARGETS.SECTION;
    const draft = await readDraft(ctx, sec, version);
    const critList = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'SectionCritique' && a.tags?.draftVersion === version);
    const crit = critList.at(-1);
    await emitJsonArtifact(ctx, {
      kind: 'Decision',
      title: `${approved ? 'Approve' : 'Rewrite'} ${sec} v${version}`,
      content: `${approved ? 'approve' : 'rewrite'} ${sec} v${version}`,
      tags: { section: sec, draftVersion: version, action: approved ? 'approve' : 'rewrite', score },
      links: [ draft ? { dir: 'from', role: 'decides_on', ref: { type: 'artifact', id: draft.id } } : undefined, crit ? { dir: 'from', role: 'based_on', ref: { type: 'artifact', id: crit.id } } : undefined ].filter(Boolean) as any
    });
    if (approved && draft) {
      await ctx.stores.artifacts.upsert({
        ...draft,
        tags: { ...draft.tags, action: 'approve' }
      });
    }
  };
}

function createNoteDraftTask(_initial: number) {
  // draftTask will be invoked as (ctx, ver, params)
  return async (ctx: Context, ver: number, { outline, sketch }: any) => {
    const guidance = outline?.guidance || '';
    const sectionSummaries = await getSectionSummaries(ctx, outline);
    await runLLMTask<string>(ctx, 'assemble_note', 'assemble_note', { sketch, guidance, sectionSummaries }, { expect: 'text', tags: { phase: 'note_review', version: ver }, artifact: { kind: 'NoteDraft', version: ver, title: `Note Draft v${ver}`, tags: { verb: 'draft' }, contentType: 'text' } });
  };
}

function createNoteCritiqueTask(_initial: number) {
  // critiqueTask will be invoked as (ctx, ver, params)
  return async (ctx: Context, ver: number, { outline, sketch }: any) => {
    const note = await readNote(ctx, ver);
    const guidance = outline?.guidance || '';
    const sectionSummaries = await getSectionSummaries(ctx, outline);
    const { result: c, artifactId } = await runLLMTask<any>(ctx, 'critique_note', 'critique_note', { noteDraft: note?.content || '', sketch, guidance, sectionSummaries }, {
      expect: 'json', tags: { phase: 'note_review', version: ver },
      artifact: { kind: 'NoteCritique', version: 1, title: `Critique Note v${ver}`, tags: { noteVersion: ver, verb: 'critique' }, links: [ ...(note ? [{ dir: 'from' as const, role: 'critiques', ref: { type: 'artifact' as const, id: note.id } }] : []) ], contentType: 'json' }
    });
    if (artifactId) {
      const art = await ctx.stores.artifacts.get(artifactId);
      if (art) {
        await ctx.stores.artifacts.upsert({ ...art, tags: { ...(art.tags || {}), score: (c as any).score, threshold: getTargets().NOTE, responseJson: c } });
      }
    }
    return { score: (c as any).score };
  };
}

function createNoteDecideTask(_initial: number) {
  const TARGETS = getTargets();
  // decideTask will be invoked as (ctx, ver, score, params)
  return async (ctx: Context, ver: number, score: number, _params: any) => {
    const approved = score >= TARGETS.NOTE;
    const note = await readNote(ctx, ver);
    const critList = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'NoteCritique' && a.tags?.noteVersion === ver);
    const crit = critList.at(-1);
    await emitJsonArtifact(ctx, {
      kind: 'NoteDecision',
      title: `${approved ? 'Approve' : 'Rewrite'} Note v${ver}`,
      content: `${approved ? 'approve' : 'rewrite'} Note v${ver}`,
      tags: { noteVersion: ver, action: approved ? 'approve' : 'rewrite', score },
      links: [ note ? { dir: 'from', role: 'decides_on', ref: { type: 'artifact', id: note.id } } : undefined, crit ? { dir: 'from', role: 'based_on', ref: { type: 'artifact', id: crit.id } } : undefined ].filter(Boolean) as any
    });
    if (approved && note) {
      await ctx.stores.artifacts.upsert({
        ...note,
        tags: { ...note.tags, action: 'approve' }
      });
    }
  };
}


async function getSectionSummaries(ctx: Context, outline: any): Promise<string> {
  if (!outline || !Array.isArray(outline.sections)) return '<sectionSummaries />';
  let summaries = '';
  for (const sec of outline.sections) {
    const v = await latestDraftVersion(ctx, sec.title);
    const draft = await readDraft(ctx, sec.title, v);
    summaries += `<section name="${sec.title}">${(draft?.content || '').substring(0, 200)}...</section>\n`;
  }
  return `<sectionSummaries>${summaries}</sectionSummaries>`;
}

function buildDocumentWorkflow(input: { title: string; sketch: string }) {
  const TARGETS = getTargets();
  const planTask = createPlanOutlineTask(input.sketch);

  const planningPhase = definePhase(
    'Planning',
    { phase: 'planning' },
    [
      async (ctx) => await planTask(ctx),
      createRealizeOutlineTask()
    ]
  );

  const sectionsPhase = definePhase(
    'Sections',
    { phase: 'sections' },
    [
      async (ctx) => {
        if (!(await ctx.isPhaseComplete('planning'))) {
          await planningPhase(ctx, {});
        }
        const outline = await getOutlineFromSteps(ctx);
        const sections = Array.isArray(outline?.sections) ? outline.sections : [];
        if (!sections.length) {
          throw new Error('Outline missing/invalid (no sections). Check phase:planning:plan_outline step for errors.');
        }
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i];
          const sectionLoop = revisionLoop({
            target: TARGETS.SECTION,
            maxRevs: TARGETS.SECTION_MAX_REVS,
            approvalThreshold: TARGETS.SECTION * 0.8,
            getLatestVersion: latestDraftVersion,
            draftTask: createSectionDraftTask(sec.title, i),
            critiqueTask: createSectionCritiqueTask(sec.title, i),
            decideTask: createSectionDecideTask(sec.title),
            title: `Section: ${sec.title}`
          });
          await sectionLoop(ctx, { section: sec.title, outline, sketch: input.sketch });
        }
      }
    ]
  );

  const assemblyPhase = definePhase('Assembly', { phase: 'assembly' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const guidance = outline?.guidance || '';
      const sectionSummaries = outline ? await getSectionSummaries(ctx, outline) : '<sectionSummaries />';
      await runLLMTask<string>(ctx, 'assemble_note', 'assemble_note', { sketch: input.sketch, guidance, sectionSummaries }, { expect: 'text', tags: { phase: 'assembly' }, artifact: { kind: 'NoteDraft', version: 1, title: 'Note v1', tags: { phase: 'assembly' }, contentType: 'text' } });
    }
  ]);

  const noteReviewPhase = definePhase('Note Review', { phase: 'note_review' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const noteLoop = revisionLoop({
        target: TARGETS.NOTE,
        maxRevs: TARGETS.NOTE_MAX_REVS,
        approvalThreshold: TARGETS.NOTE * 0.8,
        getLatestVersion: async (ctx: Context) => {
          const list = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a: Artifact) => a.kind === 'NoteDraft');
          if (!list.length) return 1;
          return Math.max(...list.map((a: Artifact) => Number(a.version)));
        },
        draftTask: createNoteDraftTask(1),
        critiqueTask: createNoteCritiqueTask(1),
        decideTask: createNoteDecideTask(1),
        title: 'Note Revision'
      });
      await noteLoop(ctx, { outline, sketch: input.sketch });
    }
  ]);

  const finalizedPhase = definePhase('Finalized', { phase: 'finalized' }, [
    async (ctx) => {
      const latest = await readNote(ctx);
      const outline = await getOutlineFromSteps(ctx);
      const guidance = outline?.guidance || '';
      await runLLMTask<string>(ctx, 'finalize_note', 'finalize_note', { noteDraft: latest?.content || '', sketch: input.sketch, guidance }, { expect: 'text', tags: { phase: 'finalized' }, artifact: { kind: 'ReleaseCandidate', version: 1, title: 'RC v1', tags: { phase: 'finalized' }, contentType: 'text' } });
    }
  ]);

  const fhirEncodingPhase = definePhase('FHIR Encoding', { phase: 'fhir' }, [
    async (ctx) => {
      // 1. Get the final narrative text
      const releaseCandidateArtifacts = await ctx.stores.artifacts.listByDocument(ctx.documentId, (a) => a.kind === 'ReleaseCandidate');
      const releaseCandidate = releaseCandidateArtifacts.sort((a,b) => b.version - a.version)[0];
      if (!releaseCandidate?.content) {
        throw new Error('ReleaseCandidate note not found to start FHIR encoding.');
      }
      const note_text = releaseCandidate.content;

      // 2. Create the Composition plan, aligning sections with the drafted note (## headings)
      // Match H2 sections across the whole note; support CRLF and LF
      const noteSections = extractSections(note_text);
      const sectionTitles: string[] = [];
      for (const [canonTitle, _content] of noteSections) {
        // We need the original titles in-order; extractSections preserved order but canonicalizes keys.
        // So re-parse titles from the note in-order using the same regex to get original case/spacing.
      }
      // Simpler: re-walk the note to preserve original titles using the same regex logic
      {
        const rx = /(?:^|\r?\n)##\s*(.*?)\s*\r?\n/g;
        let m: RegExpExecArray | null;
        while ((m = rx.exec(note_text)) !== null) {
          const title = (m[1] || '').trim();
          if (title) sectionTitles.push(title);
        }
      }
      try { console.log('[FHIR][plan] Section titles detected:', sectionTitles.join(' | ')); } catch {}
      const ipsComp = IPS_NOTES?.Composition;
      const ips_notes = Array.isArray(ipsComp?.requirements) ? ipsComp?.requirements : undefined;
      const ips_example = typeof ipsComp?.example === 'string' ? ipsComp.example : undefined;
      const compositionPrompt = buildPrompt('fhir_composition_plan', { note_text, section_titles: sectionTitles, ips_notes, ips_example });
      const { result: planResult, meta: planMeta } = await runLLMTask<any>(ctx, 'fhir_composition_plan', 'fhir_composition_plan', { note_text, section_titles: sectionTitles, ips_notes, ips_example }, { expect: 'json', tags: { phase: 'fhir' } });
      let compositionPlan = stitchSectionNarratives(planResult, note_text);
      await emitJsonArtifact(ctx, { kind: 'FhirCompositionPlan', title: 'FHIR Composition Plan', content: compositionPlan, tags: { phase: 'fhir', prompt: planMeta.prompt, raw: planMeta.raw }, links: [ { dir: 'to', role: 'produced', ref: { type: 'step', id: planMeta.stepKey } } ] });

      // 3. Extract all placeholder references and generate resources in parallel
      const references: { reference: string, display: string }[] = [];
      if (Array.isArray(compositionPlan.section)) {
        for (const section of compositionPlan.section) {
          if (Array.isArray(section.entry)) {
            for (const entry of section.entry) {
              if (entry.reference && entry.display) {
                references.push({ reference: entry.reference, display: entry.display });
              }
            }
          }
        }
      }

      // Capture subject/encounter references from the Composition to reuse in resource generation
      // Support both Reference-object and bare-string forms from the LLM plan
      const subjectRef = (typeof compositionPlan?.subject === 'string')
        ? compositionPlan.subject
        : (compositionPlan?.subject?.reference as string | undefined);
      const subjectDisplay = (typeof compositionPlan?.subject === 'object' && compositionPlan?.subject?.display) ? compositionPlan.subject.display : undefined;
      const encounterRef = (typeof compositionPlan?.encounter === 'string')
        ? compositionPlan.encounter
        : (compositionPlan?.encounter?.reference as string | undefined);
      const encounterDisplay = (typeof compositionPlan?.encounter === 'object' && compositionPlan?.encounter?.display) ? compositionPlan.encounter.display : undefined;
      // Capture author references from Composition (if present)
      const authorRefs: Array<{ reference: string; display?: string }> = [];
      const addAuthorRef = (v: any) => {
        if (!v) return;
        if (typeof v === 'string') {
          authorRefs.push({ reference: v });
          return;
        }
        if (typeof v === 'object' && v.reference) {
          authorRefs.push({ reference: v.reference, display: v.display });
        }
      };
      if (Array.isArray(compositionPlan?.author)) {
        for (const a of compositionPlan.author) addAuthorRef(a);
      } else if (compositionPlan?.author) {
        addAuthorRef(compositionPlan.author);
      }

      // Generate + validate-refine per resource via service (emits per-resource artifacts + traces)
      // Ensure Patient and Encounter referenced in the Composition are included in generation list
      const ensureRef = (arr: Array<{ reference: string; display?: string }>, reference?: string, displayMaybe?: string) => {
        if (!reference) return;
        if (arr.some(r => r.reference === reference)) return;
        const entry: { reference: string; display?: string } = { reference };
        if (displayMaybe && String(displayMaybe).trim()) entry.display = displayMaybe;
        arr.push(entry);
      };
      ensureRef(references, subjectRef, subjectDisplay);
      ensureRef(references, encounterRef, encounterDisplay);
      // Ensure any Composition.author references are included so we generate Practitioner resources
      for (const a of authorRefs) ensureRef(references, a.reference, a.display || 'Author');

      const generatedResources: any[] = await generateAndRefineResources(ctx, note_text, references, subjectRef, encounterRef);

      // Let LLM outputs stand; we only pass subject_ref/encounter_ref as guidance in the prompt.

      // 4. Analyze codings and produce pre-recoding report
      const preHash = await sha256(JSON.stringify(generatedResources));
      const { report: preReport } = await ctx.step(`analyze_codings:${preHash}`, async () => {
        return await analyzeCodings(generatedResources);
      }, { title: 'Analyze Codings (pre)', tags: { phase: 'fhir', contentHash: preHash } });
      await emitJsonArtifact(ctx, { kind: 'CodingValidationReport', title: 'Coding Validation Report (pre-recoding)', content: { items: preReport }, tags: { phase: 'fhir', stage: 'pre' } });

      // Prepare a working copy for any subsequent recoding/refine steps
      const recodedResources: any[] = JSON.parse(JSON.stringify(generatedResources));

      // 6. Analyze again (post-refine placeholder; no pre-recoding stage now) and create reports
      const postHash = await sha256(JSON.stringify(recodedResources));
      const { report: postReport } = await ctx.step(`analyze_codings_post:${postHash}`, async () => {
        return await analyzeCodings(recodedResources);
      }, { title: 'Analyze Codings (post)', tags: { phase: 'fhir', contentHash: postHash } });
      await emitJsonArtifact(ctx, { kind: 'CodingValidationReport', title: 'Coding Validation Report (post-recoding)', content: { items: postReport }, tags: { phase: 'fhir', stage: 'post' } });

      // 7. Finalize unresolved in-place with extensions
      const unresolvedPointers = postReport.filter((i: any) => i.status !== 'ok').map((i: any) => i.pointer);
      const finalResources = unresolvedPointers.length ? finalizeUnresolved(recodedResources, unresolvedPointers, attemptLogs) : recodedResources;

      // Create artifacts for final resources
      for (let i = 0; i < finalResources.length; i++) {
        const r: any = finalResources[i];
        const ref = references[i];
        await emitJsonArtifact(ctx, { kind: 'FhirResource', title: ref?.reference || `${r.resourceType}/${r.id || ''}` , content: r, tags: { phase: 'fhir', resourceType: r.resourceType, coded: true, from: ref?.display } });
      }


      // 5. Stitch the final bundle
      const finalComposition = { ...compositionPlan } as any;
      // Normalize subject/encounter to Reference objects for valid FHIR
      if (typeof finalComposition.subject === 'string') {
        finalComposition.subject = { reference: finalComposition.subject };
      }
      if (typeof finalComposition.encounter === 'string') {
        finalComposition.encounter = { reference: finalComposition.encounter };
      }
      if (!finalComposition.id) {
        finalComposition.id = `composition-${await shortHash(ctx.documentId + ':' + Date.now())}`;
      } else if (typeof finalComposition.id === 'string' && finalComposition.id.length > 64) {
        finalComposition.id = String(finalComposition.id).slice(0, 64);
      }
      // Clean up the display fields from the final composition's references
      if (Array.isArray(finalComposition.section)) {
        for (const section of finalComposition.section) {
          if (Array.isArray(section.entry)) {
            for (const entry of section.entry) {
              delete entry.display; // Remove the descriptive text, keeping only the reference
            }
          }
        }
      }

      const fhirBase = (typeof localStorage !== 'undefined' && (localStorage.getItem('FHIR_BASE_URL') || localStorage.getItem('FHIR_BASE') )) || 'https://kiln.fhir.me';
      const base = String(fhirBase).replace(/\/$/, '');
      // Ensure Composition.identifier has a system consistent with the configured base (singleton Identifier)
      try {
        if (finalComposition?.id) {
          if (!finalComposition.identifier || typeof finalComposition.identifier !== 'object' || Array.isArray(finalComposition.identifier)) {
            finalComposition.identifier = { value: finalComposition.id };
          }
          if (!finalComposition.identifier.value) {
            finalComposition.identifier.value = finalComposition.id;
          }
          // Avoid placeholder example.org as a system; only set when a real base is configured
          if (!/fhir\.example\.org$/i.test(base)) {
            finalComposition.identifier.system = `${base}/Composition`;
          } else {
            delete finalComposition.identifier.system;
          }
        }
      } catch {}
      const bundleId = `bundle-${await shortHash(ctx.documentId)}`;
      const bundle = {
          resourceType: "Bundle",
          type: "document",
          id: bundleId,
          timestamp: nowIso(),
          identifier: (function(){
            const value = (finalComposition?.identifier && typeof finalComposition.identifier === 'object' && !Array.isArray(finalComposition.identifier) && finalComposition.identifier.value)
              ? finalComposition.identifier.value
              : finalComposition.id;
            const idObj: any = { value, system: `${base}/Bundle` };
            return idObj;
          })(),
          entry: [
            { fullUrl: `${base}/${finalComposition.resourceType || 'Composition'}/${finalComposition.id}`, resource: finalComposition },
            ...finalResources.map((r: any) => ({
              fullUrl: `${base}/${r.resourceType}/${r.id || ''}`,
              resource: r
            }))
          ]
      };

      // Prune empty arrays (and objects that become empty) anywhere in the bundle
      (function pruneDeep(node: any): boolean {
        if (node == null) return true;
        if (Array.isArray(node)) {
          for (let i = node.length - 1; i >= 0; i--) {
            if (pruneDeep(node[i])) node.splice(i, 1);
          }
          return node.length === 0;
        }
        if (typeof node === 'object') {
          for (const k of Object.keys(node)) {
            const v = (node as any)[k];
            if (pruneDeep(v)) delete (node as any)[k];
          }
          return Object.keys(node).length === 0;
        }
        return false;
      })(bundle);

      await emitJsonArtifact(ctx, { kind: 'FhirBundle', title: 'FHIR Document Bundle', content: bundle, tags: { phase: 'fhir' } });

      // Validate and create report (content-addressed step key; strict: includes timestamp)
      const bundleHash = await sha256(JSON.stringify(bundle));
      const validateStepKey = `validate_bundle:${bundleHash}`;
      const validationResult = await (ctx as any).step?.(validateStepKey, async () => {
        return await validateResource(bundle);
      }, { title: 'Validate FHIR Bundle', tags: { phase: 'fhir', bundleHash } });
      await emitJsonArtifact(ctx, {
        kind: 'ValidationReport',
        title: 'FHIR Bundle Validation Report',
        content: validationResult,
        tags: { phase: 'fhir', valid: validationResult?.valid, bundleHash },
        links: [ { dir: 'to', role: 'produced', ref: { type: 'step', id: validateStepKey } } ]
      });
      if (!validationResult.valid) {
          console.warn('FHIR Bundle is not valid', validationResult.issues);
      }
    }
  ]);

  return [planningPhase, sectionsPhase, assemblyPhase, noteReviewPhase, finalizedPhase, fhirEncodingPhase];
}

function stitchSectionNarratives(compositionPlan: any, noteText: string): any {
    // 1. Parse the original note into sections based on Markdown H2s (shared helper)
    const noteSections = extractSections(noteText);
    // Debug: list parsed H2 titles in order
    try {
      const titles: string[] = [];
      const rx = /(?:^|\r?\n)##\s*(.*?)\s*\r?\n/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(noteText)) !== null) {
        const t = (m[1] || '').trim(); if (t) titles.push(t);
      }
      console.log('[FHIR][stitch] Parsed H2 sections:', titles.join(' | '));
    } catch {}

    // 2. Iterate through the composition and stitch in the narratives
    if (Array.isArray(compositionPlan.section)) {
        for (const section of compositionPlan.section) {
            if (section.text?.div) {
                // Accept both {{## Section Title}} and {{Section Title}} forms
                const placeholderMatch = String(section.text.div).match(/\{\{\s*(?:##\s*)?(.*?)\s*\}\}/);
                if (placeholderMatch && placeholderMatch[1]) {
                    const titleToFind = placeholderMatch[1].trim();
                    const originalDiv = String(section.text.div);
                    const raw = noteSections.get(titleToFind.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim());
                    const rendered = renderSectionNarrative(noteText, titleToFind);
                    try {
                      const lineCount = raw ? raw.split(/\r?\n/).length : 0;
                      const charCount = raw ? raw.length : 0;
                      const firstLines = raw ? raw.split(/\r?\n/).slice(0, 3).join('\n') : '';
                      const lastLines = raw ? raw.split(/\r?\n/).slice(-3).join('\n') : '';
                      console.log('[FHIR][stitch] Placeholder found', {
                        title: titleToFind,
                        lines: lineCount,
                        chars: charCount,
                        placeholder: originalDiv,
                        firstLines,
                        lastLines,
                        hasRendered: !!rendered
                      });
                    } catch {}
                    if (rendered != null) {
                        section.text.div = rendered;
                        section.text.status = 'additional';
                        try {
                          const brCount = (rendered.match(/<br\/>/g) || []).length;
                          console.log('[FHIR][stitch] Inserted narrative:', { title: titleToFind, brCount, renderedLen: rendered.length });
                        } catch {}
                    } else {
                        // If no matching section is found, leave a note in the div
                        section.text.div = `<div xmlns="http://www.w3.org/1999/xhtml">Narrative for section '${titleToFind}' not found in source note.</div>`;
                        section.text.status = 'additional';
                        try { console.warn('[FHIR][stitch] No matching section found for placeholder', { title: titleToFind }); } catch {}
                    }
                }
            }
            // leave section fields unchanged besides narrative stitching
        }
    }

    // 3. Ensure Composition.identifier is present and consistent with id (singleton Identifier)
    try {
        const cid = typeof compositionPlan?.id === 'string' ? compositionPlan.id.trim() : '';
        if (cid) {
            const current = compositionPlan.identifier;
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                compositionPlan.identifier = { value: cid };
            }
        }
    } catch {}
    return compositionPlan;
}

// canonicalizeHeader is provided by ./sections

export async function runDocumentWorkflow(stores: Stores, input: { title: string; sketch: string }): Promise<void> {
  const documentId = `doc:${await sha256(input.title + ':' + input.sketch)}`;
  const workflowId = `wf:${await sha256(documentId + ':' + Date.now())}`;
  await stores.documents.create(documentId, input.title, input.sketch);
  await stores.workflows.create(workflowId, documentId, 'document_drafting');
  const pipeline = buildDocumentWorkflow(input);
  await runWorkflow(stores, workflowId, documentId, pipeline);
}

// Resume workflows for a specific document, even if the workflow status is 'done',
// as long as there are pending/running/failed steps for that document.
export async function resumeDocument(stores: Stores, documentId: ID): Promise<void> {
  try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.begin', documentId })); } catch {}
  const doc = await stores.documents.get(documentId);
  if (!doc || !doc.sketch) return;
  const input = { title: doc.title, sketch: doc.sketch };

  // Find candidate workflow IDs from steps for this document
  const steps = await stores.steps.listByDocument(documentId);
  // Do not mutate cached steps on resume.
  // Step replay reuses only "done" steps; failed/pending steps will rerun.
  // LLM steps are keyed by sha256(prompt), so prompt changes naturally bypass cache.
  const byWf = new Map<ID, { pending: number; running: number; failed: number }>();
  for (const s of steps) {
    const cur = byWf.get(s.workflowId as ID) || { pending: 0, running: 0, failed: 0 };
    if (s.status === 'pending') cur.pending++;
    if (s.status === 'running') cur.running++;
    if (s.status === 'failed') cur.failed++;
    byWf.set(s.workflowId as ID, cur);
  }

  const pipeline = buildDocumentWorkflow(input);
  const wfIds = Array.from(byWf.entries())
    .filter(([_, c]) => c.pending > 0 || c.running > 0 || c.failed > 0)
    .map(([wfId]) => wfId);

  if (wfIds.length) {
    // Clear prior artifacts/links for a clean replay output (keep steps for cache/replay)
    try {
      const clear = (function(){
        try {
          const v = localStorage.getItem('CLEAR_STEPS_ON_RESUME');
          return v != null && !/^0|false|off$/i.test(v);
        } catch { return false; }
      })();
      if (clear) {
        await stores.steps.deleteByDocument(documentId);
        console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.clear_steps', documentId }));
      }
    } catch {}
    await stores.artifacts.deleteByDocument(documentId);
    await stores.links.deleteByDocument(documentId);
    // Proactively emit clear events to ensure UI refresh even if store backend doesn't
    try { stores.events.emit({ type: 'artifacts_cleared', documentId } as any); } catch {}
    try { stores.events.emit({ type: 'links_cleared', documentId } as any); } catch {}
    for (const wfId of wfIds) {
      await stores.workflows.setStatus(wfId, 'running');
      try {
        await runWorkflow(stores, wfId, documentId, pipeline);
      } catch (e) {
        try { console.error('[WF] resumeDocument error', e); } catch {}
      }
    }
    try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.end', documentId, mode: 'resume', workflows: wfIds })); } catch {}
    return;
  }
  // All steps may be done, but we still want a replay (cached) for debugging.
  // Pick the workflowId of the most recent step and run the pipeline; caching will replay quickly.
  const latestStep = steps.slice().sort((a, b) => b.ts.localeCompare(a.ts))[0];
  const replayWfId = latestStep?.workflowId as ID | undefined;
  if (replayWfId) {
    await stores.artifacts.deleteByDocument(documentId);
    await stores.links.deleteByDocument(documentId);
    await stores.workflows.setStatus(replayWfId, 'running');
    try {
      await runWorkflow(stores, replayWfId, documentId, pipeline);
    } catch (e) {
      try { console.error('[WF] resumeDocument replay error', e); } catch {}
    }
  }
  try { console.log('[WF]', JSON.stringify({ ts: new Date().toISOString(), type: 'resume.end', documentId, mode: 'replay', workflowId: replayWfId })); } catch {}
  return;
}
// Artifacts are created directly using callLLMEx metadata
