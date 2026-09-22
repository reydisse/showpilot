export type ViscaUdpMode = "raw" | "sony-ip";

export function frameViscaPacket(payload: Buffer, mode: ViscaUdpMode, sequence: number, inquiry = false): Buffer {
  if (mode === "raw") return payload;
  if (payload.length < 3 || payload.length > 16) throw new Error("VISCA payload must contain 3-16 bytes");
  const packet = Buffer.alloc(8 + payload.length);
  packet.writeUInt16BE(inquiry ? 0x0110 : 0x0100, 0);
  packet.writeUInt16BE(payload.length, 2);
  packet.writeUInt32BE(sequence >>> 0, 4);
  payload.copy(packet, 8);
  return packet;
}

export function unframeViscaPacket(packet: Buffer, mode: ViscaUdpMode, expectedSequence?: number): Buffer {
  if (mode === "raw") return packet;
  if (packet.length < 11) throw new Error("Camera returned a truncated Sony VISCA-over-IP packet");
  const type = packet.readUInt16BE(0);
  const length = packet.readUInt16BE(2);
  const sequence = packet.readUInt32BE(4);
  if (type !== 0x0111) throw new Error(`Camera returned unexpected VISCA packet type 0x${type.toString(16)}`);
  if (length !== packet.length - 8) throw new Error("Camera returned an invalid VISCA payload length");
  if (expectedSequence !== undefined && sequence !== (expectedSequence >>> 0)) {
    throw new Error("Camera returned a VISCA response for another command");
  }
  return packet.subarray(8);
}

export function inspectViscaReply(packet: Buffer, mode: ViscaUdpMode, expectedSequence?: number): "ack" | "complete" {
  const payload = unframeViscaPacket(packet, mode, expectedSequence);
  if (payload.length < 3 || payload[payload.length - 1] !== 0xff || (payload[0] & 0xf0) !== 0x90) {
    throw new Error("Camera returned an invalid VISCA reply");
  }
  const replyType = payload[1] & 0xf0;
  if (replyType === 0x40) return "ack";
  if (replyType === 0x50) return "complete";
  if (replyType === 0x60) {
    const code = payload[2];
    const reason = new Map<number, string>([
      [0x01, "message length"], [0x02, "syntax"], [0x03, "command buffer full"],
      [0x04, "command canceled"], [0x05, "no socket"], [0x41, "command not executable"],
    ]).get(code) ?? `code 0x${code.toString(16).padStart(2, "0")}`;
    throw new Error(`Camera rejected the VISCA command: ${reason}`);
  }
  throw new Error("Camera returned an unknown VISCA reply");
}
