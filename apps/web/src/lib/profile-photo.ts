import { getSquareAvatarGeometry } from "./avatar-image";

export class PhotoPreparationError extends Error {}

/** Release image resources on failure, completion, navigation or deadline. */
export function prepareProfilePhoto(
  file: File,
  signal: AbortSignal,
): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return Promise.reject(
      new PhotoPreparationError("Choose a JPG, PNG, or WebP photo."),
    );
  if (!file.size || file.size > 10 * 1024 * 1024)
    return Promise.reject(
      new PhotoPreparationError("Choose a photo smaller than 10 MB."),
    );
  return new Promise((resolve, reject) => {
    const image = new Image(),
      objectUrl = URL.createObjectURL(file);
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      URL.revokeObjectURL(objectUrl);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(
        new PhotoPreparationError(
          "Photo preparation was interrupted. Retry or choose another photo.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    image.onerror = () =>
      fail(
        new PhotoPreparationError(
          "That photo could not be opened. Choose another photo.",
        ),
      );
    image.onload = () => {
      try {
        const geometry = getSquareAvatarGeometry(
          image.width,
          image.height,
          256,
        );
        const canvas = document.createElement("canvas");
        canvas.width = geometry.outputSize;
        canvas.height = geometry.outputSize;
        const context = canvas.getContext("2d");
        if (!context)
          throw new PhotoPreparationError(
            "Your browser could not prepare that photo.",
          );
        context.drawImage(
          image,
          geometry.sourceX,
          geometry.sourceY,
          geometry.sourceSize,
          geometry.sourceSize,
          0,
          0,
          geometry.outputSize,
          geometry.outputSize,
        );
        canvas.toBlob(
          (blob) => {
            if (signal.aborted) return;
            if (!blob) {
              fail(
                new PhotoPreparationError(
                  "Your browser could not prepare that photo.",
                ),
              );
              return;
            }
            cleanup();
            resolve(blob);
          },
          "image/jpeg",
          0.85,
        );
      } catch (error) {
        fail(error);
      }
    };
    image.src = objectUrl;
  });
}
