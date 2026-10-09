import { z } from 'zod';
import type { ProfileCreate, ProfilePatch, StoredPreset } from './contract';
import { MAX_REPLY_LIKES, type ScheduleSpec } from '@disco-lurk/core';
import { HttpError } from './server';

/** `user:pass@` in a URL; unparsable input counts as none, the pattern above rejects it anyway. */
export function hasUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

const percent = z.number().int().min(0).max(100);
/** A proxy goes straight into the browser's launch options, so only a plain proxy URL is accepted. */
const proxyUrl = z
  .string()
  .regex(/^(https?|socks[45]?):\/\/[^\s]+$/, 'http://, https://, socks4:// or socks5:// URL')
  // Credentials would be stored in profiles.json and shown in the UI; only proxies without authentication are supported.
  .refine((v) => !hasUserinfo(v), 'proxy credentials are not supported; use a proxy that needs no username or password');
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'letters, digits, - and _ only');

const runModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('endless') }),
  z
    .object({ kind: z.literal('topics'), min: z.number().int().min(1), max: z.number().int().min(1) })
    .refine((m) => m.max >= m.min, { message: 'max must not be below min' }),
  z.object({ kind: z.literal('time'), minutes: z.number().int().min(1) }),
]);

export const storedPresetSchema = z
  .object({
    id: name,
    name: z.string().min(1).max(60),
    siteId: z.string().min(1),
    profileId: z.string().min(1).nullable(),
    browserMode: z.enum(['headed', 'headless']),
    browseMode: z.enum(['deep', 'quick']),
    runMode: runModeSchema,
    categoryPaths: z.array(z.string().regex(/^\/c\/[^\s]+\/\d+$/)),
    interaction: z.object({
      like: z.object({ enabled: z.boolean(), topicRate: percent, replyRate: percent, maxReplies: z.number().int().min(0).max(MAX_REPLY_LIKES) }),
      reply: z.object({ enabled: z.boolean(), rate: percent, riskAcknowledged: z.boolean() }),
    }),
    extraWait: z
      .object({ enabled: z.boolean(), minSec: z.number().min(0).max(60), maxSec: z.number().min(0).max(60) })
      .refine((w) => w.maxSec >= w.minSec, { message: 'maxSec must not be below minSec' }),
    samplePerCategory: z
      .object({ min: z.number().int().min(1).max(50), max: z.number().int().min(1).max(50) })
      .refine((s) => s.max >= s.min, { message: 'max must not be below min' }),
  })
  .strict()
  .refine((p) => p.profileId === null || p.profileId.startsWith(`${p.siteId}/`), { message: 'the Profile must belong to the preset site', path: ['profileId'] });

export const presetSaveSchema = z.object({ preset: storedPresetSchema }).strict();

export const settingsPatchSchema = z
  .object({
    notifications: z.boolean(),
    closeToTray: z.boolean(),
    updateCheck: z.boolean(),
    currentPresetId: z.string().nullable(),
    language: z.literal('zh-CN'),
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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const scheduleSpecSchema = z
  .object({
    id: name,
    name: z.string().min(1).max(60),
    profileId: z.string().min(1),
    presetId: z.string().min(1),
    enabled: z.boolean(),
    browserMode: z.enum(['headed', 'headless']),
    timezone: z.string().min(1),
    trigger: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('cron'), expression: z.string().min(1) }),
      z.object({
        kind: z.literal('daily-window'),
        runs: z.number().int().min(1).max(24),
        start: hhmm,
        end: hhmm,
        jitterMinutes: z.number().int().min(0).max(120),
        minGapMinutes: z.number().int().min(0).max(720),
      }),
    ]),
    misfire: z.object({ policy: z.enum(['skip', 'run-once']), graceMinutes: z.number().int().min(0).max(1440) }),
    overlap: z.literal('skip'),
    unavailableDisplay: z.enum(['skip', 'fallback-headless']),
    runOnStart: z.boolean(),
  })
  .strict();

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
export type _ScheduleMatches = Assert<Same<z.output<typeof scheduleSpecSchema>, ScheduleSpec>>;
export type _ProfileCreateMatches = Assert<Same<z.output<typeof profileCreateSchema>, ProfileCreate>>;
export type _ProfilePatchMatches = Assert<Same<z.output<typeof profilePatchSchema>, ProfilePatch>>;
