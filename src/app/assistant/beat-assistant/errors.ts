/** True for the error a stopped request ends with (`AbortController.abort()`), which is not a failure to report. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** An error's message, or the thrown value as text, for a line in the chat. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
