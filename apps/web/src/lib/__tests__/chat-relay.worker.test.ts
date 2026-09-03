import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  await abortAllDurableObjects();
});

function nextFrame(socket: WebSocket, expectedType?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(typeof event.data === "string" ? event.data : "");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Chat relay sent a non-object frame"));
          return;
        }
        const frame = parsed as Record<string, unknown>;
        if (expectedType && frame.type !== expectedType) {
          socket.addEventListener("message", onMessage, { once: true });
          return;
        }
        resolve(frame);
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage, { once: true });
  });
}

async function openChat(orgId: string, roomId = "production", expectEmpty = true) {
  const stub = env.CHAT_RELAY.getByName(`${orgId}:${roomId}`);
  const response = await stub.fetch(new Request(
    `https://chat.test/ws?orgId=${orgId}&room=${roomId}&userId=user-1&name=Ava&role=Producer`,
    { headers: { Upgrade: "websocket" } },
  ));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Chat upgrade did not return a WebSocket");
  const hydration = nextFrame(response.webSocket);
  response.webSocket.accept();
  const hydrationFrame = await hydration;
  expect(hydrationFrame.type).toBe("hydrate");
  if (expectEmpty) expect(hydrationFrame.messages).toEqual([]);
  return { stub, socket: response.webSocket, hydration: hydrationFrame };
}

