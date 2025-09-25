import type { TrajectoryInputs } from '../../types';

function sanitizeSketch(text: string): string {
  return (text || '').replace(/`/g, '\\`');
}

export const TRAJECTORY_PROMPTS = {
  generate_trajectory_outline: ({ trajectorySketch }: TrajectoryInputs & { trajectorySketch: string }) => {
    const sketch = sanitizeSketch(trajectorySketch);
    return `You are a clinician creating a longitudinal care plan. Given a free-form sketch, infer a sequence of distinct clinical encounters that describe the patient's journey over time.

Input Sketch:
<trajectorySketch>${sketch}</trajectorySketch>

Instructions:
- Produce 3-8 episodes that cover the entire narrative arc. Use timing cues from the sketch when available; otherwise infer realistic offsets (e.g., "+3 months", "Late 2024").
- Each episode should summarize the visit in 1-2 sentences that downstream note writers will expand.
- Populate keyThemes with 3-5 bullet phrases that must remain consistent across episodes (e.g., ongoing therapies, complications, social factors).
- Preserve the user's wording verbatim in fullSketch.
- Provide an overallGuidance paragraph describing the longitudinal arc and continuity requirements.

Output STRICT JSON only. Schema:
{
  "fullSketch": "verbatim user sketch",
  "episodes": [
    {
      "episodeNumber": 1,
      "dateOffset": "Timing label",
      "sketch": "1-2 sentence description of encounter",
      "keyThemes": ["theme 1", "theme 2"]
    }
  ],
  "overallGuidance": "Paragraph describing continuity and themes"
}

Example Input Sketch:
"50M with longstanding hypertension diagnosed in 2020, quarterly follow-ups with good control until a 2023 AKI hospitalization; recovering with new nephrology care."

Example Output:
{
  "fullSketch": "50M with longstanding hypertension diagnosed in 2020, quarterly follow-ups with good control until a 2023 AKI hospitalization; recovering with new nephrology care.",
  "episodes": [
    {"episodeNumber": 1, "dateOffset": "2020 (baseline)", "sketch": "Initial diagnosis visit with elevated BP and new lisinopril start.", "keyThemes": ["Hypertension", "Medication initiation", "Lifestyle coaching"]},
    {"episodeNumber": 2, "dateOffset": "+1 year", "sketch": "Routine follow-up with controlled BP and adherence counseling.", "keyThemes": ["Medication adherence", "Preventive labs", "Exercise plan"]},
    {"episodeNumber": 3, "dateOffset": "Mid-2023", "sketch": "Hospitalized for AKI; nephrology consulted and antihypertensives paused.", "keyThemes": ["AKI event", "Renal monitoring", "Care coordination"]},
    {"episodeNumber": 4, "dateOffset": "+3 months", "sketch": "Post-discharge recovery visit with staged medication reintroduction.", "keyThemes": ["Renal recovery", "Medication titration", "Shared management"]}
  ],
  "overallGuidance": "Track the shift from stable outpatient control to AKI disruption and coordinated recovery; maintain continuity of labs, medications, and nephrology collaboration."
}

Return JSON only.`;
  },
};

export type TrajectoryPromptKey = keyof typeof TRAJECTORY_PROMPTS;
