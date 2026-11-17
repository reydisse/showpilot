/** Detect supported binary signatures without trusting multipart metadata. */
export function sniffUploadContent(bytes: Uint8Array): string | null {
  const at = (offset: number, signature: number[]) => signature.every((v, i) => bytes[offset + i] === v);
  const ascii = (offset: number, value: string) => at(offset, Array.from(value, c => c.charCodeAt(0)));
  if (at(0, [255, 216, 255])) return "image/jpeg";
  if (at(0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (bytes.length >= 16 && ascii(4, "ftyp")) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length) {
      for (let i = 8; i + 4 <= size; i += 4) {
        if (i !== 12 && (ascii(i, "avif") || ascii(i, "avis"))) return "image/avif";
      }
    }
  }
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (at(0, [80, 75, 3, 4])) return "application/zip";
  if (at(0, [208, 207, 17, 224, 161, 177, 26, 225])) return "application/x-ole-storage";
  return null;
}

const ooxml = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const ole = new Set(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
const binary = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "application/pdf"]);

export function decideUploadContentType(declared: string, bytes: Uint8Array): string | null {
  const detected = sniffUploadContent(bytes);
  if (declared === "text/plain" || declared === "text/csv") return detected || bytes.includes(0) ? null : declared;
  if (ooxml.has(declared)) return detected === "application/zip" ? declared : null;
  if (ole.has(declared)) return detected === "application/x-ole-storage" ? declared : null;
  return binary.has(declared) && detected === declared ? detected : null;
}
