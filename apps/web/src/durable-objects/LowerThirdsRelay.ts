import { DurableObject } from "cloudflare:workers";
import { memberPermissionGuard } from "@/lib/member-permission-guard.server";
import { SerialCommandExecutor } from "@/lib/serial-command-executor";
import {
  reviewedRelayClearSchema,
  type graphicsClearOutcomeSchema,
} from "@/lib/graphics-clear-contract";
import type { z } from "zod";
type ClearReceipt = {
  fingerprint: string;
  outcome: z.infer<typeof graphicsClearOutcomeSchema>;
};

import {
  renewSocketReadLease,
  socketReadLeaseAllows,
  refreshSocketReadLeases,
  scheduleSocketReadRefresh,
  socketAuthorityClaim,
} from "@/lib/socket-read-authority.server";
import { displaySocketMayReceive } from "@/lib/display-access.server";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
} from "@/lib/live-rundown-authority.server";

export type LowerThirdType = "person" | "scripture" | "freetext" | "style";
export type LowerThirdState = "idle" | "live" | "clearing";

export interface LowerThirdPayload {
  id: string;
  type: LowerThirdType;
  name?: string;
  title?: string;
  scripture?: string;
  translation?: string;
  line1?: string;
  line2?: string;
  style: string; // "default" | "minimal" | "scripture"
  state: LowerThirdState;
  triggeredBy?: string;
  triggeredAt?: number;
}

export class LowerThirdsRelay extends DurableObject<
  Pick<Env, "DB"> & { BETTER_AUTH_SECRET?: string }
