import { HttpError } from '../hub';
import { limitedScheduleSpecSchema, parseBody } from '../schemas';
import type { Route } from '../server';
import { ok, type AppContext } from './context';

export function scheduleRoutes(ctx: AppContext): Route[] {
  const { schedules } = ctx;
  return [
    { method: 'GET', path: '/schedules', handle: async () => ok(schedules.list()) },
    {
      method: 'PUT',
      path: '/schedules/:id',
      handle: async ({ params, body }) => {
        const spec = parseBody(limitedScheduleSpecSchema, body);
        if (spec.id !== params.id) throw new HttpError(422, 'id-mismatch', 'The schedule id must match the URL');
        await ctx.requireProfile(spec.profileId);
        return ok(await schedules.upsert(spec));
      },
    },
    { method: 'DELETE', path: '/schedules/:id', handle: async ({ params }) => ok(await schedules.remove(params.id!)) },
    { method: 'POST', path: '/schedules/:id/trigger', handle: async ({ params }) => ok({ runId: await schedules.trigger(params.id!) }, 202) },
    { method: 'POST', path: '/schedules/:id/pause', handle: async ({ params }) => ok(await schedules.control(params.id!, 'pause')) },
    { method: 'POST', path: '/schedules/:id/resume', handle: async ({ params }) => ok(await schedules.control(params.id!, 'resume')) },
    { method: 'GET', path: '/schedules/:id/history', handle: async ({ params }) => ok(schedules.history(params.id!)) },
  ];
}
