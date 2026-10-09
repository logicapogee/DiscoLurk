import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { issuesOf } from './schemas';

/** A data file that exists but cannot be used; the message names the file. */
export class ConfigFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}; fix or delete the file`);
    this.name = 'ConfigFileError';
  }
}

/** Temp file + rename, so a crash mid-write leaves the previous file intact. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique per write: two writers in one process (or two processes) never share a temp file.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** The parsed file, or null when it does not exist. */
export async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigFileError(path, `not valid JSON (${(err as Error).message})`);
  }
}

/**
 * One JSON file checked against `schema` on load and replaced atomically on save. Saves run one
 * after another in call order, so an older value never lands last.
 */
export class JsonFile<S extends z.ZodType> {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly schema: S,
    /** Names the kind of file in error messages, e.g. "schedule file". */
    private readonly what = 'data file',
  ) {}

  /** The validated contents, or null when the file does not exist. */
  async load(): Promise<z.output<S> | null> {
    const json = await readJson(this.path);
    if (json === null) return null;
    const parsed = this.schema.safeParse(json);
    if (!parsed.success) throw new ConfigFileError(this.path, `not a valid ${this.what} (${issuesOf(parsed.error)})`);
    return parsed.data;
  }

  /** Changes whenever the file is replaced (modification time and size); null when it does not exist. */
  async version(): Promise<string | null> {
    try {
      const st = await stat(this.path);
      return `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Serializes `value` at once, so changes made to it after the call never reach the file. */
  save(value: z.input<S>): Promise<void> {
    const text = JSON.stringify(value, null, 2) + '\n';
    const write = this.writes.catch(() => {}).then(() => writeTextAtomic(this.path, text));
    this.writes = write;
    return write;
  }
}
