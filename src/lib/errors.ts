/** Best human-readable text for whatever a failed call threw. Home Assistant's websocket rejects
 * with `{code, message}` objects whose message is already written for people; its REST helper
 * (`hass.callApi`) rejects with `{status_code, body}` where the body carries the message (or is
 * the message). */
export function describeError(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string" && error.message) return error.message;
    if ("body" in error) {
      const body = error.body;
      if (typeof body === "string" && body) return body;
      if (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message) return body.message;
    }
  }
  return fallback;
}

/** The websocket error code (`unauthorized`, `not_found`, ...) a failed command carries, if any. */
export function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}
