import { loadBuiltinSites, validateSite } from '@disco-lurk/config';
import { describe, expect, it } from 'vitest';
import { readData } from '../logic/data';
import { BASE_URL, SITE_IDS } from './fixtures';

const builtins = () => loadBuiltinSites(readData('sites.json') as never, readData);
const builtin = (id: string) => {
  const site = builtins().find((s) => s.id === id);
  if (!site) throw new Error(`no built-in site ${id}`);
  return site;
};

describe.each(SITE_IDS)('SITE-001 built-in site configuration (§2.2) — %s', (id) => {
  it('passes validateSite', () => {
    const result = validateSite(builtin(id));
    expect(result.ok, result.ok ? '' : result.issues.join('; ')).toBe(true);
  });

  it('is a discourse site on the fixture origin', () => {
    expect(builtin(id)).toMatchObject({ kind: 'discourse', baseUrl: BASE_URL[id] });
  });

  it("logs in headed by default", () => {
    expect(builtin(id).login).toBe('headed');
  });

  it.each(['flarum', 'Discourse', ''])('rejects kind %j', (kind) => {
    expect(validateSite({ ...builtin(id), kind }).ok).toBe(false);
  });

  it.each(['connect', 'trust-level', 'None', ''])('rejects progressSource %j', (progressSource) => {
    expect(validateSite({ ...builtin(id), progressSource }).ok).toBe(false);
  });
});
