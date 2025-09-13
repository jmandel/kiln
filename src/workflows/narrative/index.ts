import type { Artifact, Context, DocumentWorkflow, NarrativeInputs } from '../../types';
import { getTargets } from '../../prompts';
import { runLLMTask } from '../../llmTask';
import { registry } from '../../documentTypes/registry';

async function readBrief(ctx: Context, section: string): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByJob(
    ctx.jobId,
    (a: Artifact) => a.kind === 'SectionBrief' && a.tags?.section === section
  );
  return list.at(-1);
}

async function latestDraftVersion(ctx: Context, section: string): Promise<number> {
  const list = await ctx.stores.artifacts.listByJob(
    ctx.jobId,
    (a: Artifact) => a.kind === 'SectionDraft' && a.tags?.section === section
  );
  if (!list.length) return 1;
  return Math.max(...list.map((a: Artifact) => Number(a.version)));
}

async function readDraft(ctx: Context, section: string, version: number): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByJob(
    ctx.jobId,
    (a: Artifact) => a.kind === 'SectionDraft' && a.tags?.section === section && Number(a.version) === version
  );
  return list[0];
}

async function readNote(ctx: Context, version?: number): Promise<Artifact | undefined> {
  const list = await ctx.stores.artifacts.listByJob(ctx.jobId, (a: Artifact) => a.kind === 'NoteDraft');
  const arr = list.sort((a: Artifact, b: Artifact) => Number(b.version) - Number(a.version));
  if (version != null) return arr.find((a: Artifact) => Number(a.version) === version);
  return arr[0];
}

async function getPriorSectionsSummary(ctx: Context, currentSectionIndex: number, outline: any): Promise<string> {
  const approvedList =
    (await ctx.stores.artifacts.listByJob(
      ctx.jobId,
      (a: Artifact) => a.kind === 'SectionDraft' && a.tags?.action === 'approve'
    )) || [];
  const approvedSections = approvedList.sort(
    (a: any, b: any) =>
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
  const outlines = await ctx.stores.artifacts.listByJob(ctx.jobId, (a: Artifact) => a.kind === 'NarrativeOutline');
  const last = outlines.at(-1);
  if (last?.content) {
    try {
      return JSON.parse(last.content);
    } catch {
      /* ignore */
    }
  }
  return await (ctx as any).getStepResult?.('phase:planning:plan_outline');
}

function definePhase(
  _name: string,
  _boundaryTags: Record<string, any>,
  taskFns: Array<(ctx: Context, params?: any) => Promise<void>>
): (ctx: Context, params?: any) => Promise<void> {
  return async (ctx: Context, params?: any) => {
    for (const fn of taskFns) await fn(ctx, params);
  };
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
    let version = (await options.getLatestVersion(ctx, params.section || 'note')) ?? 1;
    let attempt = 1;
    while (attempt <= options.maxRevs) {
      await options.draftTask(ctx, version, params);
      const { score } = await options.critiqueTask(ctx, version, params);
      // Don't throw on low scores - let it retry up to maxRevs times
      // Log a warning if score is below approval threshold but continue trying
      if (options.approvalThreshold && score < options.approvalThreshold) {
        console.warn(
          `Low score warning: ${options.title || 'loop'} v${version} scored ${score} (below threshold ${options.approvalThreshold})`
        );
      }
      await options.decideTask(ctx, version, score, params);
      if (score >= options.target || attempt >= options.maxRevs) break;
      version++;
      attempt++;
    }
  };
}

function createPlanOutlineTask(sketch: string) {
  return async (ctx: Context) => {
    await runLLMTask<any>(
      ctx,
      'plan_outline',
      'plan_outline',
      { sketch },
      {
        expect: 'json',
        tags: { phase: 'planning' },
        artifact: {
          kind: 'NarrativeOutline',
          version: 1,
          title: 'Outline v1',
          tags: { phase: 'planning', responseJson: undefined },
          contentType: 'json',
        },
      }
    );
  };
}

