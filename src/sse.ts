/**
 * A minimal Server-Sent Events reader over `fetch`.
 *
 * `EventSource` cannot send an `Authorization` header — that is the whole
 * reason this exists rather than a dependency. It is also why the `eventsource`
 * npm package is not used: every gated endpoint here needs a bearer token on
 * the request.
 *
 * Only the parts of the SSE grammar the solver actually emits are honoured
 * (`data:` lines, blank-line frame separators, `:` comments as keep-alives).
 * There are no `event:` names, ids or retry directives in this stream, so
 * nothing here tries to reconnect: a dropped fill is a failed fill, and
 * silently restarting one would spend a second unit of the caller's monthly
 * quota without telling them.
 */

/** One decoded SSE frame: the joined `data:` payload and its optional name. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Split a byte stream into SSE frames.
 *
 * Handles `\n`, `\r\n` and lone `\r` line endings, multi-line `data:` payloads
 * (joined with `\n`, per the spec) and the optional space after the colon. A
 * trailing frame with no terminating blank line is still emitted at end of
 * stream — the solver always ends with `\n\n`, but a proxy that truncates the
 * final newline should not cost you the `complete` event.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "message";

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      return null;
    }
    const frame: SseFrame = { event: eventName, data: dataLines.join("\n") };
    dataLines = [];
    eventName = "message";
    return frame;
  };

  const handleLine = (line: string): SseFrame | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null; // keep-alive comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    return null;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize line endings before splitting so a `\r\n` stream does not
      // leave a stray `\r` on the end of every field value.
      buffer = buffer.replace(/\r\n|\r/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const frame = handleLine(line);
        if (frame) yield frame;
      }
    }
    // End of stream: the remainder is a final line, and an unterminated frame
    // still counts.
    if (buffer) {
      const frame = handleLine(buffer.replace(/\r/g, ""));
      if (frame) yield frame;
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