> {
  private current: LowerThirdPayload | null = null;
  private queue: LowerThirdPayload | null = null;
  private hydration: Promise<void> | null = null;
  private revision = 0;
  private clearReceipts: Record<string, ClearReceipt> = {};
  private commands = new SerialCommandExecutor();

  private hydrateFromStorage(): Promise<void> {
    this.hydration ??= this.loadState();
    return this.hydration;
  }

  private async loadState(): Promise<void> {
    const stored = await this.ctx.storage.get<{
      current: LowerThirdPayload | null;
      queue: LowerThirdPayload | null;
      revision?: number;
      clearReceipts?: Record<string, ClearReceipt>;
    }>("state");

    if (stored) {
      this.current = stored.current ?? null;
      this.queue = stored.queue ?? null;
      this.revision = stored.revision ?? 0;
      this.clearReceipts = stored.clearReceipts ?? {};
    }
  }

  private async commit(
    current: LowerThirdPayload | null,
    queue = this.queue,
    receipt?: { id: string; value: ClearReceipt },
    advance = true,
  ) {
    const receipts = { ...this.clearReceipts };
    if (receipt) receipts[receipt.id] = receipt.value;
    for (const key of Object.keys(receipts).slice(
      0,
      Math.max(0, Object.keys(receipts).length - 128),
    ))
      delete receipts[key];
    const state = {
      current,
      queue,
      revision: this.revision + (advance ? 1 : 0),
      clearReceipts: receipts,
    };
    // Persist before changing memory or broadcasting. A failed write must not
    // appear cleared to either a read or an already connected display.
    await this.ctx.storage.put("state", state);
    this.current = state.current;
    this.queue = state.queue;
    this.revision = state.revision;
    this.clearReceipts = receipts;
  }

  async fetch(request: Request): Promise<Response> {
    return this.commands.run(() => this.handleFetch(request));
  }
  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (
        !this.env.BETTER_AUTH_SECRET ||
        request.headers.get("x-showpilot-internal-secret") !==
          this.env.BETTER_AUTH_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets())
        socket.close(4404, "Organization deleted");
      await this.ctx.storage.deleteAll();
      this.current = null;
      this.queue = null;
      this.revision = 0;
      this.clearReceipts = {};
      this.hydration = Promise.resolve();
      return Response.json({ ok: true });
    }
    await this.hydrateFromStorage();

    const internalCommand =
      url.pathname === "/internal/trigger" ||
      url.pathname === "/internal/clear";
    if (
      internalCommand &&
      (request.method !== "POST" ||
        !this.env.BETTER_AUTH_SECRET ||
        request.headers.get("x-showpilot-internal-secret") !==
          this.env.BETTER_AUTH_SECRET)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const authClaim = this.readAuthorityClaim(url);
    const canWrite =
      internalCommand ||
      (url.searchParams.get("access") === "write" &&
        authClaim !== null &&
        (await hasLivePermissionAuthority(
          this.env.DB,
          authClaim,
          "lowerthird:trigger",
        )));
    const path = internalCommand
      ? url.pathname.slice("/internal".length)
      : url.pathname;

    if (
      url.pathname === "/control-state" ||
      url.pathname === "/clear-reviewed"
    ) {
      if (!authClaim) return new Response("Unauthorized", { status: 401 });
      if (url.pathname === "/control-state" && request.method === "GET") {
        if (!(await this.hasControlAuthority(authClaim, "lowerthird:view")))
          return new Response("Unauthorized", { status: 401 });
        return Response.json({
          revision: this.revision,
          current: this.current,
        });
      }
      if (url.pathname === "/clear-reviewed" && request.method === "POST") {
        const parsed = reviewedRelayClearSchema.safeParse(await request.json());
        if (!parsed.success)
          return new Response("Invalid clear request", { status: 400 });
        if (
          url.searchParams.get("access") !== "write" ||
          !(await this.hasControlAuthority(authClaim, "lowerthird:trigger"))
        )
          return new Response("Unauthorized", { status: 401 });
        const command = parsed.data,
          fingerprint = JSON.stringify([
            authClaim.userId,
            command.expectedRevision,
            command.expiresAt,
          ]);
        const previous = this.clearReceipts[command.id];
        if (previous)
          return previous.fingerprint === fingerprint
            ? Response.json({ outcome: previous.outcome })
            : new Response("Request already belongs to another clear", {
                status: 409,
              });
        if (command.expiresAt > Date.now() + 5_000)
          return new Response("Clear deadline is too far ahead", {
            status: 400,
          });
        const outcome =
          command.expiresAt <= Date.now()
            ? "expired"
            : command.expectedRevision !== this.revision
              ? "conflict"
              : "applied";
        const cleared = this.current;
        await this.commit(
          outcome === "applied" ? null : this.current,
          this.queue,
          { id: command.id, value: { fingerprint, outcome } },
          outcome === "applied",
        );
        if (outcome === "applied" && cleared)
          this.broadcast(
            JSON.stringify({
              action: "clear",
              payload: { ...cleared, state: "clearing" },
            }),
          );
        return Response.json({ outcome });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/ws") {
      if (authClaim && !(await this.canRead(authClaim)))
        return new Response("Unauthorized", { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment?.({
        canWrite,
        authClaim,
        displayExpiresAt: url.searchParams.has("authDisplayExpiresAt")
          ? Number(url.searchParams.get("authDisplayExpiresAt"))
          : undefined,
      });
      if (authClaim) renewSocketReadLease(server);
      await scheduleSocketReadRefresh(
        this.ctx,
        (socket) => socketAuthorityClaim(socket) !== null,
      );

      // Hydrate late connectors
      if (this.current) {
        server.send(JSON.stringify({ action: "show", payload: this.current }));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === "/trigger" && request.method === "POST") {
      if (!canWrite) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json()) as Partial<LowerThirdPayload>;
      const payload: LowerThirdPayload = {
        id: body.id ?? crypto.randomUUID(),
        type: body.type ?? "freetext",
        name: body.name,
        title: body.title,
        scripture: body.scripture,
        translation: body.translation,
        line1: body.line1,
        line2: body.line2,
        style: body.style ?? "default",
        state: "live",
        triggeredBy: body.triggeredBy,
        triggeredAt: Date.now(),
      };

      await this.commit(payload);
      this.broadcast(JSON.stringify({ action: "show", payload }));
      return Response.json({ ok: true, payload });
    }

    if (path === "/clear" && request.method === "POST") {
      if (!canWrite) return new Response("Unauthorized", { status: 401 });
      if (this.current) {
        const cleared = this.current;
        await this.commit(null);
        this.broadcast(
          JSON.stringify({
            action: "clear",
            payload: { ...cleared, state: "clearing" },
          }),
        );
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/queue" && request.method === "POST") {
      if (!canWrite) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json()) as Partial<LowerThirdPayload>;
      const queued: LowerThirdPayload = {
        id: body.id ?? crypto.randomUUID(),
        type: body.type ?? "freetext",
        name: body.name,
        title: body.title,
        scripture: body.scripture,
        translation: body.translation,
        line1: body.line1,
        line2: body.line2,
        style: body.style ?? "default",
        state: "idle",
        triggeredBy: body.triggeredBy,
      };
      await this.commit(this.current, queued);
      return Response.json({ ok: true, queued: this.queue });
    }

    if (url.pathname === "/current") {
      return Response.json({
        current: this.current,
        queue: canWrite ? this.queue : null,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    return this.commands.run(() => this.handleWebSocketMessage(ws, data));
  }
  private async handleWebSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer,
  ) {
    await this.hydrateFromStorage();
    try {
      const attachment = ws.deserializeAttachment?.() as {
        canWrite?: boolean;
        authClaim?: LiveSessionAuthorityClaim | null;
      } | null;
      if (!attachment?.canWrite) {
        ws.close(4403, "Graphics write access required");
        return;
      }
      if (
        !attachment.authClaim ||
        !(await hasLivePermissionAuthority(
          this.env.DB,
          attachment.authClaim,
          "lowerthird:trigger",
        ))
      ) {
        ws.close(4403, "Graphics access changed");
        return;
      }
      renewSocketReadLease(ws);
      const parsed = JSON.parse(data as string) as {
        action: string;
        payload?: Partial<LowerThirdPayload>;
      };

      if (parsed.action === "trigger" && parsed.payload) {
        const payload: LowerThirdPayload = {
          id: parsed.payload.id ?? crypto.randomUUID(),
          type: parsed.payload.type ?? "freetext",
          name: parsed.payload.name,
          title: parsed.payload.title,
          scripture: parsed.payload.scripture,
          translation: parsed.payload.translation,
          line1: parsed.payload.line1,
          line2: parsed.payload.line2,
          style: parsed.payload.style ?? "default",
          state: "live",
          triggeredBy: parsed.payload.triggeredBy,
          triggeredAt: Date.now(),
        };
        await this.commit(payload);
        this.broadcast(JSON.stringify({ action: "show", payload }));
      }

      if (parsed.action === "clear") {
        if (this.current) {
          const cleared = this.current;
          await this.commit(null);
          this.broadcast(
            JSON.stringify({
              action: "clear",
              payload: { ...cleared, state: "clearing" },
            }),
          );
        }
      }
    } catch {
      try {
        ws.send(
          JSON.stringify({
            action: "error",
            message:
              "Graphics change was not confirmed. Refresh output before trying again.",
          }),
        );
      } catch {
        try {
          ws.close(1011, "Graphics feedback unavailable");
        } catch {}
      }
    }
  }

  webSocketClose() {}

  webSocketError() {}

  private async hasControlAuthority(
    claim: LiveSessionAuthorityClaim,
    required: "lowerthird:view" | "lowerthird:trigger",
  ) {
    try {
      const { guard, guardArgs } = await memberPermissionGuard(
        this.env.DB,
        claim.orgId,
        claim,
        ["dashboard:tm", required],
      );
      return !!(await this.env.DB.prepare(
        `SELECT 1 WHERE ${guard} AND EXISTS(SELECT 1 FROM organization WHERE id=? AND cloud_enabled=1)`,
      )
        .bind(...guardArgs, claim.orgId)
        .first());
    } catch {
      return false;
    }
  }

  private readAuthorityClaim(url: URL): LiveSessionAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    const orgId = url.searchParams.get("orgId")?.trim();
    return userId && sessionId && orgId ? { userId, sessionId, orgId } : null;
  }

  private broadcast(data: string) {
    // Cloudflare retains accepted sockets across Durable Object hibernation;
    // an instance Set would lose every connected display on wake.
    for (const ws of this.ctx.getWebSockets()) {
      if (!displaySocketMayReceive(ws)) continue;
      if (!socketReadLeaseAllows(ws, socketAuthorityClaim(ws) !== null))
        continue;
      try {
        ws.send(data);
      } catch {
        try {
          ws.close(1011, "Broadcast failed");
        } catch {}
      }
    }
  }

  private canRead(claim: LiveSessionAuthorityClaim): Promise<boolean> {
    return hasLivePermissionAuthority(this.env.DB, claim, [
      "lowerthird:view",
      "lowerthird:trigger",
    ]);
  }

  async refreshReadAuthority(userId?: string): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async (socket) => {
      const claim = socketAuthorityClaim(socket);
      if (!claim || (userId && claim.userId !== userId)) return null;
      return this.canRead(claim);
    });
    await scheduleSocketReadRefresh(
      this.ctx,
      (socket) => socketAuthorityClaim(socket) !== null,
    );
  }

  async alarm(): Promise<void> {
    await this.refreshReadAuthority();
  }
}
