import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchExternalChatHistory,
  loadExternalChatConfiguration,
  sendExternalChatMessage,
  updateExternalChatMessage,
  type ExternalChatSettingsStore,
} from "@/lib/external-chat-gateway";

function settingsStore(settings: Record<string, string>): ExternalChatSettingsStore {
  return {
    prepare: () => ({
      bind: () => ({
        all: async <T>() => ({
          results: Object.entries(settings).map(([key, value]) => ({ key, value })) as T[],
        }),
      }),
    }),
  };
}

describe("external chat gateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads only a complete selected adapter configuration", async () => {
    await expect(loadExternalChatConfiguration(settingsStore({ "chat-adapter": "native" }), "org-1"))
      .resolves.toBeNull();
    await expect(loadExternalChatConfiguration(settingsStore({
      "chat-adapter": "mattermost",
      "mattermost-url": "https://chat.example.com/",
      "mattermost-token": "token",
      "mattermost-channel": "production",
    }), "org-1")).resolves.toEqual({
      platform: "mattermost",
      baseUrl: "https://chat.example.com",
      token: "token",
      channelId: "production",
    });
    await expect(loadExternalChatConfiguration(settingsStore({ "chat-adapter": "slack" }), "org-1"))
      .rejects.toThrow("slack-token is missing");
  });

  it("sends Mattermost replies with a stable ShowPilot identity", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "post-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendExternalChatMessage({
      platform: "mattermost",
      baseUrl: "https://chat.example.com",
      token: "token",
      channelId: "channel-1",
    }, {
      id: "aa7189b8-2f50-4ef6-8363-4d99a7e418ce",
      senderName: "Ava",
      text: "Camera two is ready",
      type: "cue",
    }, "post-1")).resolves.toEqual({ externalId: "post-2" });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      channel_id: "channel-1",
      root_id: "post-1",
      message: "**Ava**: [CUE] Camera two is ready",
      props: {
        override_username: "Ava",
        showpilot_type: "cue",
        showpilot_message_id: "aa7189b8-2f50-4ef6-8363-4d99a7e418ce",
      },
    });
  });

  it("keeps Slack cursors in Slack timestamp units and preserves thread roots", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      ok: true,
      messages: [
        { ts: "1788391002.000200", thread_ts: "1788391000.000100", text: "Thread reply", user: "U2", edited: { ts: "1788391003.000300" } },
        { ts: "1788391001.000150", text: "**Ava**: [ALERT] Hold", user: "U1" },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const history = await fetchExternalChatHistory({ platform: "slack", token: "token", channelId: "C1" }, "1788391000.000100");

    expect(String(fetchMock.mock.calls[0][0])).toContain("oldest=1788391000.000100");
    expect(history.nextCursor).toBe("1788391002.000200");
    expect(history.messages).toEqual([
      expect.objectContaining({ externalId: "1788391001.000150", senderName: "Ava", text: "Hold", type: "alert" }),
      expect.objectContaining({ externalId: "1788391002.000200", replyToExternalId: "1788391000.000100", editedAt: 1_788_391_003_000 }),
    ]);
  });

  it("uses Discord reply references and idempotent nonces", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "discord-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await sendExternalChatMessage({ platform: "discord", token: "token", channelId: "channel" }, {
      id: "aa7189b8-2f50-4ef6-8363-4d99a7e418ce",
      senderName: "Ava",
      text: "Ready",
      type: "text",
    }, "discord-1");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      nonce: "aa7189b82f504ef683634d99a",
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
      message_reference: { type: 0, message_id: "discord-1", fail_if_not_exists: false },
    });
  });

  it("updates and deletes Slack messages through the owning bot", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const config = { platform: "slack", token: "token", channelId: "C1" } as const;

    await updateExternalChatMessage(config, "1788391000.000100", {
      id: "native-1",
      senderName: "Ava",
      text: "Updated",
      type: "text",
    });
    await updateExternalChatMessage(config, "1788391000.000100", null);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ channel: "C1", ts: "1788391000.000100", text: "**Ava**: Updated" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://slack.com/api/chat.delete");
  });
});
