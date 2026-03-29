/**
 * OSC (Open Sound Control) message encoding and decoding.
 * Used for Behringer X32, Wing, Allen & Heath, Yamaha, QLab, and more.
 *
 * OSC spec: https://opensoundcontrol.stanford.edu/spec-1_0.html
 * - Addresses: null-terminated, padded to 4 bytes
 * - Type tags: ",ifs..." format (i=int32, f=float32, s=string)
 * - Data: each arg padded to 4-byte boundary
 */

export interface OscArg {
  type: "i" | "f" | "s";
  value: number | string;
}

export interface OscMessage {
  address: string;
  args: OscArg[];
}

// ─── Encoding ─────────────────────────────────────────────

export function encodeOscMessage(address: string, args: OscArg[]): Buffer {
  const parts: Buffer[] = [];

  // Address string (null-terminated, padded to 4 bytes)
  parts.push(encodeOscString(address));

  // Type tag string
  const typeTag = "," + args.map((a) => a.type).join("");
  parts.push(encodeOscString(typeTag));

  // Arguments
  for (const arg of args) {
    switch (arg.type) {
      case "i":
        parts.push(encodeInt32(arg.value as number));
        break;
      case "f":
        parts.push(encodeFloat32(arg.value as number));
        break;
      case "s":
        parts.push(encodeOscString(arg.value as string));
        break;
    }
  }

  return Buffer.concat(parts);
}

// ─── Decoding ─────────────────────────────────────────────

export function decodeOscMessage(buf: Buffer): OscMessage {
  let offset = 0;

  // Read address
  const { value: address, newOffset: o1 } = readOscString(buf, offset);
  offset = o1;

  // Read type tag
  const { value: typeTag, newOffset: o2 } = readOscString(buf, offset);
  offset = o2;

  // Parse args based on type tag (skip the leading comma)
  const args: OscArg[] = [];
  const types = typeTag.slice(1); // Remove ","

  for (const t of types) {
    switch (t) {
      case "i": {
        const val = buf.readInt32BE(offset);
        offset += 4;
        args.push({ type: "i", value: val });
        break;
      }
      case "f": {
        const val = buf.readFloatBE(offset);
        offset += 4;
        args.push({ type: "f", value: val });
        break;
      }
      case "s": {
        const { value, newOffset } = readOscString(buf, offset);
        offset = newOffset;
        args.push({ type: "s", value });
        break;
      }
    }
  }

  return { address, args };
}

// ─── Helpers ──────────────────────────────────────────────

function encodeOscString(str: string): Buffer {
  const strBuf = Buffer.from(str, "ascii");
  // Null terminate + pad to 4-byte boundary
  const padded = 4 - ((strBuf.length + 1) % 4);
  const totalPad = padded === 4 ? 1 : padded + 1; // at least 1 null byte
  const result = Buffer.alloc(strBuf.length + totalPad, 0);
  strBuf.copy(result);
  return result;
}

function encodeInt32(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(Math.round(val));
  return buf;
}

function encodeFloat32(val: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(val);
  return buf;
}

function readOscString(
  buf: Buffer,
  offset: number
): { value: string; newOffset: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) {
    end++;
  }
  const value = buf.toString("ascii", offset, end);
  // Skip null terminator + padding to 4-byte boundary
  const padded = end + 1;
  const aligned = padded + ((4 - (padded % 4)) % 4);
  return { value, newOffset: aligned };
}
