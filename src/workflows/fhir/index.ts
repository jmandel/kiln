import type { Context, DocumentWorkflow, FhirInputs, Artifact } from '../../types';
import { extractSections, renderSectionNarrative } from '../../sections';
import { runLLMTask } from '../../llmTask';
import { IPS_NOTES } from '../../ips-notes';
import { emitJsonArtifact } from '../../services/artifacts';
import { analyzeCodings } from '../../codingAnalysis';
import { generateAndRefineResources } from '../../services/fhirGeneration';
import { sha256, nowIso } from '../../helpers';
import { validateResource } from '../../validator';

function definePhase(_name: string, _tags: Record<string, any>, fns: Array<(ctx: Context) => Promise<void>>) {
  return async (ctx: Context) => {
    for (const fn of fns) await fn(ctx);
  };
}

async function shortHash(seed: string, len = 8): Promise<string> {
  const h = await sha256(seed);
  return h.slice(0, len);
}

function stitchSectionNarratives(compositionPlan: any, noteText: string): any {
  const noteSections = extractSections(noteText);
  // Pass 1: drop subsection-looking titles (starting with '#') and merge their entries into the previous kept section
  if (Array.isArray(compositionPlan.section)) {
    const filtered: any[] = [];
    for (const section of compositionPlan.section) {
      const rawTitle = String(section?.title ?? '').trim();
      const looksLikeSub = /^#+\s+/.test(rawTitle);
      if (looksLikeSub) {
        const parent = filtered[filtered.length - 1];
        if (parent && Array.isArray(section.entry) && section.entry.length) {
          parent.entry = Array.isArray(parent.entry) ? parent.entry : [];
          for (const e of section.entry) parent.entry.push(e);
        }
        try {
          console.warn('[FHIR][stitch] Dropping subsection and merging entries into parent:', rawTitle);
        } catch {}
        continue;
      }
      filtered.push(section);
    }
    compositionPlan.section = filtered;
  }
  // Pass 2: stitch narratives for the remaining sections
  if (Array.isArray(compositionPlan.section)) {
    let lastSeenSection: any = null;
    for (const section of compositionPlan.section) {
      if (section.title && typeof section.title === 'string' && section.title.trim()) {
        lastSeenSection = section;
      }
      if (section.text?.div) {
        const m = String(section.text.div).match(/\{\{\s*(?:##\s*)?(.*?)\s*\}\}/);
        if (m && m[1]) {
          const title = m[1].trim();
          const rendered = renderSectionNarrative(noteText, title);
          if (rendered != null) {
            section.text.div = rendered;
            section.text.status = 'additional';
          } else {
            section.text.div = '';
            section.text.status = 'generated';
            if (lastSeenSection && lastSeenSection !== section) {
              const entriesToMove = Array.isArray(section.entry) ? section.entry.slice() : [];
              lastSeenSection.entry = Array.isArray(lastSeenSection.entry) ? lastSeenSection.entry : [];
              for (const e of entriesToMove) lastSeenSection.entry.push(e);
              section.entry = [];
            }
          }
        }
      }
    }
  }
  try {
    const cid = typeof compositionPlan?.id === 'string' ? compositionPlan.id.trim() : '';
    if (cid) {
      const current = compositionPlan.identifier;
      if (!current || typeof current !== 'object' || Array.isArray(current))
        compositionPlan.identifier = { value: cid };
    }
  } catch {}
  return compositionPlan;
}

async function collectPriorFhirBundles(ctx: Context): Promise<Array<{ episodeNumber: number; bundle: any }>> {
  const currentJob = await ctx.stores.jobs.get(ctx.jobId);
  const tags = (currentJob as any)?.tags || {};
  const parentId = tags?.trajectoryParentId;
  const episodeNumber = Number(tags?.trajectoryEpisodeNumber);
  if (!parentId || !Number.isFinite(episodeNumber)) return [];

  const allJobs = await ctx.stores.jobs.all();
  const priorJobs = allJobs
    .filter(
      (job: any) =>
        job.type === 'fhir' &&
        job.tags?.trajectoryParentId === parentId &&
        Number(job.tags?.trajectoryEpisodeNumber) < episodeNumber
    )
    .sort(
      (a: any, b: any) =>
        Number(a.tags?.trajectoryEpisodeNumber || 0) - Number(b.tags?.trajectoryEpisodeNumber || 0)
    );

  const bundles: Array<{ episodeNumber: number; bundle: any }> = [];
  for (const job of priorJobs) {
    const artifacts = await ctx.stores.artifacts.listByJob(job.id, (a: Artifact) => a.kind === 'FhirBundle');
    if (!artifacts.length) continue;
    const latest = artifacts.sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (!latest?.content) continue;
    let bundle: any = latest.content;
    if (typeof latest.content === 'string') {
      try {
        bundle = JSON.parse(latest.content);
      } catch {
        bundle = latest.content;
      }
    }
    bundles.push({ episodeNumber: Number(job.tags?.trajectoryEpisodeNumber || 0), bundle });
  }
  return bundles;
}

// Reusable FHIR encoding phase factory: creates a single-phase function using provided note text
export function makeFhirEncodingPhase(noteText: string): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    const note_text = noteText;
    const noteSections = extractSections(note_text);
    const sectionTitles: string[] = [];
    {
      const seen = new Set<string>();
      const rx = /(?:^|\r?\n)##\s*(.*?)\s*\r?\n/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(note_text)) !== null) {
        const rawTitle = (m[1] || '').trim();
        if (!rawTitle) continue;
        // Skip subsection-looking titles that inadvertently include extra markdown markers
        if (/^#+\s+/.test(rawTitle)) continue;
        if (seen.has(rawTitle)) continue;
        sectionTitles.push(rawTitle);
        seen.add(rawTitle);
      }
    }
    const ipsComp = IPS_NOTES?.Composition;
    const ips_notes = Array.isArray(ipsComp?.requirements) ? ipsComp?.requirements : undefined;
    const ips_example = typeof ipsComp?.example === 'string' ? ipsComp.example : undefined;
    const priorBundles = await collectPriorFhirBundles(ctx);
    const priorResourceMap = new Map<string, any>();
    for (const episode of priorBundles) {
      const entries = Array.isArray(episode?.bundle?.entry) ? episode.bundle.entry : [];
      for (const entry of entries) {
        const resource = entry?.resource;
        const rtype = resource?.resourceType;
        const rid = resource?.id;
        if (rtype && rid) priorResourceMap.set(`${rtype}/${rid}`, resource);
      }
    }
    const { result: planResult, meta: planMeta } = await runLLMTask<any>(
      ctx,
      'fhir_composition_plan',
      'fhir_composition_plan',
      {
        note_text,
        section_titles: sectionTitles,
        ips_notes,
        ips_example,
        prior_bundles: priorBundles,
      },
      { expect: 'json', tags: { phase: 'fhir' } }
    );
    let compositionPlan = stitchSectionNarratives(planResult, note_text);
    await emitJsonArtifact(ctx, {
      kind: 'FhirCompositionPlan',
      title: 'FHIR Composition Plan',
      content: compositionPlan,
      tags: { phase: 'fhir', prompt: planMeta.prompt, raw: planMeta.raw },
      links: [{ dir: 'from', role: 'produced', ref: { type: 'step', id: planMeta.stepKey } }],
    });

    const references: { reference: string; display: string }[] = [];
    if (Array.isArray(compositionPlan.section)) {
      for (const section of compositionPlan.section) {
        if (Array.isArray(section.entry)) {
          for (const entry of section.entry)
            if (entry.reference && entry.display)
              references.push({ reference: entry.reference, display: entry.display });
        }
      }
    }

    // Capture subject/encounter and authors from Composition for generation
    const subjectRef =
      typeof compositionPlan?.subject === 'string' ?
        compositionPlan.subject
      : (compositionPlan?.subject?.reference as string | undefined);
    const subjectDisplay =
      typeof compositionPlan?.subject === 'object' && compositionPlan?.subject?.display ?
        (compositionPlan.subject.display as string)
      : undefined;
    const encounterRef =
      typeof compositionPlan?.encounter === 'string' ?
        compositionPlan.encounter
      : (compositionPlan?.encounter?.reference as string | undefined);
    const encounterDisplay =
      typeof compositionPlan?.encounter === 'object' && compositionPlan?.encounter?.display ?
        (compositionPlan.encounter.display as string)
      : undefined;
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
    } else if (compositionPlan?.author) addAuthorRef(compositionPlan.author);

    // Ensure these core references are generated even if not explicitly listed in sections
    const ensureRef = (
      arr: Array<{ reference: string; display?: string }>,
      reference?: string,
      displayMaybe?: string
    ) => {
      if (!reference) return;
      if (arr.some((r) => r.reference === reference)) return;
      const entry: { reference: string; display?: string } = { reference };
      if (displayMaybe && String(displayMaybe).trim()) entry.display = displayMaybe;
      arr.push(entry);
    };
    ensureRef(references, subjectRef, subjectDisplay);
    ensureRef(references, encounterRef, encounterDisplay);
    for (const a of authorRefs) ensureRef(references, a.reference, a.display || 'Author');

    const generatedResources: any[] = await generateAndRefineResources(
      ctx,
      note_text,
      references,
      subjectRef,
      encounterRef,
      authorRefs[0]?.reference as string | undefined,
      priorResourceMap
    );

    const preHash = await sha256(JSON.stringify(generatedResources));
    const { report: preReport } = await ctx.step(
      `analyze_codings:${preHash}`,
      async () => analyzeCodings(ctx, generatedResources),
      { title: 'Analyze Codings (pre)', tags: { phase: 'fhir', contentHash: preHash } }
    );
    await emitJsonArtifact(ctx, {
      kind: 'CodingValidationReport',
      title: 'Coding Validation Report (pre-recoding)',
      content: { items: preReport },
      tags: { phase: 'fhir', stage: 'pre' },
    });
    const recodedResources: any[] = JSON.parse(JSON.stringify(generatedResources));
    const postHash = await sha256(JSON.stringify(recodedResources));
    const { report: postReport } = await ctx.step(
      `analyze_codings_post:${postHash}`,
      async () => analyzeCodings(ctx, recodedResources),
      { title: 'Analyze Codings (post)', tags: { phase: 'fhir', contentHash: postHash } }
    );
    await emitJsonArtifact(ctx, {
      kind: 'CodingValidationReport',
      title: 'Coding Validation Report (post-recoding)',
      content: { items: postReport },
      tags: { phase: 'fhir', stage: 'post' },
    });
    // Rely on refined resources being self-annotated; do not add downstream extensions here.
    const finalResources = recodedResources;

    for (let i = 0; i < finalResources.length; i++) {
      const r: any = finalResources[i];
      const ref = references[i];
      await emitJsonArtifact(ctx, {
        kind: 'FhirResource',
        title: ref?.reference || `${r.resourceType}/${r.id || ''}`,
        content: r,
        tags: { phase: 'fhir', resourceType: r.resourceType, coded: true, from: ref?.display },
      });
    }

    const finalComposition = { ...compositionPlan } as any;
    if (typeof finalComposition.subject === 'string')
      finalComposition.subject = { reference: finalComposition.subject };
    if (typeof finalComposition.encounter === 'string')
      finalComposition.encounter = { reference: finalComposition.encounter };
    if (!finalComposition.id)
      finalComposition.id = `composition-${await shortHash((ctx as any).jobId + ':' + Date.now())}`;
    else if (typeof finalComposition.id === 'string' && finalComposition.id.length > 64)
      finalComposition.id = String(finalComposition.id).slice(0, 64);
    if (Array.isArray(finalComposition.section))
      for (const section of finalComposition.section)
        if (Array.isArray(section.entry)) for (const entry of section.entry) delete entry.display;

    const { config } = await import('../../config');
    let fhirBase = '';
    try {
      const o = (typeof localStorage !== 'undefined' && localStorage.getItem('OVERRIDE_FHIR_BASE_URL')) || '';
      fhirBase = (o && o.trim()) || config.fhirBaseURL();
    } catch {
      fhirBase = config.fhirBaseURL();
    }
    const base = String(fhirBase).replace(/\/$/, '');
    try {
      if (finalComposition?.id) {
        if (
          !finalComposition.identifier ||
          typeof finalComposition.identifier !== 'object' ||
          Array.isArray(finalComposition.identifier)
        )
          finalComposition.identifier = { value: finalComposition.id };
        if (!finalComposition.identifier.value) finalComposition.identifier.value = finalComposition.id;
        if (!/fhir\.example\.org$/i.test(base)) finalComposition.identifier.system = `${base}/Composition`;
        else delete finalComposition.identifier.system;
      }
    } catch {}
    const bundleId = `bundle-${await shortHash((ctx as any).jobId)}`;
    const bundle = {
      resourceType: 'Bundle',
      type: 'document',
      id: bundleId,
      timestamp: nowIso(),
      identifier: (function () {
        const value =
          (
            finalComposition?.identifier &&
            typeof finalComposition.identifier === 'object' &&
            !Array.isArray(finalComposition.identifier) &&
            finalComposition.identifier.value
          ) ?
            finalComposition.identifier.value
          : finalComposition.id;
        return { value, system: `${base}/Bundle` } as any;
      })(),
      entry: [
        {
          fullUrl: `${base}/${finalComposition.resourceType || 'Composition'}/${finalComposition.id}`,
          resource: finalComposition,
        },
        ...finalResources.map((r: any) => ({
          fullUrl: `${base}/${r.resourceType}/${r.id || ''}`,
          resource: r,
        })),
      ],
    } as any;
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
    await emitJsonArtifact(ctx, {
      kind: 'FhirBundle',
      title: 'FHIR Document Bundle',
      content: bundle,
      tags: { phase: 'fhir' },
    });

    const bundleHash = await sha256(JSON.stringify(bundle));
    const validateStepKey = `validate_bundle:${bundleHash}`;
    const validationResult = await (ctx as any).step?.(validateStepKey, async () => validateResource(bundle), {
      title: 'Validate FHIR Bundle',
      tags: { phase: 'fhir', bundleHash },
    });
    await emitJsonArtifact(ctx, {
      kind: 'ValidationReport',
      title: 'FHIR Bundle Validation Report',
      content: validationResult,
      tags: { phase: 'fhir', valid: validationResult?.valid, bundleHash },
      links: [{ dir: 'from', role: 'produced', ref: { type: 'step', id: validateStepKey } }],
    });
    if (!validationResult.valid) {
      try {
        console.warn('FHIR Bundle is not valid', validationResult.issues);
      } catch {}
    }
  };
}

export function buildFhirWorkflow(inputs: FhirInputs): DocumentWorkflow<FhirInputs> {
  // If note text is provided, use it directly; otherwise, if a source doc is provided, chain from ReleaseCandidate
  if (inputs.noteText && inputs.noteText.trim()) {
    const fhirEncodingPhase = definePhase('FHIR Encoding', { phase: 'fhir' }, [makeFhirEncodingPhase(inputs.noteText)]);
    return [fhirEncodingPhase];
  }
  if ((inputs as any).source && (inputs as any).source.jobId) {
    const chained = definePhase('FHIR Encoding', { phase: 'fhir' }, [makeChainedFhirPhase()]);
    return [chained];
  }
  // Fallback: no note text and no source; run a no-op to avoid crashes
  const noop = definePhase('FHIR Encoding', { phase: 'fhir' }, [
    async () => {
      throw new Error('FHIR inputs missing noteText or source');
    },
  ]);
  return [noop];
}

// Chained phase: read the latest ReleaseCandidate from artifacts and run FHIR encoding
export function makeChainedFhirPhase(): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    // Prefer parent Narrative document artifacts when chaining
    const src: any = (ctx as any).inputs?.source || {};
    const parentJobId: string | undefined = src?.jobId;
    const searchJobId: string = parentJobId || (ctx as any).jobId;

    // If an explicit artifactId is provided, use it directly; otherwise pick the latest ReleaseCandidate
    let rc: any | undefined;
    if (src?.artifactId) {
      try {
        const a = await ctx.stores.artifacts.get(src.artifactId);
        if (a && a.kind === 'ReleaseCandidate') rc = a;
      } catch {}
    }
    if (!rc) {
      const releaseCandidateArtifacts = await ctx.stores.artifacts.listByJob(
        searchJobId as any,
        (a) => a.kind === 'ReleaseCandidate'
      );
      rc = releaseCandidateArtifacts.sort((a, b) => b.version - a.version)[0];
    }
    if (!rc?.content) {
      const msg =
        parentJobId ?
          `ReleaseCandidate note not found in parent job '${parentJobId}' to start FHIR encoding.`
        : 'ReleaseCandidate note not found to start FHIR encoding.';
      throw new Error(msg);
    }

    // Traceability: link this workflow to the source artifact when available
    // (workflow links removed in job-centric context)

    const note_text = rc.content as string;
    await makeFhirEncodingPhase(note_text)(ctx);
  };
}
