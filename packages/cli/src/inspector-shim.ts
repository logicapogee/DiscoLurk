import Module from 'node:module';

// @yao-pkg/pkg's Node base binaries are built without the inspector, yet playwright-core requires
// `inspector` eagerly; it only calls `inspector.url()` in page.pause() and `Session` for
// PW_PROFILE_DIR profiling. With no inspector no debugger can be attached, so `url()` returning
// undefined is the true answer, and profiling fails loudly instead of at import time.
if (!process.features.inspector) {
  const stub = {
    url: () => undefined,
    Session: class {
      constructor() {
        throw new Error('The inspector is not available in this build of lurk');
      }
    },
  };
  type Load = (request: string, ...rest: unknown[]) => unknown;
  const mod = Module as unknown as { _load: Load };
  const load = mod._load;
  mod._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'inspector' || request === 'node:inspector' ? stub : load.call(this, request, ...rest);
  };
}
