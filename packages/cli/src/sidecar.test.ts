import { PassThrough } from 'node:stream';
import type { LurkApp, Route } from '@disco-lurk/server';
import { describe, expect, it } from 'vitest';
import { SidecarLifecycle } from './lifecycle';
import { parseShellCommand, serveShellCommands, stdoutShell, type SidecarLine } from './sidecar';

const tick = () => new Promise((r) => setTimeout(r, 20));

function harness(routes: Route[]) {
  const input = new PassThrough();
  const lines: SidecarLine[] = [];
  const lifecycle = new SidecarLifecycle();
  serveShellCommands({ input, app: { routes } as unknown as LurkApp, lifecycle, write: (l) => lines.push(l), log: () => {} });
  return { input, lines, lifecycle };
}

const route = (path: string, handle: Route['handle']): Route => ({ method: 'POST', path, handle });

describe('sidecar stdin/stdout protocol', () => {
  it('accepts only the three tray commands', () => {
    expect(parseShellCommand('{"cmd":"start"}')).toBe('start');
    expect(parseShellCommand('{"cmd":"shutdown"}')).toBe('shutdown');
    expect(parseShellCommand('{"cmd":"rm"}')).toBeNull();
    expect(parseShellCommand('not json')).toBeNull();
    expect(parseShellCommand('null')).toBeNull();
  });

  it('runs start and stop through their REST routes and answers each with a result line', async () => {
    const calls: string[] = [];
    const h = harness([
      route('/runs/current', async () => {
        calls.push('current');
        throw new Error('尚未从界面开始过任何预设');
      }),
      route('/runs/stop', async () => {
        calls.push('stop');
        return { status: 200 };
      }),
    ]);
    h.input.write('{"cmd":"start"}\n{"cmd":"stop"}\n');
    await tick();
    expect(calls).toEqual(['current', 'stop']);
    expect(h.lines).toEqual([
      { event: 'result', cmd: 'start', ok: false, message: '尚未从界面开始过任何预设' },
      { event: 'result', cmd: 'stop', ok: true },
    ]);
  });

  it('shutdown runs the lifecycle cleanup', async () => {
    const h = harness([]);
    let cleaned = false;
    h.lifecycle.register('probe', async () => {
      cleaned = true;
    });
    h.input.write('{"cmd":"shutdown"}\n');
    await h.lifecycle.done;
    expect(cleaned).toBe(true);
    expect(h.lines).toEqual([{ event: 'result', cmd: 'shutdown', ok: true }]);
  });

  it('reports runs and token rotations as stdout lines', () => {
    const lines: SidecarLine[] = [];
    const shell = stdoutShell((l) => lines.push(l));
    shell.activeRuns(2);
    shell.token('t');
    shell.notify('a', 'b');
    expect(lines).toEqual([
      { event: 'runs', active: 2 },
      { event: 'token', token: 't' },
      { event: 'notify', title: 'a', body: 'b' },
    ]);
  });
});
