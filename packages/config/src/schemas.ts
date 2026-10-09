import type { RunPreset, ScheduleSpec } from '@disco-lurk/core';
import { z } from 'zod';

// The one definition of the stored shapes. Files on disk are checked against these as they are;
// the server tightens them with the user-facing upper bounds (`LIMITS`) for what it accepts.

export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const PROFILE_ID = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const CATEGORY_PATH_PATTERN = /^\/c\/[^\s]+\/\d+$/;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const percent = z.number().min(0).max(100);

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expression: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('daily-window'),
      runs: z.number().int().min(1),
      start: hhmm,
      end: hhmm,
      jitterMinutes: z.number().min(0),
      minGapMinutes: z.number().min(0),
    })
    .strict(),
]);

export const scheduleSpecSchema = z
  .object({
    id: z.string().regex(ID, 'letters, digits, - and _ only'),
    name: z.string().min(1),
    profileId: z.string().regex(PROFILE_ID, 'expected <site>/<name>'),
    presetId: z.string().min(1),
    enabled: z.boolean(),
    browserMode: z.enum(['headed', 'headless']),
    timezone: z.string().min(1),
    trigger: triggerSchema,
    misfire: z.object({ policy: z.enum(['skip', 'run-once']), graceMinutes: z.number().min(0) }).strict(),
    overlap: z.literal('skip'),
    unavailableDisplay: z.enum(['skip', 'fallback-headless']),
    runOnStart: z.boolean(),
  })
  .strict();

export const interactionSchema = z
  .object({
    like: z.object({ enabled: z.boolean(), topicRate: percent, replyRate: percent, maxReplies: z.number().int().min(0) }).strict(),
    reply: z.object({ enabled: z.boolean(), rate: percent, riskAcknowledged: z.boolean() }).strict(),
  })
  .strict();

export const extraWaitSchema = z
  .object({ enabled: z.boolean(), minSec: z.number().min(0), maxSec: z.number().min(0) })
  .strict()
  .refine((w) => w.maxSec >= w.minSec, { message: 'maxSec must not be below minSec' });

export const sampleSchema = z
  .object({ min: z.number().int().min(1), max: z.number().int().min(1) })
  .strict()
  .refine((s) => s.max >= s.min, { message: 'max must not be below min' });

export const experimentsSchema = z
  .object({ useNewList: z.boolean(), useUnreadList: z.boolean(), refreshCategories: z.boolean(), smartRanked: z.boolean() })
  .strict();

export const runModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('endless') }).strict(),
  z
    .object({ kind: z.literal('topics'), min: z.number().int().min(1), max: z.number().int().min(1) })
    .strict()
    .refine((m) => m.max >= m.min, { message: 'max must not be below min' }),
  z.object({ kind: z.literal('time'), minutes: z.number().positive() }).strict(),
]);

export const runPresetSchema = z
  .object({
    id: z.string().min(1),
    siteId: z.string().min(1),
    browseMode: z.enum(['deep', 'quick']),
    runMode: runModeSchema,
    categoryPaths: z.array(z.string().regex(CATEGORY_PATH_PATTERN, 'expected /c/<slug>/<id>')),
    interaction: interactionSchema,
    extraWait: extraWaitSchema,
    samplePerCategory: sampleSchema,
    experiments: experimentsSchema.exactOptional(),
  })
  .strict();

/** Rejected issues as one line, at most five of them. */
export function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

// Compile-time checks that the schemas produce the kernel types they validate.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _ScheduleSpecMatches = Assert<Same<z.output<typeof scheduleSpecSchema>, ScheduleSpec>>;
export type _RunPresetMatches = Assert<Same<z.output<typeof runPresetSchema>, RunPreset>>;
