// Seconds between runs of a CRE cron schedule (six fields, seconds first) that fires at a fixed
// interval: "0 */N * * * *" (every N minutes), "0 * * * * *" (every minute) or "*/N * * * * *"
// (every N seconds).
export function periodSec(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 6 || fields.slice(2).some((f) => f !== "*")) throw new Error(`unsupported schedule "${schedule}"`);
  const [sec, min] = fields as [string, string];
  const every = (f: string) => (f === "*" ? 1 : /^\*\/\d+$/.test(f) ? Number(f.slice(2)) : NaN);
  if (sec === "0" && every(min) > 0) return every(min) * 60;
  if (min === "*" && every(sec) > 0 && sec !== "*") return every(sec);
  throw new Error(`unsupported schedule "${schedule}"`);
}

/**
 * The run's position in the schedule, from its scheduled time: consecutive runs get consecutive
 * numbers, and every DON node computes the same one. Counting in the schedule's own period
 * matters, since a step of several units could make a rotation revisit the same positions. A
 * schedule without a fixed interval counts minutes.
 */
export function runNumber(scheduledSec: number, schedule: string): number {
  let period = 60;
  try {
    period = periodSec(schedule);
  } catch {
    // Not a fixed interval: minutes.
  }
  return Math.floor(scheduledSec / period);
}
