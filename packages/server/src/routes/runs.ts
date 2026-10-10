import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_INTERACTION, DEFAULT_QUICK_FLOORS, DEFAULT_RUN_MODE, type Category, type Site } from '@disco-lurk/core';
import type { PresetSave, Settings, StoredPreset } from '../contract';
import { HttpError } from '../hub';
import { exportLogSchema, parseBody, presetSaveSchema, startRunSchema } from '../schemas';
import type { Route } from '../server';
import { toJsonl } from '../store';
import { ok, safeFileName, stamp, type AppContext } from './context';

/** The built-in defaults with the reading parameters the settings give: deep, 15–40 topics, likes and replies off. */
export function defaultPreset(site: Site, categories: readonly Category[], reading: Settings['reading']): StoredPreset {
  return {
    id: `${site.id}-default`,
    name: `${site.displayName} 默认`,
    siteId: site.id,
    profileId: null,
    browserMode: 'headed',
    browseMode: 'deep',
    runMode: structuredClone(DEFAULT_RUN_MODE),
    categoryPaths: categories.filter((c) => c.enabledByDefault).map((c) => c.path),
    interaction: structuredClone(DEFAULT_INTERACTION),
    extraWait: structuredClone(reading.extraWait),
    samplePerCategory: structuredClone(reading.samplePerCategory),
    quickFloors: { ...DEFAULT_QUICK_FLOORS },
  };
}

/** Presets, runs and their history. */
export function runRoutes(ctx: AppContext): Route[] {
  const { presets, runs, history, schedules } = ctx;
  return [
    { method: 'GET', path: '/presets', handle: async () => ok(presets.list()) },
    {
      method: 'PUT',
      path: '/presets/:id',
      handle: async ({ params, body }) => {
        const save: PresetSave = parseBody(presetSaveSchema, body);
        if (save.preset.id !== params.id) throw new HttpError(422, 'id-mismatch', 'The preset id must match the URL');
        ctx.catalog.site(save.preset.siteId);
        const stored = presets.get(save.preset.id);
        if (stored && stored.siteId !== save.preset.siteId) {
          const users = await schedules.usersOf(save.preset.id);
          if (users.length > 0) throw new HttpError(409, 'preset-in-use', `Preset ${save.preset.id} is run by schedule ${users.join(', ')}; its site cannot change`);
        }
        // Automatic replies post under the user's name; the kernel also turns them off without this.
        const reply = save.preset.interaction.reply;
        if (reply.enabled && !reply.riskAcknowledged) throw new HttpError(428, 'reply-confirmation-required', '开启自动回复需要确认风险');
        await presets.put(save.preset);
        await schedules.presetSaved(save.preset);
        return ok(save.preset);
      },
    },
    {
      method: 'DELETE',
      path: '/presets/:id',
      handle: async ({ params }) => {
        const users = await schedules.usersOf(params.id!);
        if (users.length > 0) throw new HttpError(409, 'preset-in-use', `Preset ${params.id} is run by schedule ${users.join(', ')}`);
        if (!(await presets.remove(params.id!))) throw new HttpError(404, 'unknown-preset', `Unknown preset ${params.id}`);
        return { status: 204 };
      },
    },

    { method: 'GET', path: '/runs/active', handle: async () => ok(runs.active()) },
    { method: 'POST', path: '/runs', handle: async ({ body }) => ok(await ctx.startPreset(parseBody(startRunSchema, body).presetId), 202) },
    {
      // The tray's start entry: the preset last started from the UI.
      method: 'POST',
      path: '/runs/current',
      handle: async () => {
        const id = ctx.settings.get().currentPresetId;
        if (!id) throw new HttpError(409, 'no-current-preset', '尚未从界面开始过任何预设');
        return ok(await ctx.startPreset(id), 202);
      },
    },
    { method: 'POST', path: '/runs/stop', handle: async () => ok({ stopped: runs.stopAll('user') }) },
    { method: 'POST', path: '/runs/:id/stop', handle: async ({ params }) => ok(runs.stop(params.id!)) },
    {
      method: 'GET',
      path: '/runs/history',
      handle: async ({ query }) => {
        const n = Number(query.get('limit') ?? '50');
        return ok(history.list(Number.isInteger(n) && n > 0 ? n : 50));
      },
    },
    {
      method: 'GET',
      path: '/runs/:id',
      handle: async ({ params }) => {
        const found = runs.get(params.id!) ?? history.get(params.id!);
        if (!found) throw new HttpError(404, 'unknown-run', `Unknown run ${params.id}`);
        return ok(found);
      },
    },
    {
      method: 'GET',
      path: '/runs/:id/events',
      handle: async ({ params }) => {
        const { events, skipped } = await ctx.runLog(params.id!, null);
        return { status: 200, body: events, headers: { 'X-Skipped-Lines': String(skipped) } };
      },
    },
    {
      // The event log as JSONL, optionally only some event types; `types=state,warning,error`.
      method: 'GET',
      path: '/runs/:id/log',
      handle: async ({ params, query }) => {
        const id = params.id!;
        const { events, skipped } = await ctx.runLog(id, query.get('types')?.split(',') ?? null);
        return {
          status: 200,
          text: toJsonl(events),
          contentType: 'application/x-ndjson; charset=utf-8',
          headers: { 'Content-Disposition': `attachment; filename="${safeFileName(id)}.jsonl"`, 'X-Skipped-Lines': String(skipped) },
        };
      },
    },
    {
      // The desktop webview has no download manager, so the shell's UI asks for a file on disk instead.
      method: 'POST',
      path: '/runs/:id/export',
      handle: async ({ params, body }) => {
        const id = params.id!;
        const { events, skipped } = await ctx.runLog(id, parseBody(exportLogSchema, body)?.types ?? null);
        const path = join(ctx.dataDir, 'exports', `${safeFileName(id)}-${stamp(ctx.clock)}.jsonl`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, toJsonl(events));
        return ok({ path, lines: events.length, skipped });
      },
    },
  ];
}
