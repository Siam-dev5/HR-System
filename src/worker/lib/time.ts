const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Current date/time in Asia/Bangkok (UTC+7, no DST) as { date: YYYY-MM-DD, time: HH:MM }. */
export function bangkokNow(now = Date.now()): { date: string; time: string } {
  const iso = new Date(now + BANGKOK_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** SQLite datetime string (UTC) offset by the given minutes from now. */
export function sqlDateTime(offsetMinutes = 0, now = Date.now()): string {
  return new Date(now + offsetMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}
