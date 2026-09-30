/** Keyboard model for a roving-tabindex group (radio groups, tabs, chips): one tab stop, arrows
 * move within it. Left/Up go to the previous item, Right/Down to the next, both wrapping; Home
 * and End jump to the ends. Returns null for keys the group does not handle. */
export function nextRovingIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1 + count) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
