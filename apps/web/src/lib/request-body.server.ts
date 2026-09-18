export type RequestBodyReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 413 };

export function contentLengthExceeds(request: Request, maximumBytes: number): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const value = Number(raw);
  return Number.isFinite(value) && value > maximumBytes;
}

export async function readRequestTextWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<RequestBodyReadResult> {
  if (contentLengthExceeds(request, maximumBytes)) return { ok: false, status: 413 };
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

export async function readRequestJsonWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const body = await readRequestTextWithinLimit(request, maximumBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
