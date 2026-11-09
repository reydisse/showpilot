import { csvTextSchema, MAX_CSV_BYTES } from "./csv-import-contract";

/** Only a successful, bounded read may replace the editor's current CSV. */
export function readCrewCsvFile(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  if (file.size > MAX_CSV_BYTES)
    return Promise.reject(
      new Error("CSV too large (max 512 KB). Your previous CSV is unchanged."),
    );
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let finished = false;
    const complete = (result: { text: string } | { error: Error }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reader.onload = reader.onerror = reader.onabort = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
      if ("error" in result) reject(result.error);
      else resolve(result.text);
    };
    const abort = () =>
      complete({
        error: new Error(
          "CSV file reading was cancelled. Your previous CSV is unchanged.",
        ),
      });
    const timer = setTimeout(
      () =>
        complete({
          error: new Error(
            `Reading ${file.name} timed out. Your previous CSV is unchanged.`,
          ),
        }),
      8_000,
    );
    reader.onload = () => {
      const parsed = csvTextSchema.safeParse(reader.result);
      complete(
        parsed.success
          ? { text: parsed.data }
          : {
              error: new Error(
                parsed.error.issues[0]?.message ??
                  "The file could not be read as CSV.",
              ),
            },
      );
    };
    reader.onerror = () =>
      complete({
        error: new Error(
          `Could not read ${file.name}. Your previous CSV is unchanged.`,
        ),
      });
    reader.onabort = abort;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else
      try {
        reader.readAsText(file);
      } catch {
        complete({
          error: new Error(
            `Could not read ${file.name}. Your previous CSV is unchanged.`,
          ),
        });
      }
  });
}
