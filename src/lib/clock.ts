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
