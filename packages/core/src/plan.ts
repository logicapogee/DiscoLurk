import { randomInt, type RandomSource } from './runtime';
import { EXPERIMENTS_OFF, MAX_REPLY_LIKES, type Category, type InteractionPolicy, type ResolvedPreset, type RunMode, type RunModeSpec, type RunPreset } from './terms';

/** Fixes a run mode's random range, so the snapshot states exactly what will run. */
function resolveRunMode(spec: RunModeSpec, random: RandomSource): RunMode {
  return spec.kind === 'topics' ? { kind: 'topics', count: randomInt(random, spec.min, spec.max) } : spec;
}

/**
 * The interaction a run may use: replies only with the risk acknowledged, and at most
 * `MAX_REPLY_LIKES` reply floors liked per topic.
 */
export function boundInteraction(interaction: InteractionPolicy, warn: (code: string, message: string) => void = () => {}): InteractionPolicy {
  const { like, reply } = interaction;
  if (reply.enabled && !reply.riskAcknowledged) warn('reply-risk-unacknowledged', 'Replies are on but their risk was not acknowledged; this run posts no replies');
  return {
    like: { ...like, maxReplies: Math.min(like.maxReplies, MAX_REPLY_LIKES) },
    reply: { ...reply, enabled: reply.enabled && reply.riskAcknowledged },
  };
}

/** `categories` are the site's categories; the preset's `categoryPaths` selects among them. */
export function resolvePreset(preset: RunPreset, categories: readonly Category[], random: RandomSource, warn?: (code: string, message: string) => void): ResolvedPreset {
  const enabled = new Set(preset.categoryPaths);
  return structuredClone({
    presetId: preset.id,
    browseMode: preset.browseMode,
    runMode: resolveRunMode(preset.runMode, random),
    categories: categories.filter((c) => enabled.has(c.path)),
    interaction: boundInteraction(preset.interaction, warn),
    extraWait: preset.extraWait,
    samplePerCategory: preset.samplePerCategory,
    experiments: preset.experiments ?? EXPERIMENTS_OFF,
  });
}

/**
 * A discovered site's category list after a fresh read. The list follows what the site
 * shows now; a category already known keeps the user's enable choice, and a new one starts off.
 */
export function mergeDiscoveredCategories(known: readonly Category[], found: readonly Category[]): Category[] {
  const enabled = new Map(known.map((c) => [c.id, c.enabledByDefault]));
  return found.map((c) => ({ ...c, enabledByDefault: enabled.get(c.id) ?? false }));
}
