import { randomInt, type RandomSource } from './runtime';
import type { Category, ResolvedPreset, RunMode, RunModeSpec, RunPreset } from './terms';

/** Fixes a run mode's random range, so the snapshot states exactly what will run (§9.1). */
export function resolveRunMode(spec: RunModeSpec, random: RandomSource): RunMode {
  return spec.kind === 'topics' ? { kind: 'topics', count: randomInt(random, spec.min, spec.max) } : spec;
}

/** `categories` are the site's categories; the preset's `categoryPaths` selects among them. */
export function resolvePreset(preset: RunPreset, categories: readonly Category[], random: RandomSource): ResolvedPreset {
  const enabled = new Set(preset.categoryPaths);
  return structuredClone({
    presetId: preset.id,
    browseMode: preset.browseMode,
    runMode: resolveRunMode(preset.runMode, random),
    categories: categories.filter((c) => enabled.has(c.path)),
    interaction: preset.interaction,
    extraWait: preset.extraWait,
    samplePerCategory: preset.samplePerCategory,
  });
}

/**
 * §7.2: a discovered site's category list after a fresh read. The list follows what the site
 * shows now; a category already known keeps the user's enable choice, and a new one starts off.
 */
export function mergeDiscoveredCategories(known: readonly Category[], found: readonly Category[]): Category[] {
  const enabled = new Map(known.map((c) => [c.id, c.enabledByDefault]));
  return found.map((c) => ({ ...c, enabledByDefault: enabled.get(c.id) ?? false }));
}