describe("ChatRelay threads", () => {
  it("keeps replies to replies in one stable thread", async () => {
    const { socket } = await openChat("thread-org");
    const rootId = "8ed6691e-8f4f-4cf1-8554-cba1876f79df";
    const replyId = "97686cd3-aae6-48e4-828a-eb76fa2c2861";
    const nestedReplyId = "37080f80-9265-481e-83de-c01470987f7b";

    const rootFrame = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Line check", clientMessageId: rootId }));
    await expect(rootFrame).resolves.toMatchObject({
      type: "message",
      message: { id: rootId, text: "Line check" },
    });

    const replyFrame = nextFrame(socket, "message");
    socket.send(JSON.stringify({
      type: "message",
      text: "Audio ready",
      clientMessageId: replyId,
      replyTo: { messageId: rootId, senderName: "spoofed", text: "spoofed" },
    }));
    await expect(replyFrame).resolves.toMatchObject({
      type: "message",
      message: {
        id: replyId,
        threadRootId: rootId,
        replyTo: { messageId: rootId, senderName: "Ava", text: "Line check" },
      },
    });

    const nestedFrame = nextFrame(socket, "message");
    socket.send(JSON.stringify({
      type: "message",
      text: "Confirmed",
      clientMessageId: nestedReplyId,
      replyTo: { messageId: replyId, senderName: "spoofed", text: "spoofed" },
    }));
    await expect(nestedFrame).resolves.toMatchObject({
      type: "message",
      message: {
        id: nestedReplyId,
        threadRootId: rootId,
        replyTo: { messageId: replyId, senderName: "Ava", text: "Audio ready" },
      },
    });
  });

  it("rejects a room mismatch on an existing object", async () => {
    const { stub } = await openChat("room-org", "production");
    const response = await stub.fetch(new Request("https://chat.test/history?orgId=room-org&room=dm:user-1:user-2"));
    expect(response.status).toBe(403);
  });

  it("maps Slack events back onto the canonical native thread without mirror duplicates", async () => {
    const { socket, stub } = await openChat("slack-thread-org");
    const rootId = "70ce093f-f0f9-4f40-abf2-6f3e5b497889";

    const rootFrame = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Stand by", clientMessageId: rootId }));
    await expect(rootFrame).resolves.toMatchObject({ type: "message", message: { id: rootId } });

    const deliveryFrame = nextFrame(socket, "message-edited");
    const rootEvent = await stub.fetch(new Request(
      "https://chat.test/external/import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "slack",
          message: {
            externalId: "1788391000.000100",
            sourceNativeId: rootId,
            senderName: "ShowPilot",
            text: "Stand by",
            type: "text",
            timestamp: 1_788_391_000_100,
          },
        }),
      },
    ));
    expect(rootEvent.status).toBe(200);
    await expect(deliveryFrame).resolves.toMatchObject({
      type: "message-edited",
      message: { id: rootId, externalDelivery: { platform: "slack", status: "sent" } },
    });

    const replyFrame = nextFrame(socket, "message");
    const replyEvent = await stub.fetch(new Request(
      "https://chat.test/external/import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "slack",
          message: {
            externalId: "1788391001.000200",
            senderId: "U2",
            senderName: "Jordan",
            text: "Ready",
            type: "text",
            timestamp: 1_788_391_001_200,
            replyToExternalId: "1788391000.000100",
          },
        }),
      },
    ));
    expect(replyEvent.status).toBe(200);
    await expect(replyFrame).resolves.toMatchObject({
      type: "message",
      message: {
        id: "external:slack:1788391001.000200",
        threadRootId: rootId,
        replyTo: { messageId: rootId, senderName: "Ava", text: "Stand by" },
      },
    });

    const duplicateEvent = await stub.fetch(new Request(
      "https://chat.test/external/import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "slack",
          message: {
            externalId: "1788391001.000200",
            senderName: "Jordan",
            text: "Ready",
            type: "text",
            timestamp: 1_788_391_001_200,
          },
        }),
      },
    ));
    expect(duplicateEvent.status).toBe(200);

    const editedFrame = nextFrame(socket, "message-edited");
    const editedEvent = await stub.fetch(new Request(
      "https://chat.test/external/import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "slack",
          message: {
            externalId: "1788391001.000200",
            senderId: "U2",
            senderName: "Jordan",
            text: "Ready now",
            type: "text",
            timestamp: 1_788_391_001_200,
            replyToExternalId: "1788391000.000100",
            editedAt: 1_788_391_005_000,
          },
        }),
      },
    ));
    expect(editedEvent.status).toBe(200);
    await expect(editedFrame).resolves.toMatchObject({
      type: "message-edited",
      message: { id: "external:slack:1788391001.000200", text: "Ready now", editedAt: 1_788_391_005_000 },
    });

    const deletedFrame = nextFrame(socket, "message-deleted");
    const deletedEvent = await stub.fetch(new Request(
      "https://chat.test/external/import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "slack",
          message: {
            externalId: "1788391001.000200",
            senderName: "Jordan",
            text: "",
            type: "text",
            timestamp: 1_788_391_001_200,
            deletedAt: 1_788_391_006_000,
          },
        }),
      },
    ));
    expect(deletedEvent.status).toBe(200);
    await expect(deletedFrame).resolves.toMatchObject({
      type: "message-deleted",
      message: { id: "external:slack:1788391001.000200", text: "", deletedAt: 1_788_391_006_000 },
    });
  });

  it("mutates loaded messages even after they leave the hydration window", async () => {
    const orgId = "long-history-org";
    const roomId = "planning";
    const oldId = "c280fc51-491b-4dda-adf4-a749e705d49a";
    const firstConnection = await openChat(orgId, roomId);
    const oldFrame = nextFrame(firstConnection.socket, "message");
    firstConnection.socket.send(JSON.stringify({
      type: "message",
      text: "Original old message",
      clientMessageId: oldId,
      poll: { question: "Ready?", options: [{ text: "Yes" }, { text: "No" }] },
    }));
    const oldMessage = (await oldFrame).message as { timestamp: number };
    firstConnection.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    for (let start = 0; start < 2_000; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) => firstConnection.stub.fetch(new Request(
        `https://chat.test/send?orgId=${orgId}&room=${roomId}&access=write`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senderId: "user-1", senderName: "Ava", text: `Filler ${start + offset}` }),
        },
      ))));
    }

    const { socket, hydration } = await openChat(orgId, roomId, false);
    const hydratedMessages = hydration.messages as Array<{ id: string }>;
    expect(hydratedMessages).toHaveLength(2_000);
    expect(hydratedMessages.some((message) => message.id === oldId)).toBe(false);

    for (const mutation of [
      { type: "reaction", requestId: "reaction-old", messageId: oldId, emoji: "👍" },
      { type: "vote", requestId: "vote-old", messageId: oldId, optionId: "placeholder" },
    ]) {
      if (mutation.type === "vote") {
        const historyResponse = await firstConnection.stub.fetch(new Request(
          `https://chat.test/history?orgId=${orgId}&room=${roomId}&limit=10&beforeTimestamp=${oldMessage.timestamp + 1}&beforeId=%EF%BF%BF`,
        ));
        const history = await historyResponse.json<{ messages: Array<{ id: string; poll?: { options: Array<{ id: string }> } }> }>();
        const stored = history.messages.find((message) => message.id === oldId);
        mutation.optionId = stored?.poll?.options[0]?.id ?? "missing";
      }
      const result = nextFrame(socket, "mutation-result");
      socket.send(JSON.stringify(mutation));
      await expect(result).resolves.toMatchObject({ type: "mutation-result", requestId: mutation.requestId, ok: true });
    }

    const editResult = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify({ type: "edit", requestId: "edit-old", messageId: oldId, text: "Updated old message" }));
    await expect(editResult).resolves.toMatchObject({ type: "mutation-result", requestId: "edit-old", ok: true });

    const historyResponse = await firstConnection.stub.fetch(new Request(
      `https://chat.test/history?orgId=${orgId}&room=${roomId}&limit=10&beforeTimestamp=${oldMessage.timestamp + 1}&beforeId=%EF%BF%BF`,
    ));
    const history = await historyResponse.json<{ messages: Array<{ id: string; text: string; poll?: { options: Array<{ voterIds: string[] }> }; reactions?: Array<{ emoji: string; userIds: string[] }> }> }>();
    const stored = history.messages.find((message) => message.id === oldId);
    expect(stored).toMatchObject({
      text: "Updated old message",
      reactions: [{ emoji: "👍", userIds: ["user-1"] }],
    });
    expect(stored?.poll?.options.some((option) => option.voterIds.includes("user-1"))).toBe(true);
  }, 30_000);
});
