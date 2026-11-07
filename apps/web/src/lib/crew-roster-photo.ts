/** Read a retained photo draft with a deadline, including readers that never settle. */
export function readCrewPhoto(
  file: File,
  signal: AbortSignal,
): Promise<string> {
  if (file.size > 1_500_000)
    return Promise.reject(new Error("Choose a photo smaller than 1.5 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) {
        reader.abort();
        reject(error);
      } else if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read this photo. Choose it again."));
    };
    const cancel = () => finish(new Error("Photo preparation cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Photo preparation timed out. Try again or choose a smaller photo.",
          ),
        ),
      5_000,
    );
    reader.onload = () => finish();
    reader.onerror = () =>
      finish(new Error("Could not read this photo. Choose it again."));
    reader.onabort = cancel;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      reader.readAsDataURL(file);
    } catch {
      finish(new Error("Could not read this photo. Choose it again."));
    }
  });
}
