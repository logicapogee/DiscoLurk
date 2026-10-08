// Runs the Tauri CLI for apps/desktop. `dev` gets --no-dev-server so the window loads the UI from
// tauri://localhost exactly as a release build does; the CLI's static dev server would give the page
// an http://127.0.0.1:1430 origin, which the sidecar's CORS allow-list rightly rejects.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop');
const args = process.argv.slice(2);
if (args[0] === 'dev' && !args.includes('--no-dev-server')) args.splice(1, 0, '--no-dev-server');
const r = spawnSync('pnpm', ['exec', 'tauri', ...args], { cwd: desktop, stdio: 'inherit' });
process.exit(r.status ?? 1);
