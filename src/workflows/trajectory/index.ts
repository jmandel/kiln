import type {
  Context,
  DocumentWorkflow,
  ID,
  NarrativeInputs,
  TrajectoryInputs,
} from '../../types';
import { runLLMTask } from '../../llmTask';
import { createJob, triggerReadyJobs } from '../../jobs';

const MIN_EPISODES = 3;
const MAX_EPISODES = 8;

type EpisodePlan = {
  episodeNumber: number;
  dateOffset: string;
  sketch: string;
  keyThemes: string[];
};

type OutlineResult = {
  fullSketch: string;
  episodes: EpisodePlan[];
  overallGuidance: string;
};

function normalizeOutline(result: any, fallbackSketch: string): OutlineResult {
  const fullSketch = typeof result?.fullSketch === 'string' && result.fullSketch.trim() ? result.fullSketch : fallbackSketch;
  const rawEpisodes = Array.isArray(result?.episodes) ? result.episodes : [];
  const normalizedEpisodes: EpisodePlan[] = rawEpisodes
    .map((ep: any, idx: number) => {
      const episodeNumber = Number.isFinite(Number(ep?.episodeNumber)) ? Number(ep.episodeNumber) : idx + 1;
      const dateOffset = typeof ep?.dateOffset === 'string' && ep.dateOffset.trim() ? ep.dateOffset.trim() : `Episode ${idx + 1}`;
      const sketch = typeof ep?.sketch === 'string' ? ep.sketch.trim() : '';
      const keyThemes = Array.isArray(ep?.keyThemes) ? ep.keyThemes.map((t: any) => String(t)).filter((t: string) => t.trim().length > 0) : [];
      return { episodeNumber, dateOffset, sketch, keyThemes };
    })
    .filter((ep: EpisodePlan) => ep.sketch.length > 0);

  if (normalizedEpisodes.length < MIN_EPISODES || normalizedEpisodes.length > MAX_EPISODES) {
    throw new Error(`Trajectory outline returned ${normalizedEpisodes.length} episodes; expected between ${MIN_EPISODES} and ${MAX_EPISODES}.`);
  }

  normalizedEpisodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
  const renumbered = normalizedEpisodes.map((ep, idx) => ({ ...ep, episodeNumber: idx + 1 }));
  const overallGuidance = typeof result?.overallGuidance === 'string' ? result.overallGuidance.trim() : '';

  return {
    fullSketch,
    episodes: renumbered,
    overallGuidance,
  };
}

function buildEpisodeContext(outline: OutlineResult, episode: EpisodePlan): string {
  const sections = [
    `<fullTrajectory>${outline.fullSketch}</fullTrajectory>`,
    `<trajectoryOutline>${JSON.stringify({
      episodes: outline.episodes,
      overallGuidance: outline.overallGuidance,
    })}</trajectoryOutline>`,
    `<currentEpisode number="${episode.episodeNumber}" dateOffset="${episode.dateOffset}">${episode.sketch}</currentEpisode>`,
    `<episodeThemes>${episode.keyThemes.join(', ') || 'No explicit themes provided.'}</episodeThemes>`,
    `<globalGuidance>${outline.overallGuidance || 'No additional guidance provided.'}</globalGuidance>`,
    '<priorNotesFull placeholder="true"></priorNotesFull>',
  ];
  return sections.join('\n\n');
}

async function updateArtifactContent(ctx: Context, artifactId: ID | undefined, outline: OutlineResult): Promise<void> {
  if (!artifactId) return;
  try {
    const art = await ctx.stores.artifacts.get(artifactId);
    if (!art) return;
    await ctx.stores.artifacts.upsert({
      ...art,
      content: JSON.stringify(outline, null, 2),
      updatedAt: new Date().toISOString(),
    } as any);
  } catch {}
}

export function buildTrajectoryWorkflow(inputs: TrajectoryInputs): DocumentWorkflow<TrajectoryInputs> {
  return [
    async (ctx: Context) => {
      const { result, artifactId } = await runLLMTask<any>(
        ctx,
        'generate_trajectory_outline',
        'generate_trajectory_outline',
        { trajectorySketch: inputs.trajectorySketch },
        {
          expect: 'json',
          tags: { phase: 'trajectory' },
          artifact: {
            kind: 'TrajectoryOutline',
            version: 1,
            title: 'Trajectory Outline',
            tags: { phase: 'trajectory', responseJson: undefined },
            contentType: 'json',
          },
        }
      );

      const outline = normalizeOutline(result, inputs.trajectorySketch);
      await updateArtifactContent(ctx, artifactId as ID | undefined, outline);

      const episodesWithJobs: Array<{ plan: EpisodePlan; jobId: ID }> = [];
      let previousEpisodeJobId: ID | undefined;

      for (const episode of outline.episodes) {
        const dependsOn = previousEpisodeJobId ? [previousEpisodeJobId] : [ctx.jobId];
        const extraContext = buildEpisodeContext(outline, episode);
        const title = `Episode ${episode.episodeNumber}: ${episode.dateOffset}`;
        const inputsForEpisode: NarrativeInputs = {
          sketch: episode.sketch,
          extraContext,
        };

        const tags = {
          trajectoryParentId: ctx.jobId,
          trajectoryEpisodeNumber: episode.episodeNumber,
          trajectoryDateOffset: episode.dateOffset,
        };

        const jobId = await createJob(ctx.stores, 'narrative', inputsForEpisode, title, {
          dependsOn,
          tags,
        });

        episodesWithJobs.push({ plan: episode, jobId });
        previousEpisodeJobId = jobId;

        try {
          await ctx.link(
            { type: 'job', id: ctx.jobId },
            'spawns',
            { type: 'job', id: jobId },
            { episodeNumber: episode.episodeNumber }
          );
        } catch {}

        await ctx.createArtifact({
          kind: 'TrajectoryEpisodePlan',
          version: episode.episodeNumber,
          title,
          content: JSON.stringify({ ...episode, narrativeJobId: jobId }, null, 2),
          tags: {
            phase: 'trajectory',
            episodeNumber: episode.episodeNumber,
            narrativeJobId: jobId,
          },
          contentType: 'json',
        } as any);
      }

      await ctx.createArtifact({
        kind: 'TrajectoryEpisodeIndex',
        version: 1,
        title: 'Trajectory Episodes',
        content: JSON.stringify(
          {
            outline,
            episodes: episodesWithJobs.map(({ plan, jobId }) => ({ ...plan, narrativeJobId: jobId })),
          },
          null,
          2
        ),
        tags: { phase: 'trajectory' },
        contentType: 'json',
      } as any);

      setTimeout(() => {
        void triggerReadyJobs(ctx.stores);
      }, 0);
    },
  ];
}
