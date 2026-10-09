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
        // An unattended headless run can only sign in with what the Profile already holds.
        const mayRunHeadless = spec.browserMode === 'headless' || spec.unavailableDisplay === 'fallback-headless';
        if (spec.enabled && mayRunHeadless && ctx.profiles.health(spec.profileId)?.status !== 'ready') {
          throw new HttpError(428, 'health-check-required', `Profile ${spec.profileId} has not passed a health check; sign in and check it on the Profile page first`);
        }
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
