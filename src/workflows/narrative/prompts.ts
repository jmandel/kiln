export const NARRATIVE_PROMPTS = {
  plan_outline: ({
    sketch,
  }: {
    sketch: string;
  }) => `You are a clinical note planner and medical expert. Given a one-line patient sketch, synthesize a realistic, comprehensive outline for a full clinical note. 

Background:
<sketch>${sketch}</sketch>

Expand plausibly: Infer patient demographics, history, symptoms, and risks from the sketch (e.g., for "52F with chest pain", assume middle-aged female with possible cardiac issues; add realistic details like onset, severity). Do not add unrelated elements—stay grounded in the sketch. Aim for 4-8 sections in logical order (e.g., Chief Complaint → HPI → PMH → Exam → Assessment → Plan). For each section, provide a one-paragraph brief as a guiding vision: Expand the brief with plausible, evidence-based details to make it vivid and realistic, not just a summary.

Output JSON only, no extra text:
{
  "sections": [
    {
      "title": "Section Title (e.g., Chief Complaint)",
      "brief": "Detailed one-paragraph vision: Expand with realistic inferences (e.g., 'Patient describes sharp pain starting 2 weeks ago, worsening with stairs...'). Ensure flow to next sections."
    }
  ],
  "guidance": "Overall note vision: 1-2 paragraphs on tone, key themes, and expansions (e.g., 'Emphasize cardiovascular synthesis; expand history with typical comorbidities like hypertension.')"
}

Ensure the outline encourages realistic synthesis: Briefs should guide expansion beyond the sketch, promoting consistency and avoiding duplication across sections.`,

  draft_section: ({
    section,
    brief,
    sketch,
    guidance,
    priorSummary,
  }: {
    section: string;
    brief: string;
    sketch: string;
    guidance: string;
    priorSummary: string;
  }) => `You are a clinical writer synthesizing a realistic patient narrative. Draft the "${section}" section for a clinical note, building on the overall case.

Background:
<sketch>${sketch}</sketch>
<guidance>${guidance || 'No specific guidance; infer from sketch for a standard evaluation.'}</guidance>
<priorSections>${priorSummary || 'This is the first section; no priors.'}</priorSections> (Reference key details from priors, e.g., symptoms from HPI, but do not repeat—advance the story).
<brief>${brief}</brief> (Use as guide, but expand beyond it).

Specific Task: Expand into concise, plausible prose (200-400 words). Synthesize realistically: Infer and add evidence-based details (e.g., if sketch implies chest pain, expand with radiation, triggers, relief; include typical patient quotes or exam findings). Maintain professional tone; ensure flow from priors (e.g., reference but don't duplicate HPI symptoms). Avoid fabrication—align with sketch and guidance.

Output ONLY the section text. No headers, JSON, or commentary.`,

  critique_section: ({
    section,
    draft,
    brief,
    sketch,
    guidance,
    priorSummary,
  }: {
    section: string;
    draft: string;
    brief: string;
    sketch: string;
    guidance: string;
    priorSummary: string;
  }) => `You are a clinical editor reviewing for realism, consistency, and synthesis. Critique the "${section}" draft against the brief and overall note.

Background:
<sketch>${sketch}</sketch>
<guidance>${guidance || 'Standard clinical synthesis.'}</guidance>
<priorSections>${priorSummary || 'No priors.'}</priorSections>
<brief>${brief}</brief>
<draft>${draft}</draft>

Specific Task: Evaluate on a 0-1 score (0.0=poor, 1.0=excellent). Focus on: Realism (plausible expansions?), Consistency (aligns with sketch/guidance/priors, no duplication?), Synthesis (expands beyond brief with vivid details?). Provide constructive feedback to improve expansion and flow.

Output JSON only:
{"critique": "Detailed feedback (1-2 paragraphs; suggest expansions for realism).", "score": 0.XX}`,

  assemble_note: ({
    sketch,
    guidance,
    sectionSummaries,
  }: {
    sketch: string;
    guidance: string;
    sectionSummaries: string;
  }) => `You are a clinical synthesizer assembling a full note. Stitch approved sections into a cohesive "NoteDraft".

Background:
<sketch>${sketch}</sketch>
<guidance>${guidance || 'N/A'}</guidance>
<sectionSummaries>${sectionSummaries}</sectionSummaries> (use these to ensure no duplication; expand transitions for realism).

Specific Task: Combine into a unified narrative. Add subtle transitions (e.g., "Building on the history..."). Ensure overall realism: Infer and weave in plausible connections (e.g., link symptoms across sections).

Formatting rules (important):
- Use Markdown headings for section titles with exactly two hash marks: "## Title".
- Do NOT use bold (**) or other styles for section titles; use only the "## " marker.
- Keep content beneath each header as normal paragraphs/bullets as appropriate.

Output ONLY the full note text.`,

  critique_note: ({
    noteDraft,
    sketch,
    guidance,
    sectionSummaries,
  }: {
    noteDraft: string;
    sketch: string;
    guidance: string;
    sectionSummaries: string;
  }) => `You are a senior clinical reviewer. Critique the full note draft for synthesis and realism.

Background:
<sketch>${sketch}</sketch>
<guidance>${guidance}</guidance>
<sectionSummaries>${sectionSummaries}</sectionSummaries>
<noteDraft>${noteDraft}</noteDraft>

Specific Task: Score 0-1 on overall coherence, expansion, and consistency. Feedback: Highlight synthesis strengths/weaknesses (e.g., "Good realism in expansions, but duplication in symptoms").

Output JSON: {"critique": "...", "score": 0.XX}`,

  finalize_note: ({
    noteDraft,
    sketch,
    guidance,
  }: {
    noteDraft: string;
    sketch: string;
    guidance: string;
  }) => `You are a final clinical polisher. Finalize the note for release.

Background:
<sketch>${sketch}</sketch>
<guidance>${guidance}</guidance>
<draft>${noteDraft}</draft>

Specific Task: Minor edits for consistency/realism. Ensure no loose ends; expand subtly if needed.

Formatting rules (important):
- Use Markdown headings for section titles with exactly two hash marks: "## Title".
- Do NOT use bold (**) or other styles for section titles; use only the "## " marker.

Output ONLY the final text.`,
};

export type NarrativePromptKey = keyof typeof NARRATIVE_PROMPTS;
