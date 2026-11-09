import { chatMutationResultSchema, type ChatMutationOperation } from "@showpilot/shared/chat-mutation";
import { seedRelayMember } from "@/test/relay-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(async () => {
  vi.restoreAllMocks();
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

async function openChat(orgId: string, roomId = "production", expectEmpty = true, userId = "user-1") {
  const authority = await seedRelayMember(orgId, userId);
  const url = (path: string) => {
    const url = new URL(`https://chat.test${path}`);
    url.search = new URLSearchParams({ orgId, room: roomId, userId, name: "Ava", role: "Producer", access: "write", authUserId: authority.userId, authSessionId: authority.sessionId }).toString();
    return url;
  };
  const stub = env.CHAT_RELAY.getByName(`${orgId}:${roomId}`);
  const response = await stub.fetch(new Request(
    url("/ws"),
    { headers: { Upgrade: "websocket" } },
  ));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Chat upgrade did not return a WebSocket");
  const hydration = nextFrame(response.webSocket);
  response.webSocket.accept();
  const hydrationFrame = await hydration;
  expect(hydrationFrame.type).toBe("hydrate");
  if (expectEmpty) expect(hydrationFrame.messages).toEqual([]);
  return { stub, socket: response.webSocket, hydration: hydrationFrame, url };
}

function makeMutationFrame(orgId: string, messageId: string, operation: ChatMutationOperation, roomId = "production") {
  return { type: "mutation", command: { orgId, userId: "user-1", roomId, messageId, requestId: crypto.randomUUID(), expiresAt: Date.now() + 10000, operation } };
}

