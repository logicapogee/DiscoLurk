import { isTauri } from '@tauri-apps/api/core';

/** Native entry points exist only inside the Tauri shell; a remote browser hides them. */
export const platform = {
  desktop: isTauri(),
};
