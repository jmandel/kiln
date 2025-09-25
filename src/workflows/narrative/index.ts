import type { Artifact, Context, DocumentWorkflow, ID, Job, NarrativeInputs } from '../../types';
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
      (a: Artifact) => a.kind === 'SectionDraft'
    )) || [];
  const approvedSections = approvedList.sort(
    (a: any, b: any) =>
      outline.sections.findIndex((s: any) => s.title === (a.tags?.section || '')) -
      outline.sections.findIndex((s: any) => s.title === (b.tags?.section || ''))
  );
  const priors = approvedSections
    .slice(0, currentSectionIndex)
    .map((a: Artifact) => `<section name="${a.tags?.section}">${a.content || ''}</section>`)
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

async function getLatestReleaseCandidate(ctx: Context, jobId: ID): Promise<Artifact | undefined> {
  const artifacts = await ctx.stores.artifacts.listByJob(jobId, (a: Artifact) => a.kind === 'ReleaseCandidate');
  if (!artifacts.length) return undefined;
  return artifacts.sort((a, b) => Number(b.version) - Number(a.version))[0];
}

async function collectPriorNarrativeJobs(ctx: Context): Promise<Job[]> {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  let current = await ctx.stores.jobs.get(ctx.jobId);
  while (current && Array.isArray(current.dependsOn) && current.dependsOn.length > 0) {
    const nextId = current.dependsOn[0];
    if (!nextId || seen.has(nextId)) break;
    seen.add(nextId);
    const parent = await ctx.stores.jobs.get(nextId);
    if (!parent) break;
    if (parent.type === 'narrative') {
      jobs.push(parent);
      current = parent;
      continue;
    }
    current = parent;
  }
  return jobs.reverse();
}

