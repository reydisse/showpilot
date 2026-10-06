// Bound file preparation, fetch, and response parsing, including native work
// that does not settle when AbortSignal is triggered.
export async function withUploadTimeout<T>(upload: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("The upload timed out. Check your connection and choose the attachment again."));
      controller.abort();
    }, 60_000);
  });
  try {
    return await Promise.race([upload(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
