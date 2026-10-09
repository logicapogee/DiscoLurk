const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  date: string;
  minutes: number;
}

export function localParts(epochMs: number, timeZone: string): LocalParts {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(epochMs).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function offsetMs(epochMs: number, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(epochMs).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch milliseconds of a wall-clock time in an IANA zone; a time skipped by DST resolves forward. */
export function zonedToEpoch(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const o1 = offsetMs(naive, timeZone);
  const t1 = naive - o1;
  const o2 = offsetMs(t1, timeZone);
  if (o1 === o2) return t1;
  const t2 = naive - o2;
  return offsetMs(t2, timeZone) === o2 ? t2 : Math.max(t1, t2);
}

export function parseHhmm(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time "${value}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}
