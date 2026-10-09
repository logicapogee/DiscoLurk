import { homedir } from 'node:os';
import { join } from 'node:path';

/** `<appData>/disco-lurk/`, using each platform's application-data root. */
export function appDataDir(platform = process.platform, env = process.env, home = homedir()): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'disco-lurk');
    case 'win32':
      return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'disco-lurk');
    default:
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'disco-lurk');
  }
}

export const profilesDir = (base = appDataDir()) => join(base, 'profiles');
export const sitesDir = (base = appDataDir()) => join(base, 'sites');
export const ledgersDir = (base = appDataDir()) => join(base, 'ledgers');

/** A Profile's browser data directory, `profiles/<siteId>/<name>`. */
export const profileDir = (profile: { siteId: string; name: string }, base = appDataDir()) => join(profilesDir(base), profile.siteId, profile.name);

/** A Profile's visit ledger, `ledgers/<siteId>/<name>.json`. */
export const ledgerFile = (profile: { siteId: string; name: string }, base = appDataDir()) => join(ledgersDir(base), profile.siteId, `${profile.name}.json`);
