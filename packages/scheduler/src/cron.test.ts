import { describe, expect, it } from 'vitest';
import { CronError, nextCronTime, parseCron } from './cron';
import { zonedToEpoch } from './tz';

const SH = 'Asia/Shanghai';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const local = (date: string, hhmm: string, tz = SH) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, tz);
};

describe('parseCron', () => {
  it('expands wildcards, lists, ranges, steps and names', () => {
    const c = parseCron('*/15 9-17/4 1,15 jan-mar MON-FRI');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect(c.hours).toEqual([9, 13, 17]);
    expect([...c.daysOfMonth]).toEqual([1, 15]);
    expect([...c.months]).toEqual([1, 2, 3]);
    expect([...c.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a start with a step as running to the end of the field', () => {
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45]);
  });

  it('folds day-of-week 7 onto Sunday', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it.each([
    ['* * * *', /5 fields/],
    ['60 * * * *', /minute 60 is outside 0-59/],
    ['* 24 * * *', /hour 24/],
    ['* * 0 * *', /day of month 0/],
    ['* * * 13 *', /month 13/],
    ['* * * * 8', /day of week 8/],
    ['*/0 * * * *', /step "0"/],
    ['5-1 * * * *', /runs backwards/],
    ['a * * * *', /"a" is not a valid minute/],
    ['1,,2 * * * *', /not a valid minute/],
  ])('rejects %s', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe('nextCronTime', () => {
  it('finds the next minute strictly after the given instant in the schedule zone', () => {
    const c = parseCron('30 8 * * *');
    expect(iso(nextCronTime(c, local('2026-10-08', '06:00'), SH))).toBe(iso(local('2026-10-08', '08:30')));
    expect(iso(nextCronTime(c, local('2026-10-08', '08:30'), SH))).toBe(iso(local('2026-10-09', '08:30')));
  });

  it('matches either day field when both are restricted', () => {
    // 2026-10-09 is a Friday; the 13th is a Tuesday.
    const c = parseCron('0 12 13 * 5');
    expect(iso(nextCronTime(c, local('2026-10-08', '13:00'), SH))).toBe(iso(local('2026-10-09', '12:00')));
    expect(iso(nextCronTime(c, local('2026-10-09', '13:00'), SH))).toBe(iso(local('2026-10-13', '12:00')));
  });

  it('honours weekday-only and month restrictions', () => {
    const c = parseCron('0 9 * 11 mon-fri');
    expect(iso(nextCronTime(c, local('2026-10-08', '00:00'), SH))).toBe(iso(local('2026-11-02', '09:00')));
  });

  it('reaches a leap day years ahead', () => {
    expect(iso(nextCronTime(parseCron('0 0 29 2 *'), local('2026-10-08', '00:00'), SH))).toBe(iso(local('2028-02-29', '00:00')));
  });

  it('fires a time skipped by spring-forward after the gap, once', () => {
    const ny = 'America/New_York';
    const c = parseCron('30 2 * * *');
    const first = nextCronTime(c, local('2026-03-08', '00:00', ny), ny)!;
    expect(new Date(first).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(new Date(nextCronTime(c, first, ny)!).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('fires a repeated fall-back hour once', () => {
    const ny = 'America/New_York';
    const c = parseCron('30 1 * * *');
    const first = nextCronTime(c, local('2026-11-01', '00:00', ny), ny)!;
    const second = nextCronTime(c, first, ny)!;
    expect(new Date(second).toISOString().slice(0, 10)).toBe('2026-11-02');
  });

  it('evaluates the same expression per zone', () => {
    const c = parseCron('0 7 * * *');
    const after = Date.parse('2026-10-08T00:00:00Z');
    expect(iso(nextCronTime(c, after, 'UTC'))).toBe('2026-10-08T07:00:00.000Z');
    expect(iso(nextCronTime(c, after, SH))).toBe('2026-10-08T23:00:00.000Z');
  });
});
