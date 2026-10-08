import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));

export const readData = (name: string): unknown => JSON.parse(readFileSync(dataDir + name, 'utf8'));