async function expandExtraContext(ctx: Context, rawContext: string): Promise<string> {
  const PLACEHOLDER_REGEX = /<priorNotesFull[^>]*>[\s\S]*?<\/priorNotesFull>/i;
  const SELF_CLOSING_REGEX = /<priorNotesFull[^>]*\/>/i;

  if (!rawContext.includes('<priorNotesFull')) {
    return rawContext;
  }

  const priorJobs = await collectPriorNarrativeJobs(ctx);
  if (!priorJobs.length) {
    const replacement = '<priorNotesFull>No prior notes available.</priorNotesFull>';
    const enriched = rawContext
      .replace(PLACEHOLDER_REGEX, replacement)
      .replace(SELF_CLOSING_REGEX, replacement);
    return enriched;
  }

  const parts: string[] = [];
  for (let idx = 0; idx < priorJobs.length; idx++) {
    const job = priorJobs[idx];
    const artifact = await getLatestReleaseCandidate(ctx, job.id);
    const note = typeof artifact?.content === 'string' ? artifact.content : '';
    if (note.trim().length === 0) {
      parts.push(`Episode ${idx + 1} (${job.title || job.id}):\n[No release candidate note available.]`);
    } else {
      parts.push(`Episode ${idx + 1} (${job.title || job.id}):\n${note}`);
    }
  }

  const combined = parts.join('\n\n---\n\n');
  const replacement = `<priorNotesFull>\n${combined}\n</priorNotesFull>`;
  let enriched = rawContext;
  if (PLACEHOLDER_REGEX.test(enriched)) {
    enriched = enriched.replace(PLACEHOLDER_REGEX, replacement);
  } else if (SELF_CLOSING_REGEX.test(enriched)) {
    enriched = enriched.replace(SELF_CLOSING_REGEX, replacement);
  } else {
    enriched = `${enriched}\n\n${replacement}`;
  }

  return enriched;
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

function createPlanOutlineTask(
  sketch: string,
  getExtraContext: (ctx: Context) => Promise<string | undefined>
) {
  return async (ctx: Context) => {
    const extraContext = await getExtraContext(ctx);
    await runLLMTask<any>(
      ctx,
      'plan_outline',
      'plan_outline',
      { sketch, extraContext },
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

function createSectionDraftTask(
  section: string,
  sectionIndex: number,
  getExtraContext: (ctx: Context) => Promise<string | undefined>
) {
  return async (ctx: Context, version: number, { section: sec, outline, sketch }: any) => {
    const brief = await readBrief(ctx, sec);
    const guidance = outline?.guidance || '';
    const priorSummary = await getPriorSectionsSummary(ctx, sectionIndex, outline);
    const extraContext = await getExtraContext(ctx);
    await runLLMTask<string>(
      ctx,
      'draft_section',
      'draft_section',
      { section: sec, brief: brief?.content || '', sketch, guidance, priorSummary, extraContext },
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

async function getSectionSummaries(ctx: Context, outline: any): Promise<string> {
  if (!outline || !Array.isArray(outline.sections)) return '<sectionSummaries />';
  let summaries = '';
  for (const sec of outline.sections) {
    const v = await latestDraftVersion(ctx, sec.title);
    const draft = await readDraft(ctx, sec.title, v);
    summaries += `<section name="${sec.title}">${draft?.content || ''}</section>\n`;
  }
  return `<sectionSummaries>${summaries}</sectionSummaries>`;
}

async function assembleNoteFromSections(ctx: Context, outline: any): Promise<string> {
  if (!outline || !Array.isArray(outline.sections)) return '';
  const parts: string[] = [];
  for (const sec of outline.sections) {
    const v = await latestDraftVersion(ctx, sec.title);
    const draft = await readDraft(ctx, sec.title, v);
    if (!draft?.content) continue;
    const heading = `## ${sec.title}`;
    const body = draft.content.trim();
    parts.push(body ? `${heading}\n\n${body}` : heading);
  }
  return parts.join('\n\n');
}

export function buildNarrativeWorkflow(inputs: NarrativeInputs): DocumentWorkflow<NarrativeInputs> {
  let extraContextPromise: Promise<string | undefined> | null = null;
  let priorContextSaved = false;

  const ensureExtraContext = (ctx: Context): Promise<string | undefined> => {
    if (extraContextPromise) return extraContextPromise;
    const hasContext = typeof inputs.extraContext === 'string' && inputs.extraContext.trim().length > 0;
    if (!hasContext) {
      extraContextPromise = Promise.resolve(undefined);
      return extraContextPromise;
    }
    extraContextPromise = (async () => {
      const enriched = await expandExtraContext(ctx, inputs.extraContext!);
      if (!priorContextSaved) {
        priorContextSaved = true;
        await ctx.createArtifact({
          kind: 'TrajectoryContext',
          version: 1,
          title: 'Trajectory Context',
          content: enriched,
          tags: { phase: 'context', role: 'extra_context' },
          contentType: 'text',
        } as any);
      }
      return enriched;
    })();
    return extraContextPromise;
  };

  const planTask = createPlanOutlineTask(inputs.sketch, ensureExtraContext);
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
        await createSectionDraftTask(sec.title, i, ensureExtraContext)(ctx, 1, {
          section: sec.title,
          outline,
          sketch: inputs.sketch,
        });
      }
    },
  ]);
  const assemblyPhase = definePhase('Assembly', { phase: 'assembly' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const stitched = await assembleNoteFromSections(ctx, outline);
      await ctx.createArtifact({
        kind: 'NoteDraft',
        version: 1,
        title: 'Note v1',
        content: stitched,
        tags: { phase: 'assembly', source: 'sections_stitched' },
        contentType: 'text',
      } as any);
    },
  ]);
  const noteReviewPhase = definePhase('Note Review', { phase: 'note_review' }, [
    async (ctx) => {
      const outline = await getOutlineFromSteps(ctx);
      const noteArtifact = await readNote(ctx);
      const noteText = noteArtifact?.content || (await assembleNoteFromSections(ctx, outline));
      const guidance = outline?.guidance || '';
      const sectionSummaries = outline ? await getSectionSummaries(ctx, outline) : '<sectionSummaries />';
      const extraContext = await ensureExtraContext(ctx);
      const { result: critiqueResult, artifactId } = await runLLMTask<any>(
        ctx,
        'critique_note',
        'critique_note',
        {
          noteDraft: noteText,
          sketch: inputs.sketch,
          guidance,
          sectionSummaries,
          extraContext,
        },
        {
          expect: 'json',
          tags: { phase: 'note_review' },
          artifact: {
            kind: 'NoteCritique',
            version: 1,
            title: 'Note Critique',
            tags: { verb: 'critique' },
            links: [
              ...(noteArtifact ?
                [
                  {
                    dir: 'from' as const,
                    role: 'critiques',
                    ref: { type: 'artifact' as const, id: noteArtifact.id },
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
            tags: { ...(art.tags || {}), responseJson: critiqueResult },
          });
      }
    },
  ]);
  const finalizedPhase = definePhase('Finalized', { phase: 'finalized' }, [
    async (ctx) => {
      const latest = await readNote(ctx);
      const outline = await getOutlineFromSteps(ctx);
      const guidance = outline?.guidance || '';
      const extraContext = await ensureExtraContext(ctx);
      const critiques = await ctx.stores.artifacts.listByJob(ctx.jobId, (a: Artifact) => a.kind === 'NoteCritique');
      const latestCrit = critiques.at(-1);
      let critiqueText = '';
      if (latestCrit?.content) {
        try {
          const parsed = JSON.parse(latestCrit.content);
          if (parsed && typeof parsed.critique === 'string') critiqueText = parsed.critique;
        } catch {
          critiqueText = latestCrit.content;
        }
      }
      await runLLMTask<string>(
        ctx,
        'finalize_note',
        'finalize_note',
        { noteDraft: latest?.content || '', sketch: inputs.sketch, guidance, critique: critiqueText, extraContext },
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
