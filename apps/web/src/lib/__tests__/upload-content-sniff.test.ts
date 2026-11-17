import { expect, it } from "vitest";
import { sniffUploadContent, decideUploadContentType } from "../upload-content-sniff";
const signatures: [string, number[]][] = [
  ["image/jpeg", [255,216,255]], ["image/png", [137,80,78,71,13,10,26,10]],
  ["image/webp", [...new TextEncoder().encode("RIFF0000WEBP")]],
  ["image/gif", [...new TextEncoder().encode("GIF87a")]],
  ["image/gif", [...new TextEncoder().encode("GIF89a")]],
  ["image/avif", [0,0,0,16,...new TextEncoder().encode("ftypavif0000")]],
  ["application/pdf", [...new TextEncoder().encode("%PDF-")]],
  ["application/zip", [80,75,3,4]], ["application/x-ole-storage", [208,207,17,224,161,177,26,225]],
];
it.each(signatures)("detects %s", (mime, bytes) => expect(sniffUploadContent(new Uint8Array(bytes))).toBe(mime));
it("rejects mismatches, unsigned images and NUL text", () => {
 expect(decideUploadContentType("image/png", new TextEncoder().encode("%PDF-"))).toBeNull();
 expect(decideUploadContentType("image/jpeg", new Uint8Array([1]))).toBeNull();
 expect(decideUploadContentType("text/plain", new Uint8Array([0]))).toBeNull();
 expect(decideUploadContentType("text/plain", new TextEncoder().encode("notes"))).toBe("text/plain");
 const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
 expect(decideUploadContentType(mime, new Uint8Array([80,75,3,4]))).toBe(mime);
});
