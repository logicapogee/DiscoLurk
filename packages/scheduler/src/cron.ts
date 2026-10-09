import { localParts, zonedToEpoch } from './tz';

/** A parsed five-field cron expression: minute, hour, day of month, month, day of week. */
interface CronExpression {
  source: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Classic cron matches a day when either day field matches, if both are restricted. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset of `names[0]`'s value. */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  // 7 is accepted as Sunday, as in most crons, and folded onto 0.
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

export class CronError extends Error {
  constructor(expression: string, detail: string) {
    super(`Invalid cron expression "${expression}": ${detail}`);
    this.name = 'CronError';
  }
}

function parseValue(raw: string, f: FieldSpec, expression: string): number {
  const named = f.names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + (f.nameBase ?? 0);
  if (!/^\d+$/.test(raw)) throw new CronError(expression, `"${raw}" is not a valid ${f.name}`);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new CronError(expression, `${f.name} ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(raw: string, f: FieldSpec, expression: string): { values: number[]; restricted: boolean } {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw, ...extra] = part.split('/');
    if (range === undefined || range === '' || extra.length > 0) throw new CronError(expression, `"${part}" is not a valid ${f.name}`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) === 0) throw new CronError(expression, `step "${stepRaw}" in ${f.name} must be a positive number`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.max;
    } else if (range.includes('-')) {
      const [a, b, ...more] = range.split('-');
      if (a === undefined || b === undefined || more.length > 0) throw new CronError(expression, `"${range}" is not a valid ${f.name} range`);
      lo = parseValue(a, f, expression);
      hi = parseValue(b, f, expression);
      if (hi < lo) throw new CronError(expression, `${f.name} range ${range} runs backwards`);
    } else {
      lo = parseValue(range, f, expression);
      // `5/15` means "from 5 to the end in steps of 15".
      hi = stepRaw === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  // Vixie cron: a field starting with `*` (`*`, `*/2`) leaves the day unrestricted, so `*/2` in
  // day-of-month combined with a weekday means both must match, not either.
  return { values: [...values].sort((a, b) => a - b), restricted: !raw.startsWith('*') };
}

export function parseCron(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(expression, `expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [min, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!, expression)) as [
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
    ReturnType<typeof parseField>,
  ];
  return {
    source: expression,
    minutes: min.values,
    hours: hour.values,
    daysOfMonth: new Set(dom.values),
    months: new Set(month.values),
    daysOfWeek: new Set(dow.values.map((d) => d % 7)),
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

function dayMatches(cron: CronExpression, date: string): boolean {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (!cron.months.has(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = cron.daysOfMonth.has(d);
  const dowOk = cron.daysOfWeek.has(dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Days searched before giving up; covers `0 0 29 2 *`, which may skip up to eight years. */
const SEARCH_DAYS = 366 * 9;

/**
 * The first matching wall-clock minute in `timeZone` strictly after `afterMs`. A time skipped by
 * a DST change fires at the first instant after the gap; a repeated hour fires once.
 */
export function nextCronTime(cron: CronExpression, afterMs: number, timeZone: string): number | null {
  let date = localParts(afterMs, timeZone).date;
  for (let i = 0; i < SEARCH_DAYS; i++, date = nextDate(date)) {
    if (!dayMatches(cron, date)) continue;
    for (const h of cron.hours) {
      for (const m of cron.minutes) {
        const at = zonedToEpoch(date, h * 60 + m, timeZone);
        if (at > afterMs) return at;
      }
    }
  }
  return null;
}
