/** Time of day in Home Assistant's time zone: the light's clock is synced from HA, so the "now"
 * marker must follow HA's zone, not the viewing device's. */

export function minutesOfDay(date: Date, timeZone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return (hour % 24) * 60 + minute;
  } catch {
    // Unknown zone name: fall through to the device's local time.
  }
  return date.getHours() * 60 + date.getMinutes();
}

/** A wall-clock date and time, as Home Assistant prints a date-time helper's state. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `epochMs`. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(epochMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second"));
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** The instant (ms since the epoch) at which `timeZone`'s clock shows `wall`. Without a zone, or
 * with one the browser does not know, the device's own clock is used. A time that happens twice
 * (clocks going back) or never (going forward) resolves to one of its neighbours, as `Date` does. */
export function zonedTimeToEpochMs(wall: WallTime, timeZone?: string): number {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = wall;
  if (timeZone) {
    try {
      const naive = Date.UTC(year, month - 1, day, hour, minute, second);
      // The offset depends on the instant, so settle it in two passes (the second corrects a guess
      // that landed on the other side of a daylight-saving change).
      const first = naive - zoneOffsetMs(naive, timeZone);
      return naive - zoneOffsetMs(first, timeZone);
    } catch {
      // Unknown zone name: fall through to the device's local time.
    }
  }
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}
