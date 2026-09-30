/** Best human-readable text for whatever a failed call threw. Home Assistant's websocket rejects
 * with `{code, message}` objects whose message is already written for people. */
export function describeError(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