describe("ChatRelay threads", () => {
  it("recovers the original reaction acknowledgement without toggling it off", async () => {
    const orgId = "reaction-receipt-org";
    const { stub, socket, url } = await openChat(orgId);
    const messageId = crypto.randomUUID();
    const sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Ready", clientMessageId: messageId }));
    await sent;
    const command = { orgId, userId: "user-1", roomId: "production", requestId: crypto.randomUUID(), messageId, expiresAt: Date.now() + 10000, operation: { kind: "reaction", emoji: "👍", active: true } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = nextFrame(socket, "mutation-result");
      socket.send(JSON.stringify({ type: "mutation", command }));
      await expect(result).resolves.toMatchObject({ result: { outcome: "applied", command } });
    }
    const response = await stub.fetch(url("/history"));
    const history = await response.json<{ messages: Array<{ id: string; reactions?: unknown }> }>();
    expect(history.messages.find(message => message.id === messageId)?.reactions).toEqual([{ emoji: "👍", userIds: ["user-1"] }]);
    socket.close();
  });

  it("does not replay an acknowledged edit over a later edit", async () => {
    const orgId = "edit-receipt-org";
    const { stub, socket, url } = await openChat(orgId);
    const messageId = crypto.randomUUID();
    const sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const first = { orgId, userId: "user-1", roomId: "production", requestId: crypto.randomUUID(), messageId, expiresAt: Date.now() + 10000, operation: { kind: "edit", text: "First edit", expectedEditTime: original.timestamp } };
    const applied = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify({ type: "mutation", command: first }));
    const receipt = (await applied).result as { at: number };
    const later = { ...first, requestId: crypto.randomUUID(), operation: { kind: "edit", text: "Later edit", expectedEditTime: receipt.at } };
    for (const command of [later, first]) {
      const result = nextFrame(socket, "mutation-result");
      socket.send(JSON.stringify({ type: "mutation", command }));
      await expect(result).resolves.toMatchObject({ result: { outcome: command === first ? "superseded" : "applied", command } });
    }
    const response = await stub.fetch(url("/history"));
    const history = await response.json<{ messages: Array<{ id: string; text: string }> }>();
    expect(history.messages.find(message => message.id === messageId)?.text).toBe("Later edit");
    socket.close();
  });

  it("recovers a completed delete instead of reporting it as a failed deletion", async () => {
    const orgId = "delete-receipt-org";
    const { socket } = await openChat(orgId);
    const messageId = crypto.randomUUID();
    const sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Remove me", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const command = { orgId, userId: "user-1", roomId: "production", requestId: crypto.randomUUID(), messageId, expiresAt: Date.now() + 10000, operation: { kind: "delete", expectedEditTime: original.timestamp } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = nextFrame(socket, "mutation-result");
      socket.send(JSON.stringify({ type: "mutation", command }));
      await expect(result).resolves.toMatchObject({ result: { outcome: "applied", command } });
    }
    socket.close();
  });

  it.each(["edit", "delete"] as const)("rejects a stale %s without overwriting a newer edit", async kind => {
    const orgId = `stale-${kind}-org`, { socket, stub, url } = await openChat(orgId);
    const messageId = crypto.randomUUID();
    const sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const updated = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify(makeMutationFrame(orgId, messageId, { kind: "edit", text: "Newer", expectedEditTime: original.timestamp })));
    await expect(updated).resolves.toMatchObject({ result: { outcome: "applied" } });
    const stale = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify(makeMutationFrame(orgId, messageId, kind === "edit"
      ? { kind, text: "Old draft", expectedEditTime: original.timestamp } : { kind, expectedEditTime: original.timestamp })));
    await expect(stale).resolves.toMatchObject({ result: { outcome: "conflict" } });
    expect(await (await stub.fetch(url("/history"))).json()).toMatchObject({ messages: [{ id: messageId, text: "Newer" }] });
    socket.close();
  });

  it("persists expired first deliveries and rejects altered retries", async () => {
    const orgId = "expired-mutation-org", { socket, stub, url } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId })); await sent;
    const frame = makeMutationFrame(orgId, messageId, { kind: "reaction", emoji: "👍", active: true });
    frame.command.expiresAt = Date.now() - 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame));
      await expect(result).resolves.toMatchObject({ result: { outcome: "expired" } });
    }
    const altered = nextFrame(socket, "mutation-error");
    socket.send(JSON.stringify({ ...frame, command: { ...frame.command, expiresAt: Date.now() + 10000 } }));
    await expect(altered).resolves.toMatchObject({ error: expect.stringContaining("altered") });
    expect(await (await stub.fetch(url("/history"))).json()).toMatchObject({ messages: [{ id: messageId, text: "Original" }] });
    socket.close();
  });

  it.each(["orgId", "roomId", "userId"] as const)("rejects a mutation from another %s before storing a receipt", async field => {
    const orgId = `scope-${field}-org`, { socket, stub } = await openChat(orgId);
    const frame = makeMutationFrame(orgId, crypto.randomUUID(), { kind: "reaction", emoji: "👍", active: true });
    frame.command[field] = "another";
    const result = nextFrame(socket, "mutation-error"); socket.send(JSON.stringify(frame));
    await expect(result).resolves.toMatchObject({ type: "mutation-error" });
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM chat_mutation_receipts").toArray())).toEqual([]);
    socket.close();
  });

  it("recovers receipts after object eviction without undoing a later poll choice", async () => {
    const orgId = "evicted-vote-org", { socket, stub, url } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Vote", clientMessageId: messageId, poll: { question: "Ready?", options: [{ text: "Yes" }, { text: "No" }] } }));
    const message = (await sent).message as { poll: { options: Array<{ id: string }> } };
    const [first, second] = message.poll.options;
    const frame = makeMutationFrame(orgId, messageId, { kind: "vote", optionId: first.id, expectedOptionId: null });
    for (const change of [frame, makeMutationFrame(orgId, messageId, { kind: "vote", optionId: second.id, expectedOptionId: first.id })]) {
      const result = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(change));
      await expect(result).resolves.toMatchObject({ result: { outcome: "applied" } });
    }
    socket.close(); await evictDurableObject(stub);
    const reopened = await openChat(orgId, "production", false);
    const recovered = nextFrame(reopened.socket, "mutation-result"); reopened.socket.send(JSON.stringify(frame));
    await expect(recovered).resolves.toMatchObject({ result: { outcome: "superseded" } });
    expect(await (await stub.fetch(url("/history"))).json()).toMatchObject({ messages: [{ poll: { options: [{ id: first.id, voterIds: [] }, { id: second.id, voterIds: ["user-1"] }] } }] });
    reopened.socket.close();
  });

  it("checks current membership before revealing a saved receipt", async () => {
    const orgId = "revoked-mutation-org", { socket } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId })); await sent;
    const frame = makeMutationFrame(orgId, messageId, { kind: "reaction", emoji: "👍", active: true });
    const result = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame)); await result;
    await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(orgId, "user-1").run();
    const received: unknown[] = [];
    socket.addEventListener("message", event => received.push(JSON.parse(String(event.data))));
    const closed = new Promise<number>(resolve => socket.addEventListener("close", event => resolve(event.code), { once: true }));
    socket.send(JSON.stringify(frame));
    expect(await closed).toBe(4403); expect(received).toEqual([]);
  });

  it("preserves other members' reactions and rejects edits by a non-owner", async () => {
    const orgId = "independent-reactions-org", first = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(first.socket, "message");
    first.socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const second = await openChat(orgId, "production", false, "user-2");
    for (const [socket, userId] of [[first.socket, "user-1"], [second.socket, "user-2"]] as const) {
      const frame = makeMutationFrame(orgId, messageId, { kind: "reaction", emoji: "👍", active: true }); frame.command.userId = userId;
      const result = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame)); await result;
    }
    const forged = makeMutationFrame(orgId, messageId, { kind: "edit", text: "Forged", expectedEditTime: original.timestamp }); forged.command.userId = "user-2";
    const denied = nextFrame(second.socket, "mutation-result"); second.socket.send(JSON.stringify(forged));
    await expect(denied).resolves.toMatchObject({ result: { outcome: "not-owner" } });
    expect(await (await first.stub.fetch(first.url("/history"))).json()).toMatchObject({ messages: [{ text: "Original", reactions: [{ emoji: "👍", userIds: ["user-1", "user-2"] }] }] });
    first.socket.close(); second.socket.close();
  });

  it("rejects legacy blind mutations with an actionable update message", async () => {
    const { socket } = await openChat("legacy-mutation-org");
    for (const type of ["edit", "delete", "reaction", "vote"]) {
      const result = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify({ type, requestId: "old-client", messageId: "missing" }));
      await expect(result).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Update ShowPilot") });
    }
    socket.close();
  });

  it("removes private edit receipts when an account is deleted", async () => {
    const orgId = "receipt-erasure-org", { socket, stub } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const edited = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify(makeMutationFrame(orgId, messageId, { kind: "edit", text: "Private edited content", expectedEditTime: original.timestamp })));
    expect(chatMutationResultSchema.parse((await edited).result).outcome).toBe("applied");
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT result FROM chat_mutation_receipts").toArray())).toHaveLength(1);
    const response = await stub.fetch(new Request("https://chat.test/internal/delete-user-data", { method: "POST",
      headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET }, body: JSON.stringify({ userId: "user-1" }) }));
    expect(response.status).toBe(200);
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM chat_mutation_receipts").toArray())).toEqual([]);
    socket.close();
  });

  it("erases saved edit drafts when chat history is cleared", async () => {
    const orgId = "clear-edit-receipt-org", { socket, stub } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const frame = makeMutationFrame(orgId, messageId, { kind: "edit", text: "Private old draft", expectedEditTime: original.timestamp });
    const edited = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame)); await edited;
    const requestId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO chat_history_clear_receipt(orgId,actorId,requestId,confirmName,claimId,cutoff,rooms) VALUES(?,?,?,?,?,?,?)")
      .bind(orgId, "user-1", requestId, orgId, crypto.randomUUID(), Date.now(), JSON.stringify(["production"])).run();
    expect(await stub.clearHistory({ orgId, roomId: "production", requestId, confirmName: orgId, deadline: Date.now() + 10000,
      authority: { orgId, userId: "user-1", sessionId: "user-1-session" } })).toEqual({ cleared: true });
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM chat_mutation_receipts").toArray())).toEqual([]);
    const replay = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame));
    await expect(replay).resolves.toMatchObject({ result: { outcome: "not-found" } });
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.sql.exec("SELECT * FROM chat_mutation_receipts").toArray())).toEqual([]);
    socket.close();
  });

  it("counts incoming unread messages and clears them after a read receipt", async () => {
    const { stub, socket } = await openChat("unread-count-org");
    const mine = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "My own message", clientMessageId: crypto.randomUUID() }));
    await mine;
    const incoming = nextFrame(socket, "message");
    const sender = await seedRelayMember("unread-count-org", "user-2");
    await stub.fetch(new Request(`https://chat.test/send?orgId=unread-count-org&access=write&userId=user-2&name=Sam&authUserId=${sender.userId}&authSessionId=${sender.sessionId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: "user-2", senderName: "Sam", text: "Incoming group message" }),
    }));
    await incoming;
    const count = () => stub.fetch("https://chat.test/unread?orgId=unread-count-org&userId=user-1").then((response) => response.json());
    expect(await count()).toEqual({ unread: 1 });
    const receipt = nextFrame(socket, "read-receipt");
    socket.send(JSON.stringify({ type: "read", readAt: Date.now() }));
    await receipt;
    expect(await count()).toEqual({ unread: 0 });
    expect((await stub.fetch("https://chat.test/unread?orgId=unread-count-org")).status).toBe(401);
    socket.close();
  });

  it("accepts only server-owned attachments uploaded by the sending member", async () => {
    const orgId = "attachment-owner-org";
    const fileId = "file-owned-by-user-2";
    const fileName = "stage.png";
    const key = `orgs/${orgId}/chat/${fileId}/${fileName}`;
    const url = `/api/chat-file/${orgId}/${fileId}/${fileName}`;
    await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { uploadedBy: "user-2", roomId: "production" },
    });

    const { stub, socket } = await openChat(orgId);
    const received = nextFrame(socket, "message");
    socket.send(JSON.stringify({
      type: "message",
      text: "Forged attachment reference",
      clientMessageId: crypto.randomUUID(),
      attachments: [{ id: fileId, name: fileName, url, mimeType: "image/png", size: 3 }],
    }));
    const forgedFrame = await received;
    expect(forgedFrame.message).not.toHaveProperty("attachments");

    const cleanup = await stub.fetch(new Request("https://chat.test/internal/delete-user-data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": "worker-test-secret-for-local-integration-only" },
      body: JSON.stringify({ userId: "user-1" }),
    }));
    await expect(cleanup.json()).resolves.toMatchObject({ filesDeleted: 0 });
    expect(await env.STORAGE.head(key)).not.toBeNull();
    socket.close();
  });

  it("deletes an owned attachment only after its final live message reference is removed", async () => {
    const orgId = "attachment-reference-org";
    const fileId = "shared-file";
    const fileName = "notes.txt";
    const key = `orgs/${orgId}/chat/${fileId}/${fileName}`;
    const url = `/api/chat-file/${orgId}/${fileId}/${fileName}`;
    await env.STORAGE.put(key, "line check", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { uploadedBy: "user-1", roomId: "production" },
    });
    const { stub, socket, url: roomUrl } = await openChat(orgId);
    const messageIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const messageId of messageIds) {
      const received = nextFrame(socket, "message");
      socket.send(JSON.stringify({
        type: "message",
        text: "Attached notes",
        clientMessageId: messageId,
        attachments: [{ id: "client-value-is-not-authority", name: "fake.txt", url, mimeType: "text/csv", size: 99 }],
      }));
      await expect(received).resolves.toMatchObject({
        message: { attachments: [{ id: fileId, name: fileName, url, mimeType: "text/plain", size: 10 }] },
      });
    }

    for (const [index, messageId] of messageIds.entries()) {
      const result = nextFrame(socket, "mutation-result");
      const history = await (await stub.fetch(roomUrl("/history"))).json<{ messages: Array<{ id: string; timestamp: number }> }>();
      const original = history.messages.find(message => message.id === messageId);
      if (!original) throw new Error("Missing stored attachment message");
      socket.send(JSON.stringify(makeMutationFrame(orgId, messageId, { kind: "delete", expectedEditTime: original.timestamp })));
      await expect(result).resolves.toMatchObject({ result: { outcome: "applied", cleanup: "complete" } });
      expect(Boolean(await env.STORAGE.head(key))).toBe(index === 0);
    }
    socket.close();
  });

  it("commits deletion before failed object cleanup and retries only cleanup", async () => {
    const orgId = "failed-cleanup-org", key = `orgs/${orgId}/chat/cleanup-file/notes.txt`;
    const attachment = { id: "cleanup-file", name: "notes.txt", url: `/api/chat-file/${orgId}/cleanup-file/notes.txt`, mimeType: "text/plain", size: 5 };
    await env.STORAGE.put(key, "notes", { customMetadata: { uploadedBy: "user-1", roomId: "production" } });
    const { socket, stub, url } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Notes", clientMessageId: messageId, attachments: [attachment] }));
    const original = (await sent).message as { timestamp: number };
    const remove = vi.spyOn(Object.getPrototypeOf(env.STORAGE), "delete").mockRejectedValueOnce(new Error("R2 unavailable"));
    const frame = makeMutationFrame(orgId, messageId, { kind: "delete", expectedEditTime: original.timestamp });
    const failed = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame));
    const first = chatMutationResultSchema.parse((await failed).result);
    expect(first).toMatchObject({ outcome: "applied", cleanup: "failed" });
    expect(remove).toHaveBeenCalledWith(key);
    expect(await (await stub.fetch(url("/history"))).json()).toMatchObject({ messages: [{ id: messageId, deletedAt: first.at, text: "" }] });
    expect(await env.STORAGE.head(key)).not.toBeNull();
    const blocked = nextFrame(socket, "error");
    socket.send(JSON.stringify({ type: "message", text: "Reuse pending deletion", clientMessageId: crypto.randomUUID(), attachments: [attachment] }));
    await expect(blocked).resolves.toMatchObject({ error: expect.stringContaining("attached file was deleted") });
    remove.mockRestore();
    const recovered = nextFrame(socket, "mutation-result"); socket.send(JSON.stringify(frame));
    expect(chatMutationResultSchema.parse((await recovered).result)).toMatchObject({ outcome: "applied", cleanup: "complete", at: first.at });
    expect(await env.STORAGE.head(key)).toBeNull();
    socket.close();
  });

  it("rejects attachment validation that finishes after deletion reserved the file", async () => {
    const orgId = "attachment-validation-race-org", key = `orgs/${orgId}/chat/race-file/notes.txt`;
    const attachment = { id: "race-file", name: "notes.txt", url: `/api/chat-file/${orgId}/race-file/notes.txt`, mimeType: "text/plain", size: 5 };
    await env.STORAGE.put(key, "notes", { customMetadata: { uploadedBy: "user-1", roomId: "production" } });
    const { socket, stub, url } = await openChat(orgId);
    const messageId = crypto.randomUUID(), sent = nextFrame(socket, "message");
    socket.send(JSON.stringify({ type: "message", text: "Notes", clientMessageId: messageId, attachments: [attachment] }));
    const original = (await sent).message as { timestamp: number };
    const newMessageId = crypto.randomUUID(), rejected = nextFrame(socket, "error");
    const deleted = nextFrame(socket, "mutation-result");
    await runInDurableObject(stub, async (instance, ctx) => {
      const cachedObject = await env.STORAGE.head(key);
      let release: () => void = () => { throw new Error("Validation was not held"); };
      let started: () => void = () => {};
      const waiting = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<R2Object | null>(resolve => { release = () => resolve(cachedObject); });
      const head = vi.spyOn(Object.getPrototypeOf(env.STORAGE), "head").mockImplementationOnce(() => { started(); return held; });
      const serverSocket = ctx.getWebSockets()[0];
      const sending = instance.webSocketMessage(serverSocket, JSON.stringify({ type: "message", text: "Delayed attachment", clientMessageId: newMessageId, attachments: [attachment] }));
      try {
        await waiting;
        await instance.webSocketMessage(serverSocket, JSON.stringify(makeMutationFrame(orgId, messageId, { kind: "delete", expectedEditTime: original.timestamp })));
      } finally { release(); await sending; head.mockRestore(); }
    });
    await expect(deleted).resolves.toMatchObject({ result: { outcome: "applied", cleanup: "complete" } });
    await expect(rejected).resolves.toMatchObject({ messageId: newMessageId, error: expect.stringContaining("attached file was deleted") });
    const history = await (await stub.fetch(url("/history"))).json<{ messages: Array<{ id: string }> }>();
    expect(history.messages.map(message => message.id)).not.toContain(newMessageId);
    socket.close();
  });

  it("does not assign member ownership to a guest even if the internal URL contains a user ID", async () => {
    const member = await openChat("guest-ownership-org");
    const messageId = crypto.randomUUID();
    const sent = nextFrame(member.socket, "message");
    member.socket.send(JSON.stringify({ type: "message", text: "Member original", clientMessageId: messageId }));
    const original = (await sent).message as { timestamp: number };
    const response = await member.stub.fetch(new Request(`https://chat.test/internal/guest-ws?orgId=guest-ownership-org&room=production&userId=user-1&name=Guest&role=Guest&guestTokenHash=sha256:${"a".repeat(64)}&guestExpiresAt=${Date.now() + 60000}`, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } }));
    if (!response.webSocket) throw new Error("Missing guest socket");
    const guest = response.webSocket;
    const hydration = nextFrame(guest, "hydrate"); guest.accept(); await hydration;
    const denied = nextFrame(guest, "mutation-error");
    guest.send(JSON.stringify(makeMutationFrame("guest-ownership-org", messageId, { kind: "edit", text: "Forged edit", expectedEditTime: original.timestamp })));
    await expect(denied).resolves.toMatchObject({ type: "mutation-error" });
    const allowed = nextFrame(member.socket, "mutation-result");
    member.socket.send(JSON.stringify(makeMutationFrame("guest-ownership-org", messageId, { kind: "edit", text: "Member updated", expectedEditTime: original.timestamp })));
    await expect(allowed).resolves.toMatchObject({ result: { outcome: "applied" } });
    guest.close(); member.socket.close();
  });

  it("rejects a guest connection without a current expiry", async () => {
    const stub = env.CHAT_RELAY.getByName("expired-guest-org:production");
    for (const expiry of ["", "NaN", "0", String(Date.now() - 1)]) {
      const response = await stub.fetch(new Request(`https://chat.test/internal/guest-ws?orgId=expired-guest-org&role=Guest&guestTokenHash=sha256:${"a".repeat(64)}&guestExpiresAt=${expiry}`, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } }));
      expect(response.status).toBe(401);
    }
  });

  it("closes an idle expired guest without closing the member connection", async () => {
    const member = await openChat("guest-expiry-org");
    const expiresAt = Date.now() + 60_000;
    const response = await member.stub.fetch(new Request(`https://chat.test/internal/guest-ws?orgId=guest-expiry-org&role=Guest&guestTokenHash=sha256:${"a".repeat(64)}&guestExpiresAt=${expiresAt}`, { headers: { Upgrade: "websocket", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET } }));
    if (!response.webSocket) throw new Error("Missing guest socket");
    const guest = response.webSocket;
    const closed = new Promise<number>(resolve => guest.addEventListener("close", event => resolve(event.code), { once: true }));
    const hydration = nextFrame(guest, "hydrate"); guest.accept(); await hydration;
    // Admit a valid guest first. A 150ms admission window races CI load and
    // tests rejection instead of idle expiry. Expire its persisted lease,
    // then evict so the real alarm must restore and reject that lease.
    await runInDurableObject(member.stub, async (_instance, ctx) => {
      let expired = 0;
      for (const socket of ctx.getWebSockets()) {
        const session = socket.deserializeAttachment();
        if (session?.kind !== "guest") continue;
        socket.serializeAttachment({ ...session, expiresAt: Date.now() - 1 });
        expired++;
      }
      expect(expired).toBe(1);
    });
    await evictDurableObject(member.stub);
    await runDurableObjectAlarm(member.stub);
    await expect(closed).resolves.toBe(1008);
    const memberMessage = nextFrame(member.socket, "message");
    member.socket.send(JSON.stringify({ type: "message", text: "Member remains connected" }));
    await expect(memberMessage).resolves.toMatchObject({ message: { text: "Member remains connected" } });
    member.socket.close();
  });

  it("hydrates read progress in shared rooms so clients can resume at the first missed message", async () => {
    const firstConnection = await openChat("shared-read-org", "production");
    const receiptFrame = nextFrame(firstConnection.socket, "read-receipt");
    firstConnection.socket.send(JSON.stringify({ type: "read", readAt: 1_788_390_000_000 }));
    await expect(receiptFrame).resolves.toMatchObject({
      type: "read-receipt",
      userId: "user-1",
      readAt: 1_788_390_000_000,
    });

    const reopened = await openChat("shared-read-org", "production");
    expect(reopened.hydration.readReceipts).toEqual({ "user-1": 1_788_390_000_000 });
  });

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
      "https://chat.test/internal/external-import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
      "https://chat.test/internal/external-import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
      "https://chat.test/internal/external-import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
      "https://chat.test/internal/external-import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
      "https://chat.test/internal/external-import?orgId=slack-thread-org&room=production&access=external",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
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
        firstConnection.url("/send"),
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
      makeMutationFrame(orgId, oldId, { kind: "reaction", emoji: "👍", active: true }, roomId),
      makeMutationFrame(orgId, oldId, { kind: "vote", optionId: "placeholder", expectedOptionId: null }, roomId),
    ]) {
      if (mutation.command.operation.kind === "vote") {
        const historyResponse = await firstConnection.stub.fetch(new Request(
          `https://chat.test/history?orgId=${orgId}&room=${roomId}&limit=10&beforeTimestamp=${oldMessage.timestamp + 1}&beforeId=%EF%BF%BF`,
        ));
        const history = await historyResponse.json<{ messages: Array<{ id: string; poll?: { options: Array<{ id: string }> } }> }>();
        const stored = history.messages.find((message) => message.id === oldId);
        mutation.command.operation.optionId = stored?.poll?.options[0]?.id ?? "missing";
      }
      const result = nextFrame(socket, "mutation-result");
      socket.send(JSON.stringify(mutation));
      await expect(result).resolves.toMatchObject({ type: "mutation-result", result: { command: mutation.command, outcome: "applied" } });
    }

    const editResult = nextFrame(socket, "mutation-result");
    socket.send(JSON.stringify(makeMutationFrame(orgId, oldId, { kind: "edit", text: "Updated old message", expectedEditTime: oldMessage.timestamp }, roomId)));
    await expect(editResult).resolves.toMatchObject({ type: "mutation-result", result: { outcome: "applied" } });

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
