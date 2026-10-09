export interface SSEMessage {
  event?: string;
  data: string;
}

function parseBlock(block: string): SSEMessage | null {
  const lines = block.split("\n");
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // komentar (":") dan field lain diabaikan
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join("\n") };
}

/** Baca server-sent events dari body Response. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const message = parseBlock(block);
      if (message) yield message;
      index = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    const message = parseBlock(buffer.replace(/\r\n/g, "\n"));
    if (message) yield message;
  }
}