function createRealizeOutlineTask() {
  return async (ctx: Context) => {
    const outline = await getOutlineFromSteps(ctx);
    const outlineArtifacts = await ctx.stores.artifacts.listByJob(ctx.jobId, (a: any) => a.kind === 'NarrativeOutline');
    const outlineArt = outlineArtifacts.at(-1);
    const oTags = outlineArt?.tags || {};
    for (const s of outline.sections) {
      await ctx.stores.artifacts.upsert({
        id: `artifact:${ctx.jobId}:SectionBrief:${s.title}:v1`,
        jobId: ctx.jobId,
        kind: 'SectionBrief',
        version: 1,
        title: `Brief: ${s.title}`,
        content: s.brief,
        tags: { section: s.title, phase: 'planning', prompt: oTags.prompt, raw: oTags.raw },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
    }
  };
}

function createSectionDraftTask(section: string, sectionIndex: number) {
  return async (ctx: Context, version: number, { section: sec, outline, sketch }: any) => {
    const brief = await readBrief(ctx, sec);
    const guidance = outline?.guidance || '';
    const priorSummary = await getPriorSectionsSummary(ctx, sectionIndex, outline);
    await runLLMTask<string>(
      ctx,
      'draft_section',
      'draft_section',
      { section: sec, brief: brief?.content || '', sketch, guidance, priorSummary },
      {
        expect: 'text',
        tags: { phase: 'sections', section: sec, version },
        artifact: {
          kind: 'SectionDraft',
          version,
          title: `Draft ${sec} v${version}`,
          tags: { section: sec, verb: 'draft' },
          links: [
            ...(brief ?
              [
                {
                  dir: 'from' as const,
                  role: 'uses',
                  ref: { type: 'artifact' as const, id: brief.id },
                },
              ]
            : []),
          ],
          contentType: 'text',
        },
      }
    );
  };
}

function createSectionCritiqueTask(section: string, sectionIndex: number) {
  return async (ctx: Context, version: number, { section: sec, outline, sketch }: any) => {
    const draft = await readDraft(ctx, sec, version);
    const brief = await readBrief(ctx, sec);
    const guidance = outline?.guidance || '';
    const priorSummary = await getPriorSectionsSummary(ctx, sectionIndex, outline);
    const TARGETS = getTargets();
    const { result: c, artifactId } = await runLLMTask<any>(
      ctx,
      'critique_section',
      'critique_section',
      {
        section: sec,
        draft: draft?.content || '',
        brief: brief?.content || '',
        sketch,
        guidance,
        priorSummary,
      },
      {
        expect: 'json',
        tags: { phase: 'sections', section: sec, version },
        artifact: {
          kind: 'SectionCritique',
          version: 1,
          title: `Critique ${sec} for v${version}`,
          tags: {
            section: sec,
            draftVersion: version,
            threshold: TARGETS.SECTION,
            verb: 'critique',
            responseJson: undefined,
          },
          links: [
            ...(draft ?
              [
                {
                  dir: 'from' as const,
                  role: 'critiques',
                  ref: { type: 'artifact' as const, id: draft.id },
                },
              ]
            : []),
          ],
          contentType: 'json',
        },
      }
    );
    if (artifactId) {
      const art = await ctx.stores.artifacts.get(artifactId);
      if (art)
        await ctx.stores.artifacts.upsert({
          ...art,
          tags: { ...(art.tags || {}), score: (c as any).score, responseJson: c },
        });
    }
    return { score: (c as any).score };
  };
}

function createSectionDecideTask(section: string) {
  const TARGETS = getTargets();
  return async (ctx: Context, version: number, score: number, { section: sec }: any) => {
    const approved = score >= TARGETS.SECTION;
    const draft = await readDraft(ctx, sec, version);
    const critList = await ctx.stores.artifacts.listByJob(
      ctx.jobId,
      (a: Artifact) => a.kind === 'SectionCritique' && a.tags?.draftVersion === version
    );
    const crit = critList.at(-1);
    await ctx.stores.artifacts.upsert({
      id: `artifact:${ctx.jobId}:Decision:${sec}:v${version}`,
      jobId: ctx.jobId,
      kind: 'Decision',
      version: 1,
      title: `${approved ? 'Approve' : 'Rewrite'} ${sec} v${version}`,
      content: `${approved ? 'approve' : 'rewrite'} ${sec} v${version}`,
      tags: {
        section: sec,
        draftVersion: version,
        action: approved ? 'approve' : 'rewrite',
        score,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
    if (approved && draft) await ctx.stores.artifacts.upsert({ ...draft, tags: { ...draft.tags, action: 'approve' } });
  };
}

function createNoteDraftTask(_initial: number) {
  return async (ctx: Context, ver: number, { outline, sketch }: any) => {
    const guidance = outline?.guidance || '';
    const sectionSummaries = await getSectionSummaries(ctx, outline);
    await runLLMTask<string>(
      ctx,
      'assemble_note',
      'assemble_note',
      { sketch, guidance, sectionSummaries },
      {
        expect: 'text',
        tags: { phase: 'note_review', version: ver },
        artifact: {
          kind: 'NoteDraft',
          version: ver,
          title: `Note Draft v${ver}`,
          tags: { verb: 'draft' },
          contentType: 'text',
        },
      }
    );
  };
}

function createNoteCritiqueTask(_initial: number) {
  return async (ctx: Context, ver: number, { outline, sketch }: any) => {
    const note = await readNote(ctx, ver);
    const guidance = outline?.guidance || '';
    const sectionSummaries = await getSectionSummaries(ctx, outline);
    const { result: c, artifactId } = await runLLMTask<any>(
      ctx,
      'critique_note',
      'critique_note',
      { noteDraft: note?.content || '', sketch, guidance, sectionSummaries },
      {
        expect: 'json',
        tags: { phase: 'note_review', version: ver },
        artifact: {
          kind: 'NoteCritique',
          version: 1,
          title: `Critique Note v${ver}`,
          tags: { noteVersion: ver, verb: 'critique' },
          links: [
            ...(note ?
              [
                {
                  dir: 'from' as const,
                  role: 'critiques',
                  ref: { type: 'artifact' as const, id: note.id },
                },
              ]
            : []),
          ],
          contentType: 'json',
        },
      }
    );
    if (artifactId) {
      const art = await ctx.stores.artifacts.get(artifactId);
      if (art)
        await ctx.stores.artifacts.upsert({
          ...art,
          tags: {
            ...(art.tags || {}),
            score: (c as any).score,
            threshold: getTargets().NOTE,
            responseJson: c,
          },
        });
    }
    return { score: (c as any).score };
  };
}

function createNoteDecideTask(_initial: number) {
  const TARGETS = getTargets();
  return async (ctx: Context, ver: number, score: number, _params: any) => {
    const approved = score >= TARGETS.NOTE;
    const note = await readNote(ctx, ver);
    const critList = await ctx.stores.artifacts.listByJob(
      ctx.jobId,
      (a: Artifact) => a.kind === 'NoteCritique' && a.tags?.noteVersion === ver
    );
    const crit = critList.at(-1);
    await ctx.stores.artifacts.upsert({
      id: `artifact:${ctx.jobId}:NoteDecision:v${ver}`,
      jobId: ctx.jobId,
      kind: 'NoteDecision',
      version: 1,
      title: `${approved ? 'Approve' : 'Rewrite'} Note v${ver}`,
      content: `${approved ? 'approve' : 'rewrite'} Note v${ver}`,
      tags: { noteVersion: ver, action: approved ? 'approve' : 'rewrite', score },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
    if (approved && note) await ctx.stores.artifacts.upsert({ ...note, tags: { ...note.tags, action: 'approve' } });
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

export function buildNarrativeWorkflow(inputs: NarrativeInputs): DocumentWorkflow<NarrativeInputs> {
  const TARGETS = getTargets();
  const planTask = createPlanOutlineTask(inputs.sketch);
  const planningPhase = definePhase('Planning', { phase: 'planning' }, [
    async (ctx) => await planTask(ctx),
    createRealizeOutlineTask(),
  ]);
  const sectionsPhase = definePhase('Sections', { phase: 'sections' }, [
    async (ctx) => {
      if (!(await ctx.isPhaseComplete('planning'))) await planningPhase(ctx, {});
      const outline = await getOutlineFromSteps(ctx);
      const sections = Array.isArray(outline?.sections) ? outline.sections : [];
      if (!sections.length)
        throw new Error('Outline missing/invalid (no sections). Check phase:planning:plan_outline step for errors.');
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
          title: `Section: ${sec.title}`,
        });
        await sectionLoop(ctx, { section: sec.title, outline, sketch: inputs.sketch });
      }
    },
  ]);
  const assemblyPhase = definePhase('Assembly', { phase: 'assembly' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const guidance = outline?.guidance || '';
      const sectionSummaries = outline ? await getSectionSummaries(ctx, outline) : '<sectionSummaries />';
      await runLLMTask<string>(
        ctx,
        'assemble_note',
        'assemble_note',
        { sketch: inputs.sketch, guidance, sectionSummaries },
        {
          expect: 'text',
          tags: { phase: 'assembly' },
          artifact: {
            kind: 'NoteDraft',
            version: 1,
            title: 'Note v1',
            tags: { phase: 'assembly' },
            contentType: 'text',
          },
        }
      );
    },
  ]);
  const noteReviewPhase = definePhase('Note Review', { phase: 'note_review' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const noteLoop = revisionLoop({
        target: TARGETS.NOTE,
        maxRevs: TARGETS.NOTE_MAX_REVS,
        approvalThreshold: TARGETS.NOTE * 0.8,
        getLatestVersion: async (ctx: Context) => {
          const list = await ctx.stores.artifacts.listByJob(
            (ctx as any).jobId,
            (a: Artifact) => a.kind === 'NoteDraft'
          );
          if (!list.length) return 1;
          return Math.max(...list.map((a: Artifact) => Number(a.version)));
        },
        draftTask: createNoteDraftTask(1),
        critiqueTask: createNoteCritiqueTask(1),
        decideTask: createNoteDecideTask(1),
        title: 'Note Revision',
      });
      await noteLoop(ctx, { outline, sketch: inputs.sketch });
    },
  ]);
  const finalizedPhase = definePhase('Finalized', { phase: 'finalized' }, [
    async (ctx) => {
      const latest = await readNote(ctx);
      const outline = await getOutlineFromSteps(ctx);
      const guidance = outline?.guidance || '';
      await runLLMTask<string>(
        ctx,
        'finalize_note',
        'finalize_note',
        { noteDraft: latest?.content || '', sketch: inputs.sketch, guidance },
        {
          expect: 'text',
          tags: { phase: 'finalized' },
          artifact: {
            kind: 'ReleaseCandidate',
            version: 1,
            title: 'RC v1',
            tags: { phase: 'finalized' },
            contentType: 'text',
          },
        }
      );
    },
  ]);
  return [planningPhase, sectionsPhase, assemblyPhase, noteReviewPhase, finalizedPhase];
}

registry.register('narrative', {
  inputsShape: { sketch: '' },
  buildWorkflow: buildNarrativeWorkflow,
});
