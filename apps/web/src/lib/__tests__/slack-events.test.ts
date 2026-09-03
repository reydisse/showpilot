import { describe, expect, it } from "vitest";
import { parseSlackEventEnvelope, verifySlackSignature } from "@/lib/slack-events";

async function signature(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return `v0=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Slack Events API boundary", () => {
  it("verifies signatures and rejects replays", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = "1788391000";
    const secret = "signing-secret";
    const signed = await signature(body, timestamp, secret);

    await expect(verifySlackSignature(body, timestamp, signed, secret, 1_788_391_050_000)).resolves.toBe(true);
    await expect(verifySlackSignature(body, timestamp, signed, secret, 1_788_391_400_001)).resolves.toBe(false);
    await expect(verifySlackSignature(`${body}x`, timestamp, signed, secret, 1_788_391_050_000)).resolves.toBe(false);
  });

  it("keeps Slack thread roots and ShowPilot loop identities", () => {
    expect(parseSlackEventEnvelope({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C1",
        ts: "1788391002.000200",
        thread_ts: "1788391000.000100",
        text: "Thread reply",
        user: "U2",
        metadata: { event_type: "showpilot_message", event_payload: { native_id: "native-1" } },
      },
    })).toEqual({
      kind: "message",
      channelId: "C1",
      message: expect.objectContaining({
        externalId: "1788391002.000200",
        replyToExternalId: "1788391000.000100",
        sourceNativeId: "native-1",
      }),
    });
  });

  it("normalizes Slack edits and deletions into canonical mutations", () => {
    expect(parseSlackEventEnvelope({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: {
          type: "message",
          ts: "1788391002.000200",
          text: "Corrected reply",
          user: "U2",
          edited: { ts: "1788391010.000300" },
        },
      },
    })).toEqual({
      kind: "message",
      channelId: "C1",
      message: expect.objectContaining({
        externalId: "1788391002.000200",
        text: "Corrected reply",
        editedAt: 1_788_391_010_000,
      }),
    });

    expect(parseSlackEventEnvelope({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        deleted_ts: "1788391002.000200",
        event_ts: "1788391020.000400",
        previous_message: { text: "Corrected reply", user: "U2" },
      },
    })).toEqual({
      kind: "message",
      channelId: "C1",
      message: expect.objectContaining({
        externalId: "1788391002.000200",
        text: "",
        deletedAt: 1_788_391_020_000,
      }),
    });
  });
});
