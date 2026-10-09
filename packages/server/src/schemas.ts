import { z } from 'zod';
import type { ProfileCreate, ProfilePatch, StoredPreset } from './contract';
import { LIMITS, MAX_REPLY_LIKES, type ScheduleSpec } from '@disco-lurk/core';
import { extraWaitSchema, ID, runPresetSchema, sampleSchema, scheduleSpecSchema } from '@disco-lurk/config';
import { HttpError } from './hub';

/** `user:pass@` in a URL; unparsable input counts as none, the pattern above rejects it anyway. */
export function hasUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/** A proxy goes straight into the browser's launch options, so only a plain proxy URL is accepted. */
const proxyUrl = z
  .string()
  .regex(/^(https?|socks[45]?):\/\/[^\s]+$/, 'http://, https://, socks4:// or socks5:// URL')
  // Credentials would be stored in profiles.json and shown in the UI; only proxies without authentication are supported.
  .refine((v) => !hasUserinfo(v), 'proxy credentials are not supported; use a proxy that needs no username or password');
const name = z.string().regex(ID, 'letters, digits, - and _ only');
const label = z.string().min(1).max(LIMITS.nameLength);

/** `value` at most `max`, reported at `path`. */
function cap(ctx: z.RefinementCtx, value: number, max: number, path: (string | number)[]) {
  if (value > max) ctx.addIssue({ code: 'custom', path, message: `must be at most ${max}` });
}

/** The shared preset shape plus where and how it runs, within the bounds the UI offers. */
export const storedPresetSchema = runPresetSchema
  .extend({ id: name, name: label, profileId: z.string().min(1).nullable(), browserMode: z.enum(['headed', 'headless']) })
  .superRefine((p, ctx) => {
    if (p.profileId !== null && !p.profileId.startsWith(`${p.siteId}/`)) ctx.addIssue({ code: 'custom', path: ['profileId'], message: 'the Profile must belong to the preset site' });
    cap(ctx, p.interaction.like.maxReplies, MAX_REPLY_LIKES, ['interaction', 'like', 'maxReplies']);
    cap(ctx, p.extraWait.maxSec, LIMITS.extraWaitSec, ['extraWait', 'maxSec']);
    cap(ctx, p.samplePerCategory.max, LIMITS.samplePerCategory, ['samplePerCategory', 'max']);
    if (p.runMode.kind === 'topics') cap(ctx, p.runMode.max, LIMITS.topicsTarget, ['runMode', 'max']);
    if (p.runMode.kind === 'time') cap(ctx, p.runMode.minutes, LIMITS.timeModeMax, ['runMode', 'minutes']);
  });

export const presetSaveSchema = z.object({ preset: storedPresetSchema }).strict();

export const settingsPatchSchema = z
  .object({
    notifications: z.boolean(),
    notifyOnStart: z.boolean(),
    updateCheck: z.boolean(),
    currentPresetId: z.string().nullable(),
    language: z.literal('zh-CN'),
    historyLimit: z.number().int().min(10).max(LIMITS.historyRuns),
    ledgerDays: z.number().int().min(1).max(LIMITS.ledgerDays),
    reading: z
      .object({ samplePerCategory: sampleSchema, extraWait: extraWaitSchema })
      .strict()
      .superRefine((r, ctx) => {
        cap(ctx, r.samplePerCategory.max, LIMITS.samplePerCategory, ['samplePerCategory', 'max']);
        cap(ctx, r.extraWait.maxSec, LIMITS.extraWaitSec, ['extraWait', 'maxSec']);
      }),
  })
  .partial()
  .strict();

export const profileCreateSchema = z
  .object({ siteId: z.string().min(1), name, channel: z.enum(['chrome', 'msedge']), proxy: proxyUrl.optional() })
  .strict();

export const profilePatchSchema = z
  .object({ proxy: proxyUrl.nullable() })
  .partial()
  .strict();

export const limitedScheduleSpecSchema = scheduleSpecSchema.extend({ name: label }).superRefine((spec, ctx) => {
  const t = spec.trigger;
  if (t.kind === 'daily-window') {
    cap(ctx, t.runs, LIMITS.runsPerDay, ['trigger', 'runs']);
    cap(ctx, t.jitterMinutes, LIMITS.jitterMin, ['trigger', 'jitterMinutes']);
    cap(ctx, t.minGapMinutes, LIMITS.minGapMin, ['trigger', 'minGapMinutes']);
  }
  cap(ctx, spec.misfire.graceMinutes, LIMITS.graceMinutes, ['misfire', 'graceMinutes']);
});

export const refreshCategoriesSchema = z.object({ profileId: z.string().min(1) }).strict();
export const startRunSchema = z.object({ presetId: z.string().min(1) }).strict();
export const exportLogSchema = z.object({ types: z.array(z.string()).optional() }).strict().optional();

/** Rejects with 422 and the first issues, so the UI can show what to fix. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`);
  throw new HttpError(422, 'invalid-body', issues.join('; '));
}

// Compile-time checks that the schemas produce the wire types they validate.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _PresetMatches = Assert<Same<z.output<typeof storedPresetSchema>, StoredPreset>>;
export type _ScheduleMatches = Assert<Same<z.output<typeof limitedScheduleSpecSchema>, ScheduleSpec>>;
export type _ProfileCreateMatches = Assert<Same<z.output<typeof profileCreateSchema>, ProfileCreate>>;
export type _ProfilePatchMatches = Assert<Same<z.output<typeof profilePatchSchema>, ProfilePatch>>;
