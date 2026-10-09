import type { ProfileCreate, ProfilePatch, SiteView } from '../contract';
import { HttpError } from '../hub';
import { validateSite } from '@disco-lurk/config';
import type { Site } from '@disco-lurk/core';
import { parseBody, profileCreateSchema, profilePatchSchema, refreshCategoriesSchema, siteCreateSchema } from '../schemas';
import type { Route } from '../server';
import { splitProfileId, type SiteStore } from '../store';
import { ok, stamp, type AppContext } from './context';
import { defaultPreset } from './runs';

/** Sites, Profiles and headed sign-ins. */
/** A user-added Discourse site: categories are read after sign-in, and it has no progress page. */
export function customSite(req: { id?: string | undefined; displayName: string; baseUrl: string; login: 'headed' | 'password' }): Site {
  const url = new URL(req.baseUrl);
  const id =
    req.id ??
    url.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  const checked = validateSite({
    id,
    displayName: req.displayName,
    baseUrl: url.origin,
    kind: 'discourse',
    login: req.login,
    categorySource: 'discovered',
    progressSource: 'none',
    behaviorVerified: { clickEntryRequired: 'unverified' },
  });
  if (!checked.ok) throw new HttpError(422, 'invalid-body', checked.issues.join('; '));
  return checked.site;
}

export function profileRoutes(ctx: AppContext, userSites: SiteStore): Route[] {
  const { catalog, profiles, logins } = ctx;
  return [
    {
      method: 'GET',
      path: '/sites',
      handle: async () => ok(catalog.sites.map((site): SiteView => ({ site, categories: catalog.categories(site.id) }))),
    },
    {
      method: 'POST',
      path: '/sites',
      handle: async ({ body }) => {
        const site = customSite(parseBody(siteCreateSchema, body));
        catalog.add(site);
        await userSites.add(site);
        return ok({ site, categories: [] } satisfies SiteView, 201);
      },
    },
    {
      method: 'GET',
      path: '/sites/:site/categories',
      handle: async ({ params }) => ok(await catalog.refresh(catalog.site(params.site!).id)),
    },
    {
      // Categories of a discovered site are read by a signed-in health check of one of its Profiles.
      method: 'POST',
      path: '/sites/:site/categories/refresh',
      handle: async ({ params, body }) => {
        const site = catalog.site(params.site!);
        const { profileId } = parseBody(refreshCategoriesSchema, body);
        if (splitProfileId(profileId).siteId !== site.id) throw new HttpError(422, 'invalid-body', 'profileId of this site is required');
        const health = await ctx.inspect(profileId);
        return ok({ health, categories: catalog.categories(site.id) });
      },
    },
    {
      method: 'GET',
      path: '/sites/:site/default-preset',
      handle: async ({ params }) => {
        const site = catalog.site(params.site!);
        return ok(defaultPreset(site, catalog.categories(site.id), ctx.settings.get().reading));
      },
    },

    { method: 'GET', path: '/profiles', handle: async () => ok(await profiles.list((id) => ctx.gate.isBusy(id))) },
    {
      method: 'POST',
      path: '/profiles',
      handle: async ({ body }) => {
        const req: ProfileCreate = parseBody(profileCreateSchema, body);
        catalog.site(req.siteId);
        await profiles.create(req);
        await ctx.publishProfiles();
        return ok({ id: `${req.siteId}/${req.name}` }, 201);
      },
    },
    {
      method: 'PATCH',
      path: '/profiles/:site/:name',
      handle: async ({ params, body }) => {
        const id = await ctx.withProfile(params);
        const patch: ProfilePatch = parseBody(profilePatchSchema, body);
        await profiles.patch(id, patch);
        await ctx.publishProfiles();
        return ok({ id });
      },
    },
    {
      method: 'DELETE',
      path: '/profiles/:site/:name',
      handle: async ({ params }) => {
        const id = await ctx.withProfile(params);
        await ctx.requireFree(id);
        await profiles.remove(id);
        await ctx.publishProfiles();
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/profiles/:site/:name/backup',
      handle: async ({ params }) => {
        const id = await ctx.withProfile(params);
        await ctx.requireFree(id);
        return ok({ path: await profiles.backup(id, stamp(ctx.clock)) });
      },
    },
    { method: 'POST', path: '/profiles/:site/:name/inspect', handle: async ({ params }) => ok(await ctx.inspect(await ctx.withProfile(params))) },

    { method: 'GET', path: '/logins', handle: async () => ok(logins.list()) },
    {
      method: 'POST',
      path: '/profiles/:site/:name/login',
      handle: async ({ params }) => {
        if (ctx.headlessOnly) throw new HttpError(422, 'no-display', '此服务器没有图形界面，无法打开有头登录窗口');
        const id = await ctx.withProfile(params);
        const current = logins.get(id);
        if (!current || ['done', 'failed', 'closed'].includes(current.phase)) await ctx.requireFree(id);
        return ok(logins.start(id), 202);
      },
    },
    { method: 'POST', path: '/profiles/:site/:name/login/recheck', handle: async ({ params }) => ok(logins.recheck(await ctx.withProfile(params)), 202) },
    { method: 'POST', path: '/profiles/:site/:name/login/continue', handle: async ({ params }) => ok(logins.continue(await ctx.withProfile(params)), 202) },
    { method: 'POST', path: '/profiles/:site/:name/login/close', handle: async ({ params }) => ok(await logins.close(await ctx.withProfile(params))) },
  ];
}
