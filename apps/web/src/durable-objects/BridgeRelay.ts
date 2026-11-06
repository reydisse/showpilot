import { proPresenterViewerMessage } from "@/lib/propresenter-viewer-message";
import { TIMECODE_FEED_STALL_MS } from "@/types/timecode";
import { readProPresenterSettings, proPresenterConnection } from "@/lib/propresenter-settings.server";
import { redactCredentialText } from "@/lib/credential-fields";
import { importBridgeSettingsKey, sealBridgeSettings, MAX_BRIDGE_SETTINGS_BYTES, type ProtectedBridgeSettings } from "@showpilot/shared/bridge-settings";
import { assertLocalShowAuthority, buildLocalShowPreparation, localShowPreparationInput, type LocalShowPreparationInput } from "@/lib/local-show-preparation.server";
import { approveBridgeTarget, removeBridgeTarget, listBridgeTargets, authorizeBridgeTarget, type BridgeTargetActor } from "@/lib/bridge-targets.server";
import { BridgeTargetError, type BridgeEndpoint } from "@showpilot/shared/bridge-target";
import { SerialCommandExecutor } from "@/lib/serial-command-executor";
import { renewSocketReadLease, socketReadLeaseAllows, refreshSocketReadLeases, scheduleSocketReadRefresh } from "@/lib/socket-read-authority.server";
import { rundownInternalRequest } from "@/lib/rundown-internal-request.server";
import { getBridgeCredentialAuthority, recordBridgeWrite, type BridgeAuditAction } from "@/lib/bridge-credentials.server";
import { parseRelayPPSlide } from "../lib/rundown-relay-payload";
import { DurableObject } from "cloudflare:workers";
import { getActiveRundownRelayTarget } from "@/lib/active-rundown-relay";
import { resolveTimecodeTarget, timecodeRelayKey, timecodeTargetUrl, type TimecodeTarget } from "@/lib/timecode-target.server";
import type { BridgeDeviceProtocol } from "@/lib/device-modules/types";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
  type LiveRundownAuthorityClaim,
} from "@/lib/live-rundown-authority.server";

/**
 * BridgeRelay — mediates between browser clients and the ShowPilot Bridge agent.
 *
 * Two types of WebSocket connections:
 * - Named Bridge installations (one selected active, others standby)
 * - Browser clients (multiple, connect with role=client)
 *
 * Flow: Browser sends command → DO forwards to bridge → bridge executes → response flows back
 */

interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export type BridgeDispatchMessage =
  | {
      type: "command";
      id: string;
      protocol: BridgeDeviceProtocol;
      target: string;
      command: string;
    }
  | {
      type: "connect-device";
      protocol: BridgeDeviceProtocol;
      target: string;
      settings: Record<string, unknown>;
    }
  | {
      type: "disconnect-device";
      target: string;
    };

type NativeDispatchMessage = Exclude<BridgeDispatchMessage, { type: "connect-device" }> | {
  type: "connect-device";
  protocol: string;
  target: string;
  protectedSettings: ProtectedBridgeSettings;
};

type BridgeRelayEnv = Pick<Env, "RUNDOWN_RELAY" | "TIMECODE_RELAY" | "DB">;
type BridgeRelayRuntimeEnv = BridgeRelayEnv & { BETTER_AUTH_SECRET?: string; CREDENTIAL_ENCRYPTION_KEYS?: string };

interface SocketAttachment {
  role: "bridge" | "client" | "propresenter-viewer";
  orgId: string;
  bridgeInfo?: BridgeRelayStatusInfo;
  credentialId?: string;
  installationId?: string;
  installationLabel?: string;
  targetPolicyVersion?: 3;
  settingsPublicKey?: string;
  timecodeTarget?: TimecodeTarget;
  authClaim?: LiveSessionAuthorityClaim;
}

export interface BridgeDeviceEventSnapshot {
  eventName: string;
  data: string;
  receivedAt: number;
}

interface BridgeRelayStatusInfo {
  version?: string;
  devices?: number;
  uptime?: number;
  connectedTargets: string[];
  deviceEvents?: Record<string, BridgeDeviceEventSnapshot>;
}

export interface BridgeSelection {
  installationId: string;
  label: string;
}

export interface BridgeConnectionStatus extends BridgeSelection {
  role: "active" | "standby";
}

export interface BridgeRelayStatus extends BridgeRelayStatusInfo {
  activeInstallation: BridgeSelection | null;
  connections: BridgeConnectionStatus[];
  timecodeTarget: TimecodeTarget | null;
  bridgeOnline: boolean;
  clientCount: number;
}

interface PendingDispatch {
  resolve: (result: BridgeDispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
  connection?: CommandConnection;
}

interface PendingClientCommand {
  socket: WebSocket;
  clientId: string;
  timer: ReturnType<typeof setTimeout>;
  connection?: CommandConnection;
}

interface CommandConnection {
  target: string;
  protocol: "tcp-command" | "osc" | "udp" | "http-command" | "wol";
  actor: BridgeTargetActor;
  requested: boolean;
}

function commandConnection(message: { type: string; [key: string]: unknown }, actor: BridgeTargetActor): CommandConnection | undefined {
  if (message.type !== "command" || typeof message.target !== "string"
    || (message.protocol !== "tcp-command" && message.protocol !== "osc" && message.protocol !== "udp"
      && message.protocol !== "http-command" && message.protocol !== "wol")) return;
  return { target: message.target, protocol: message.protocol, actor, requested: false };
}

export interface BridgeDispatchResult {
  success: boolean;
  response?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBridgeInfo(value: unknown): BridgeRelayStatusInfo | null {
  if (!isRecord(value) || !Array.isArray(value.connectedTargets)) return null;
  const connectedTargets = value.connectedTargets.filter((target): target is string => typeof target === "string");
  const deviceEvents: Record<string, BridgeDeviceEventSnapshot> = {};
  if (isRecord(value.deviceEvents)) {
    for (const [target, event] of Object.entries(value.deviceEvents)) {
      if (
        isRecord(event)
        && typeof event.eventName === "string"
        && typeof event.data === "string"
        && typeof event.receivedAt === "number"
      ) {
        deviceEvents[target] = {
          eventName: event.eventName,
          data: redactCredentialText(event.data),
          receivedAt: event.receivedAt,
        };
      }
    }
  }
  return {
    version: typeof value.version === "string" ? value.version : undefined,
    devices: typeof value.devices === "number" ? value.devices : undefined,
    uptime: typeof value.uptime === "number" ? value.uptime : undefined,
    connectedTargets,
    deviceEvents,
  };
}

function parseSocketAttachment(value: unknown): SocketAttachment | null {
  if (!isRecord(value) || (value.role !== "bridge" && value.role !== "client" && value.role !== "propresenter-viewer") || typeof value.orgId !== "string") {
    return null;
  }
  const bridgeInfo = value.bridgeInfo === undefined ? undefined : parseBridgeInfo(value.bridgeInfo);
  if (value.bridgeInfo !== undefined && !bridgeInfo) return null;
  return {
    role: value.role,
    orgId: value.orgId,
    bridgeInfo: bridgeInfo ?? undefined,
    installationId: typeof value.installationId === "string" ? value.installationId : undefined,
    installationLabel: typeof value.installationLabel === "string" ? value.installationLabel : undefined,
    targetPolicyVersion: value.targetPolicyVersion === 3 ? 3 : undefined,
    settingsPublicKey: typeof value.settingsPublicKey === "string" ? value.settingsPublicKey : undefined,
    credentialId: typeof value.credentialId === "string" ? value.credentialId : undefined,
    timecodeTarget: isRecord(value.timecodeTarget)
      && value.timecodeTarget.orgId === value.orgId
      && typeof value.timecodeTarget.showId === "string"
      && typeof value.timecodeTarget.serviceDate === "string"
      ? { orgId: value.orgId, showId: value.timecodeTarget.showId, serviceDate: value.timecodeTarget.serviceDate } : undefined,
    authClaim: isRecord(value.authClaim)
      && typeof value.authClaim.userId === "string"
      && typeof value.authClaim.sessionId === "string"
      && typeof value.authClaim.orgId === "string"
      ? {
          userId: value.authClaim.userId,
          sessionId: value.authClaim.sessionId,
          orgId: value.authClaim.orgId,
        }
      : undefined,
  };
}

function bridgeAuditAction(type: string): BridgeAuditAction | null {
  switch (type) {
    case "configured-propresenter-requested": case "automatic-connection-requested": case "command-connection-requested": return "connect-device";
    case "bridge-status": case "command-response": case "device-event":
    case "device-status": case "pong": case "timecode-feed": case "timecode-transport": return type;
    case "local-show-prepared": return type;
    default: return null;
  }
}

export class BridgeRelay extends DurableObject<BridgeRelayRuntimeEnv> {
  private bridgeWs: WebSocket | null = null;
  private readonly ownership = new SerialCommandExecutor();
  private activeInstallation: BridgeSelection | null = null;
  private pendingDemotion: { socket: WebSocket; id: string; resolve: () => void; reject: (error: Error) => void } | null = null;
  private pendingPolicy: { socket: WebSocket; id: string; resolve: () => void } | null = null;
  private readonly bridges = new Map<WebSocket, BridgeSelection & { credentialId: string }>();
  private previewWrite: Promise<void> = Promise.resolve();
  private clientSessions: Set<WebSocket> = new Set();
  private bridgeOnline = false;
  private bridgeInfo: BridgeRelayStatusInfo = { connectedTargets: [], deviceEvents: {} };
  private credentialId: string | null = null;
  private orgId = "";
  private pendingCommands = new Map<string, PendingDispatch>();
  private pendingConnections = new Map<string, PendingDispatch>();
  private pendingLocalPreparations = new Map<
    string,
    {
      socket: WebSocket;
      sessionId: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingClientCommands = new Map<string, PendingClientCommand>();
  private timecodeTarget: TimecodeTarget | null = null;

  constructor(ctx: DurableObjectState, env: BridgeRelayEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.activeInstallation = await ctx.storage.get<BridgeSelection>("active-installation") ?? null;
      for (const ws of ctx.getWebSockets()) {
        const attachment = parseSocketAttachment(ws.deserializeAttachment?.());
        if (!attachment) continue;
        this.orgId ||= attachment.orgId;
        if (attachment.role === "bridge") {
          const authority = attachment.credentialId
            ? await getBridgeCredentialAuthority(this.env.DB, this.orgId, attachment.credentialId) : null;
          if (!authority) {
            ws.serializeAttachment({ role: "bridge", orgId: attachment.orgId });
            ws.close(4403, "Reconnect with installation credentials");
            continue;
          }
          if (attachment.targetPolicyVersion !== 3 || !attachment.settingsPublicKey) {
            ws.close(4406, "Update the Bridge to support protected device settings");
            continue;
          }
          try { await importBridgeSettingsKey(attachment.settingsPublicKey); }
          catch { ws.close(4406, "Reconnect with a valid device settings key"); continue; }
          // Re-save only parsed fields so pre-upgrade event snapshots cannot
          // retain credentials in hibernating socket attachments.
          ws.serializeAttachment(attachment);
          const installation = { installationId: authority.installationId, label: authority.label };
          this.bridges.set(ws, { ...installation, credentialId: authority.credentialId });
          // Existing releases had only one Bridge socket. Preserve its identity
          // when upgrading instead of treating it as a new takeover.
          if (!this.activeInstallation) {
            await ctx.storage.put("active-installation", installation);
            this.activeInstallation = installation;
          }
          if (installation.installationId === this.activeInstallation.installationId) {
            this.bridgeWs = ws;
            this.credentialId = authority.credentialId;
            this.timecodeTarget = attachment.timecodeTarget ?? null;
            this.bridgeOnline = true;
            if (attachment.bridgeInfo) this.bridgeInfo = attachment.bridgeInfo;
          }
        } else {
          if (!attachment.authClaim) { ws.close(4403, "Device access required"); continue; }
          this.clientSessions.add(ws);
        }
      }
    });
  }

  fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    return path === "/ws" || path === "/internal/purge-org"
      ? this.ownership.run(() => this.handleRequest(request)) : this.handleRequest(request);
  }

  private async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Deletion addresses the durable object by organization ID. It must also
    // work before the first Bridge connection establishes in-memory scope.
    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      this.failPendingDispatches("Organization deleted");
      this.failPendingClientCommands("Organization deleted");
      await this.ctx.storage.deleteAll();
      this.bridgeWs = null;
      this.activeInstallation = null;
      this.bridges.clear();
      this.clientSessions.clear();
      this.bridgeOnline = false;
      this.credentialId = null;
      this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
      return Response.json({ ok: true });
    }

    const requestedOrgId = url.searchParams.get("orgId") ?? "";
    if (this.orgId && requestedOrgId && requestedOrgId !== this.orgId) {
      return new Response("Organization mismatch", { status: 403 });
    }
    if (!this.orgId) this.orgId = requestedOrgId;
    if (!this.orgId) return new Response("Organization is required", { status: 400 });

    if (url.pathname === "/ws") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      let upgradingSocket: WebSocket | null = null;
      try {
        const role = url.searchParams.get("role") ?? "client";
        const credentialId = url.searchParams.get("authCredentialId");
        const authClaim = this.readAuthorityClaim(url);
        let settingsPublicKey: string | undefined;
        if (role === "bridge") {
          if (!credentialId || !(await getBridgeCredentialAuthority(this.env.DB, this.orgId, credentialId))) return new Response("Unauthorized", { status: 401 });
          if (request.headers.get("x-showpilot-bridge-policy") !== "3") return new Response("Update ShowPilot Desktop or Bridge to support protected device settings.", { status: 426 });
          settingsPublicKey = request.headers.get("x-showpilot-settings-key") ?? undefined;
          try { await importBridgeSettingsKey(settingsPublicKey); }
          catch { return new Response("A valid native device settings key is required.", { status: 426 }); }
        } else if ((role !== "client" && role !== "propresenter-viewer") || !authClaim || !(await hasLivePermissionAuthority(this.env.DB, authClaim, role === "propresenter-viewer" ? ["lowerthird:trigger", "rundown:control"] : "devices:access"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        upgradingSocket = server;
        const attachment: SocketAttachment = {
          role: role === "bridge" ? "bridge" : role === "propresenter-viewer" ? "propresenter-viewer" : "client",
          orgId: this.orgId,
          ...(role === "bridge"
            ? { credentialId: credentialId ?? undefined, targetPolicyVersion: 3 as const, settingsPublicKey }
            : {
                authClaim: authClaim ?? undefined,
              }),
        };

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment?.(attachment);

        if (role === "bridge") {
          const authority = credentialId ? await getBridgeCredentialAuthority(this.env.DB, this.orgId, credentialId) : null;
          if (!authority) { server.close(4403, "Bridge credential unavailable"); return new Response("Unauthorized", { status: 401 }); }
          if ([...this.bridges].some(([socket, installation]) => socket.readyState === WebSocket.OPEN && installation.installationId === authority.installationId)) {
            server.close(4410, "This installation is already connected. Use a separate named installation for another computer.");
            return new Response(null, { status: 101, webSocket: client });
          }
          const installation = { installationId: authority.installationId, label: authority.label };
          this.bridges.set(server, { ...installation, credentialId: authority.credentialId });
          attachment.installationId = installation.installationId;
          attachment.installationLabel = installation.label;
          server.serializeAttachment(attachment);
          if (!await recordBridgeWrite(this.env.DB, authority, { action: "connected", direction: "from-bridge" })) {
            server.close(4403, "Bridge credential unavailable"); this.bridges.delete(server);
            return new Response("Unauthorized", { status: 401 });
          }
          if (!this.activeInstallation) {
            await this.ctx.storage.put("active-installation", installation);
            this.activeInstallation = installation;
          }
          if (this.activeInstallation.installationId === installation.installationId) await this.activateConnection(server);
          await this.sendBridgeRole(server);
          await this.refreshConnections();
          this.broadcastStatus();
        } else {
          // Browser client connecting
          renewSocketReadLease(server);
          this.clientSessions.add(server);
          await this.refreshConnections();
          // Send current bridge status
          server.send(
            JSON.stringify({
              type: "bridge-status",
              online: this.bridgeOnline,
              ...(role === "propresenter-viewer" ? {} : { ...this.bridgeInfo, ...this.selectionStatus() }),
            })
          );
        }

        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        if (upgradingSocket) { upgradingSocket.close(1011, "Bridge authorization unavailable"); this.disconnectSocket(upgradingSocket); }
        console.error("[BridgeRelay] websocket setup failed", err);
        return new Response("Bridge websocket failed", { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      return Response.json(await this.getBridgeStatus());
    }

    return new Response("Not found", { status: 404 });
  }

  private selectionStatus() {
    return {
      activeInstallation: this.activeInstallation,
      connections: [...this.bridges].filter(([socket]) => socket.readyState === WebSocket.OPEN).map(([socket, installation]) => ({
        installationId: installation.installationId, label: installation.label,
        role: socket === this.bridgeWs ? "active" as const : "standby" as const,
      })),
    };
  }

  private broadcastStatus(): void {
    this.broadcastToClients(JSON.stringify({ type: "bridge-status", online: this.bridgeOnline, ...this.bridgeInfo, ...this.selectionStatus() }));
  }

  private async sendBridgeRole(socket: WebSocket, role = socket === this.bridgeWs ? "active" : "standby", selectionId?: string): Promise<void> {
    const installation = this.bridges.get(socket);
    if (!installation) return;
    const approvedTargets = role === "active" ? await listBridgeTargets(this.env.DB, this.orgId) : [];
    socket.send(JSON.stringify({ type: "bridge-role", role, orgId: this.orgId, selectionId, approvedTargets, installationId: installation.installationId, activeInstallation: this.activeInstallation }));
  }

  private async sendBridgeRoles(): Promise<void> {
    for (const socket of this.bridges.keys()) {
      try { await this.sendBridgeRole(socket); }
      catch { socket.close(1011, "Bridge destination approvals unavailable"); this.disconnectSocket(socket); }
    }
  }

  private async quiesceBridge(socket: WebSocket): Promise<void> {
    const id = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.pendingDemotion = { socket, id, resolve, reject };
        timer = setTimeout(() => reject(new Error("The active Bridge did not confirm standby. Update or stop that Bridge before taking control here.")), 5000);
        void this.sendBridgeRole(socket, "standby", id).catch(reject);
      });
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingDemotion = null;
    }
  }

  private async activateConnection(socket: WebSocket, preparedTarget?: { target: TimecodeTarget | null }): Promise<void> {
    const installation = this.bridges.get(socket);
    if (!installation || socket.readyState !== WebSocket.OPEN) throw new Error("Selected Bridge is offline.");
    const target = preparedTarget ? preparedTarget.target : await resolveTimecodeTarget(this.env.DB, this.orgId);
    this.bridgeWs = socket;
    this.credentialId = installation.credentialId;
    this.bridgeOnline = true;
    this.bridgeInfo = parseSocketAttachment(socket.deserializeAttachment())?.bridgeInfo ?? { connectedTargets: [], deviceEvents: {} };
    this.timecodeTarget = target;
    this.serializeBridgeAttachment();
  }

  /** Worker-only RPC. Caller must authorize key management before selecting. */
  async selectInstallation(input: { orgId: string; installationId: string; expectedActiveInstallationId: string | null; actorUserId: string }): Promise<BridgeRelayStatus> {
    return this.ownership.run(async () => {
      if (input.orgId !== this.orgId) throw new Error("Bridge organization mismatch.");
      if (input.expectedActiveInstallationId !== (this.activeInstallation?.installationId ?? null)) throw new Error("Active Bridge changed. Review the selection and confirm again.");
      const entry = [...this.bridges].find(([socket, installation]) => socket.readyState === WebSocket.OPEN && installation.installationId === input.installationId);
      if (!entry) throw new Error("Selected Bridge is offline. Connect it before taking control.");
      const [socket, installation] = entry;
      const authority = await getBridgeCredentialAuthority(this.env.DB, this.orgId, installation.credentialId);
      if (!authority || !await recordBridgeWrite(this.env.DB, authority, { action: "selection-requested", direction: "to-bridge", actorUserId: input.actorUserId })) throw new Error("Selected Bridge credential is unavailable.");
      if (socket !== this.bridgeWs) {
        const target = await resolveTimecodeTarget(this.env.DB, this.orgId);
        const previous = this.bridgeWs;
        const previousTarget = this.timecodeTarget;
        try {
          if (previous?.readyState === WebSocket.OPEN) await this.quiesceBridge(previous);
          // Stop the previous clock before publishing a new owner. A failed
          // clock handoff leaves the old selection intact and restores its role.
          await this.stopBridgeTimecode(previousTarget);
          if (!await getBridgeCredentialAuthority(this.env.DB, this.orgId, installation.credentialId)) throw new Error("Selected Bridge credential is unavailable.");
          if (socket.readyState !== WebSocket.OPEN) throw new Error("Selected Bridge disconnected before takeover.");
          const selection = { installationId: installation.installationId, label: installation.label };
          await this.ctx.storage.put("active-installation", selection);
          this.failPendingDispatches("Active Bridge changed. Check the device before retrying.");
          this.failPendingClientCommands("Active Bridge changed. Check the device before retrying.");
          this.activeInstallation = selection;
          // Publication is committed. If the chosen transport closed during
          // storage I/O it stays selected, offline; never reactivate the old one.
          this.bridgeWs = null;
          this.credentialId = null;
          this.bridgeOnline = false;
          this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
          this.timecodeTarget = null;
          if (socket.readyState === WebSocket.OPEN) await this.activateConnection(socket, { target });
        } catch (error) {
          // Failed preparation/publication leaves the old selected installation.
          // Restore its role if it already acknowledged standby.
          await this.sendBridgeRoles();
          throw error;
        }
        await this.sendBridgeRoles();
        this.broadcastStatus();
      }
      return this.statusSnapshot();
    });
  }

  private statusSnapshot(): BridgeRelayStatus {
    return { bridgeOnline: this.bridgeOnline, clientCount: this.clientSessions.size, timecodeTarget: this.timecodeTarget, ...this.bridgeInfo, ...this.selectionStatus() };
  }

  async getBridgeStatus(): Promise<BridgeRelayStatus> {
    return this.ownership.run(async () => { await this.refreshConnections(); return this.statusSnapshot(); });
  }

  /** Permission-checked Worker RPC. Private settings are delivered exclusively
   * to the currently selected installation's ephemeral encryption key. */
  async prepareLocalShow(raw: LocalShowPreparationInput, claim: LiveRundownAuthorityClaim) {
    const input = localShowPreparationInput.parse(raw);
    if (this.orgId !== input.orgId) throw new Error("Bridge workspace does not match the requested show.");
    // Device and rundown reads happen outside the Bridge writer. Timecode can
    // continue dispatching while preparation resolves its saved cue definitions.
    const prepared = await buildLocalShowPreparation(this.env, input, claim);
    const delivery = await this.ownership.run(async () => {
      const socket = this.bridgeWs;
      const installation = socket ? this.bridges.get(socket) : undefined;
      const attachment = socket ? parseSocketAttachment(socket.deserializeAttachment()) : null;
      if (
        !socket ||
        socket.readyState !== WebSocket.OPEN ||
        !this.bridgeOnline ||
        !installation ||
        installation.installationId !== input.installationId
      )
        throw new Error(
          "The selected venue computer changed or is offline. Refresh its connection before preparing the show.",
        );
      if (!attachment?.settingsPublicKey)
        throw new Error("Update the venue Bridge before preparing local control.");
      if (this.pendingLocalPreparations.size >= 8)
        throw new Error(
          "Local preparations are still waiting for the venue computer. Check its status before retrying.",
        );
      const authority = await getBridgeCredentialAuthority(
        this.env.DB,
        this.orgId,
        installation.credentialId,
      );
      if (!authority) throw new Error("The venue Bridge credential expired or was revoked.");
      const approved = new Set(
        (await listBridgeTargets(this.env.DB, this.orgId)).map((endpoint) =>
          JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port]),
        ),
      );
      if (
        !prepared.approvedTargets.every((endpoint) =>
          approved.has(JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port])),
        )
      )
        throw new Error("Device approvals changed while preparing this show. Review them and try again.");
      prepared.expiresAt = Math.min(prepared.expiresAt, authority.expiresAt ?? Infinity);
      if (prepared.expiresAt <= Date.now())
        throw new Error(
          "The venue Bridge credential is expiring. Refresh it before preparing local control.",
        );
      if (new TextEncoder().encode(JSON.stringify(prepared)).length > MAX_BRIDGE_SETTINGS_BYTES)
        throw new Error(
          "This local preparation exceeds the 200 KB transfer limit. Reduce rundown notes or split the show before preparing it.",
        );
      const protectedSettings = await sealBridgeSettings(
        attachment.settingsPublicKey,
        {
          orgId: this.orgId,
          installationId: installation.installationId,
          protocol: "local-show",
          target: input.showId,
        },
        prepared,
      );
      await assertLocalShowAuthority(this.env.DB, claim, input.orgId);
      if (
        !(await recordBridgeWrite(this.env.DB, authority, {
          action: "prepare-local-show",
          direction: "to-bridge",
          actorUserId: claim.userId,
        }))
      )
        throw new Error("The venue Bridge credential changed during preparation.");
      if (this.bridgeWs !== socket || socket.readyState !== WebSocket.OPEN)
        throw new Error("The venue computer disconnected during preparation.");
      const id = crypto.randomUUID();
      const received = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingLocalPreparations.delete(id);
          reject(
            new Error(
              "The venue computer did not confirm saving the local show. Check its local status before retrying.",
            ),
          );
        }, 10000);
        this.pendingLocalPreparations.set(id, { socket, sessionId: input.sessionId, resolve, reject, timer });
        try {
          socket.send(
            JSON.stringify({ type: "prepare-local-show", id, showId: input.showId, protectedSettings }),
          );
        } catch {
          clearTimeout(timer);
          this.pendingLocalPreparations.delete(id);
          reject(new Error("The venue computer disconnected before saving the local show."));
        }
      });
      return { received };
    });
    await delivery.received;
    return {
      sessionId: prepared.sessionId,
      baseRevision: prepared.baseRevision,
      preparedAt: prepared.preparedAt,
      expiresAt: prepared.expiresAt,
      actionCount: prepared.actions.length,
    };
  }

  /** Worker-only RPC, after settings permission checks. Serializes policy
   * publication with takeover and dispatch, including native output shutdown. */
  async changeTargetApproval(input: { orgId: string; actorUserId: string } & (
    | { action: "approve"; label: string; endpoint: BridgeEndpoint }
    | { action: "remove"; id: string }
  )) {
    return this.ownership.run(async () => {
      this.orgId ||= input.orgId;
      if (this.orgId !== input.orgId) throw new Error("Bridge organization mismatch.");
      if (input.action === "approve") await approveBridgeTarget(this.env.DB, input);
      else await removeBridgeTarget(this.env.DB, input);
      let targets;
      try { targets = await listBridgeTargets(this.env.DB, this.orgId); }
      catch {
        if (this.bridgeWs) {
          this.bridgeWs.close(1011, "Bridge destination approvals unavailable");
          this.disconnectSocket(this.bridgeWs);
        }
        throw new Error("Approval saved, but the updated list could not be loaded. The Bridge connection was closed. Refresh before continuing.");
      }
      const socket = this.bridgeWs;
      if (!socket || socket.readyState !== WebSocket.OPEN) return { targets, warning: null };
      const id = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          this.pendingPolicy = { socket, id, resolve };
          timer = setTimeout(() => reject(new Error("Bridge approval acknowledgement timed out")), 5000);
          socket.send(JSON.stringify({ type: "bridge-policy", policyId: id, approvedTargets: targets }));
        });
        return { targets, warning: null };
      } catch {
        socket.close(4403, "Reconnect to apply destination approvals");
        this.disconnectSocket(socket);
        return { targets, warning: "Approval saved. The Bridge did not confirm that it applied the change, so its cloud connection was closed. Check the equipment and update or restart the Bridge before continuing." };
      } finally {
        if (timer) clearTimeout(timer);
        this.pendingPolicy = null;
      }
    });
  }

  /** Internal Worker RPC used by permission-checked native device controls. */
  async dispatchBridgeMessage(message: BridgeDispatchMessage, actor: BridgeTargetActor, expectedInstallationId?: string): Promise<BridgeDispatchResult> {
    const operation = await this.ownership.run(async () => {
      const socket = this.bridgeWs;
      if (!socket || !this.bridgeOnline) return { result: Promise.resolve({ success: false, error: "Venue Bridge is offline" }) };
      if (expectedInstallationId !== undefined && this.bridges.get(socket)?.installationId !== expectedInstallationId) {
        return { result: Promise.resolve({ success: false, error: "Active Venue Bridge changed. Check the output before retrying." }) };
      }
      if (!await this.authorizeBridgeWrite(socket, message.type, "to-bridge", actor.actorUserId ?? undefined)) return { result: Promise.resolve({ success: false, error: "Venue Bridge credential is unavailable" }) };
      if (message.type !== "disconnect-device") {
        try { await authorizeBridgeTarget(this.env.DB, this.orgId, message, actor); }
        catch (error) {
          return { result: Promise.resolve({ success: false, error: error instanceof BridgeTargetError ? error.message : "Bridge destination approval could not be verified." }) };
        }
      }
      try {
        const wireMessage = message.type === "connect-device"
          ? await this.protectDeviceSettings(socket, message.protocol, message.target, message.settings) : message;
        return { result: this.beginDispatch(socket, wireMessage, actor) };
      } catch {
        return { result: Promise.resolve({ success: false, error: "Protected device settings could not be delivered. Reconnect the Bridge." }) };
      }
    });
    return operation.result;
  }

  private async protectDeviceSettings(socket: WebSocket, protocol: string, target: string, settings: Record<string, unknown>): Promise<Extract<NativeDispatchMessage, { type: "connect-device" }>> {
    const installation = this.bridges.get(socket);
    const attachment = parseSocketAttachment(socket.deserializeAttachment());
    if (!installation || !attachment?.settingsPublicKey || attachment.orgId !== this.orgId) throw new Error("Protected Bridge settings unavailable");
    const protectedSettings = await sealBridgeSettings(attachment.settingsPublicKey, {
      orgId: this.orgId, installationId: installation.installationId, protocol, target,
    }, settings);
    return { type: "connect-device", protocol, target, protectedSettings };
  }

  private beginDispatch(bridgeSocket: WebSocket, message: NativeDispatchMessage, actor: BridgeTargetActor): Promise<BridgeDispatchResult> {
    if (message.type === "disconnect-device") {
      try {
        bridgeSocket.send(JSON.stringify(message));
        return Promise.resolve({ success: true });
      } catch {
        return Promise.resolve({ success: false, error: "Venue Bridge disconnected" });
      }
    }

    const key = message.type === "command"
      ? typeof message.id === "string" ? message.id : ""
      : typeof message.target === "string" ? message.target : "";
    if (!key) return Promise.resolve({ success: false, error: "Bridge operation is missing an identifier" });
    const pending = message.type === "command" ? this.pendingCommands : this.pendingConnections;
    if (pending.has(key)) return Promise.resolve({ success: false, error: "A matching device operation is already running" });

    return new Promise<BridgeDispatchResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        resolve({ success: false, error: message.type === "command" ? "Device command timed out" : "Device connection timed out" });
      }, message.type === "command" ? 10_000 : 8_000);
      pending.set(key, { resolve, timer, connection: commandConnection(message, actor) });
      try {
        bridgeSocket.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        pending.delete(key);
        resolve({ success: false, error: "Venue Bridge disconnected" });
      }
    });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    // The handoff owns the command queue while waiting. Its one narrow ack
    // releases that wait; it cannot forward device data or grant authority.
    try {
      const message: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (isRecord(message) && message.type === "bridge-role-applied") {
        if (this.pendingDemotion?.socket === ws && message.selectionId === this.pendingDemotion.id && message.role === "standby") this.pendingDemotion.resolve();
        return Promise.resolve();
      }
      if (isRecord(message) && message.type === "bridge-policy-applied") {
        if (this.pendingPolicy?.socket === ws && message.policyId === this.pendingPolicy.id) this.pendingPolicy.resolve();
        return Promise.resolve();
      }
    } catch { return Promise.resolve(); }
    return this.ownership.run(() => this.handleSocketMessage(ws, data));
  }

  private async handleSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (!isRecord(parsed) || typeof parsed.type !== "string") return;
      const msg: BridgeMessage = { ...parsed, type: parsed.type };

      const installation = this.bridges.get(ws);
      if (installation && ws !== this.bridgeWs) {
        const authority = await getBridgeCredentialAuthority(this.env.DB, this.orgId, installation.credentialId);
        if (!authority) { ws.close(4403, "Bridge credential unavailable"); this.disconnectSocket(ws); return; }
        // Standbys can report readiness, but never drive lyrics, timecode,
        // device state, or acknowledge another installation's command.
        if (msg.type === "bridge-status") {
          const attachment = parseSocketAttachment(ws.deserializeAttachment());
          if (attachment) ws.serializeAttachment({ ...attachment, bridgeInfo: { connectedTargets: [], devices: 0, version: typeof msg.version === "string" ? msg.version : undefined } });
          this.broadcastStatus();
        }
        return;
      }
      if (ws === this.bridgeWs) {
        const action = bridgeAuditAction(msg.type);
        if (!action || !(await this.authorizeBridgeWrite(ws, action, "from-bridge"))) return;
        // Message from bridge → forward to clients
        await this.handleBridgeMessage(msg);
      } else {
        const attachment = parseSocketAttachment(ws.deserializeAttachment?.());
        if (
          !attachment?.authClaim
          || !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, attachment.role === "propresenter-viewer" ? ["lowerthird:trigger", "rundown:control"] : "devices:access"))
        ) {
          ws.close(4403, "Device access changed");
          this.clientSessions.delete(ws);
          return;
        }
        renewSocketReadLease(ws);
        if (attachment.role === "propresenter-viewer") return;
        // Message from browser client → forward to bridge
        await this.handleClientMessage(msg, ws, attachment.authClaim.userId);
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (this.pendingDemotion?.socket === ws) this.pendingDemotion.reject(new Error("Active Bridge disconnected during takeover. Review its status and retry."));
    return this.ownership.run(async () => this.closeSocket(ws, code, reason));
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    // Our compatibility date predates automatic close replies. Reciprocate
    // peer-initiated closure before dropping the transport's local state.
    const replyCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
    try { ws.close(replyCode, reason); }
    finally { this.disconnectSocket(ws); }
  }

  private disconnectSocket(ws: WebSocket) {
    const wasBridge = this.bridges.delete(ws);
    if (ws === this.bridgeWs) {
      this.bridgeWs = null;
      this.credentialId = null;
      this.bridgeOnline = false;
      this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
      this.failPendingDispatches("Venue Bridge disconnected");
      this.failPendingClientCommands("Venue Bridge disconnected");
      // Losing the transport is not a slide Clear. Keep the last confirmed
      // lyric until the bridge supplies its replacement or an explicit clear.
      const target = this.timecodeTarget;
      this.timecodeTarget = null;
      void this.stopBridgeTimecode(target).catch(() => console.error("[BridgeRelay] disconnected clock cleanup failed"));
      this.broadcastStatus();
    } else {
      if (wasBridge) this.broadcastStatus();
      this.clientSessions.delete(ws);
      for (const [operationId, owner] of this.pendingClientCommands) {
        if (owner.socket === ws) {
          clearTimeout(owner.timer);
          this.pendingClientCommands.delete(operationId);
        }
      }
    }
  }

  webSocketError(ws: WebSocket): Promise<void> {
    if (this.pendingDemotion?.socket === ws) this.pendingDemotion.reject(new Error("Active Bridge connection failed during takeover. Review its status and retry."));
    return this.ownership.run(async () => this.disconnectSocket(ws));
  }

  // ─── Message Routing ────────────────────────────────────

  private async handleBridgeMessage(msg: BridgeMessage): Promise<void> {
    switch (msg.type) {
      case "local-show-prepared": {
        if (typeof msg.id !== "string") return;
        const pending = this.pendingLocalPreparations.get(msg.id);
        if (!pending || pending.socket !== this.bridgeWs) return;
        if (msg.success !== true && msg.success !== false) return;
        if (msg.success === true && msg.sessionId !== pending.sessionId) return;
        clearTimeout(pending.timer);
        this.pendingLocalPreparations.delete(msg.id);
        if (msg.success === true) pending.resolve();
        else
          pending.reject(
            new Error(
              "The venue computer could not save this local show. Check its local status and finish any previous local session before retrying.",
            ),
          );
        return;
      }
      case "configured-propresenter-requested": {
        if (!this.bridgeWs || !this.activeInstallation) break;
        const socket = this.bridgeWs;
        try {
          const settings = await readProPresenterSettings(this.env.DB, this.orgId, this.env.CREDENTIAL_ENCRYPTION_KEYS);
          if (!settings.host) break;
          const message = proPresenterConnection(settings);
          if (this.bridgeInfo.connectedTargets.includes(message.target)) break;
          await authorizeBridgeTarget(this.env.DB, this.orgId, message, {
            source: "automation", actorUserId: null,
            executionId: `installation:${this.activeInstallation.installationId}:${crypto.randomUUID()}`,
          });
          const protectedMessage = await this.protectDeviceSettings(socket, message.protocol, message.target, message.settings);
          if (socket === this.bridgeWs && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(protectedMessage));
        } catch {
          // Audit/approval/key failures must not deliver credentials or start network I/O.
          socket.send(JSON.stringify({ type: "configured-propresenter-unavailable" }));
        }
        break;
      }
      case "command-connection-requested": {
        if (typeof msg.id !== "string" || typeof msg.requestId !== "string" || msg.requestId.length > 128) break;
        const owner = this.pendingClientCommands.get(msg.id);
        const context = owner?.connection ?? this.pendingCommands.get(msg.id)?.connection;
        let approved = false;
        if (context && !context.requested) {
          context.requested = true;
          try {
            // Never trust native-supplied destinations or attribution. Resolve
            // from the already-authorized command, and log before permitting I/O.
            const claim = owner ? parseSocketAttachment(owner.socket.deserializeAttachment())?.authClaim : null;
            if (owner && (!claim || !await hasLivePermissionAuthority(this.env.DB, claim, "devices:access"))) {
              throw new Error("Device access changed");
            }
            await authorizeBridgeTarget(this.env.DB, this.orgId, {
              type: "connect-device", target: context.target, protocol: context.protocol, settings: {},
            }, context.actor);
            // The command deadline can expire while D1 is writing the audit.
            approved = owner ? this.pendingClientCommands.get(msg.id) === owner
              : this.pendingCommands.get(msg.id)?.connection === context;
          } catch { /* Missing authority, audit storage, or approval fails closed. */ }
        }
        this.bridgeWs?.send(JSON.stringify({ type: "command-connection-approved", id: msg.id, requestId: msg.requestId, approved }));
        break;
      }
      case "automatic-connection-requested": {
        if (typeof msg.target !== "string" || typeof msg.requestId !== "string" || !msg.requestId || msg.requestId.length > 128 || !this.activeInstallation) break;
        let approved = false;
        try {
          await authorizeBridgeTarget(this.env.DB, this.orgId, {
            type: "connect-device", protocol: "propresenter", target: msg.target,
            settings: { apiPort: msg.apiPort },
          }, { source: "automation", actorUserId: null, executionId: `installation:${this.activeInstallation.installationId}:${crypto.randomUUID()}` });
          approved = true;
        } catch { /* No native connection may start until its audit is saved. */ }
        this.bridgeWs?.send(JSON.stringify({ type: "automatic-connection-approved", requestId: msg.requestId, approved }));
        break;
      }
      case "bridge-status":
        this.bridgeInfo = {
          version: typeof msg.version === "string" ? msg.version : undefined,
          devices: typeof msg.devices === "number" ? msg.devices : undefined,
          uptime: typeof msg.uptime === "number" ? msg.uptime : undefined,
          connectedTargets: Array.isArray(msg.targets)
            ? msg.targets.filter((target): target is string => typeof target === "string")
            : this.bridgeInfo.connectedTargets,
          deviceEvents: this.bridgeInfo.deviceEvents,
        };
        this.serializeBridgeAttachment();
        this.broadcastToClients(JSON.stringify({
          type: "bridge-status",
          online: true,
          ...this.bridgeInfo,
          ...this.selectionStatus(),
        }));
        break;

      case "command-response":
        if (typeof msg.id === "string") {
          const pending = this.pendingCommands.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(msg.id);
            pending.resolve({
              success: msg.success === true,
              response: typeof msg.response === "string" ? redactCredentialText(msg.response) : undefined,
              error: typeof msg.error === "string" ? redactCredentialText(msg.error) : undefined,
            });
            break;
          }
          const owner = this.pendingClientCommands.get(msg.id);
          if (owner) {
            clearTimeout(owner.timer);
            this.pendingClientCommands.delete(msg.id);
            try {
              owner.socket.send(JSON.stringify({
                type: "command-response", id: owner.clientId, success: msg.success === true,
                response: typeof msg.response === "string" ? redactCredentialText(msg.response) : undefined,
                error: typeof msg.error === "string" ? redactCredentialText(msg.error) : undefined,
              }));
            } catch {
              this.clientSessions.delete(owner.socket);
            }
          }
        }
        break;

      case "device-event": {
        if (typeof msg.target !== "string" || typeof msg.eventName !== "string" || typeof msg.data !== "string") break;
        // Only the documented event fields are public. A native adapter must
        // never publish an attached settings/authentication blob to operators.
        const data = redactCredentialText(msg.data);
        if (msg.eventName === "slide") {
          this.previewWrite = this.previewWrite.then(() => this.pushPreviewSlide(data));
          await this.previewWrite;
        }
        this.bridgeInfo = {
          ...this.bridgeInfo,
          deviceEvents: {
            ...this.bridgeInfo.deviceEvents,
            [msg.target]: {
              eventName: msg.eventName,
              data,
              receivedAt: Date.now(),
            },
          },
        };
        this.serializeBridgeAttachment();
        // Unsolicited device events are shared venue state and reach every
        // operator. Command replies above are deliberately point-to-point.
        this.broadcastToClients(JSON.stringify({ type: "device-event", target: msg.target, eventName: msg.eventName, data }));
        break;
      }

      case "device-status":
        if (typeof msg.target === "string") {
          const targets = new Set(this.bridgeInfo.connectedTargets);
          if (msg.connected === true) targets.add(msg.target);
          else targets.delete(msg.target);
          const deviceEvents = { ...this.bridgeInfo.deviceEvents };
          if (msg.connected !== true) delete deviceEvents[msg.target];
          this.bridgeInfo = { ...this.bridgeInfo, connectedTargets: [...targets].sort(), devices: targets.size, deviceEvents };
          this.serializeBridgeAttachment();
          const pending = this.pendingConnections.get(msg.target);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingConnections.delete(msg.target);
            pending.resolve({
              success: msg.connected === true,
              error: msg.connected === true ? undefined : "Venue Bridge could not connect to the device",
            });
          }
        }
        // Status carries connection metadata only, never native adapter settings.
        if (typeof msg.target === "string") this.broadcastToClients(JSON.stringify({
          type: "device-status", target: msg.target, connected: msg.connected === true,
          error: typeof msg.error === "string" ? redactCredentialText(msg.error) : undefined,
        }));
        break;

      case "pong":
        // Bridge responding to keepalive
        break;

      case "timecode-feed":
      case "timecode-transport":
        await this.pushTimecode(msg);
        break;
    }
  }

  private async handleClientMessage(msg: BridgeMessage, clientWs: WebSocket, actorUserId: string): Promise<void> {
    if (msg.type !== "command" && msg.type !== "connect-device" && msg.type !== "ping") return;
    if (!this.bridgeWs || !this.bridgeOnline) {
      this.rejectClientMessage(clientWs, msg, "Bridge is offline");
      return;
    }

    if (!(await this.authorizeBridgeWrite(this.bridgeWs, msg.type, "to-bridge", actorUserId))) {
      this.rejectClientMessage(clientWs, msg, "Venue Bridge credential expired or was revoked");
      return;
    }

    if (msg.type !== "ping") {
      try { await authorizeBridgeTarget(this.env.DB, this.orgId, msg, { source: "operator", actorUserId }); }
      catch (error) {
        const detail = error instanceof BridgeTargetError ? error.message : "Bridge destination approval could not be verified.";
        this.rejectClientMessage(clientWs, msg, detail);
        return;
      }
    }

    switch (msg.type) {
      case "command": {
        if (typeof msg.id !== "string" || !msg.id) return;
        const operationId = `client_${crypto.randomUUID()}`;
        const timer = setTimeout(() => {
          this.pendingClientCommands.delete(operationId);
          try { clientWs.send(JSON.stringify({ type: "command-response", id: msg.id, success: false, error: "Device command timed out" })); }
          catch { /* The client may already have disconnected. */ }
        }, 10_000);
        this.pendingClientCommands.set(operationId, { socket: clientWs, clientId: msg.id, timer,
          connection: commandConnection(msg, { source: "operator", actorUserId }) });
        try {
          this.bridgeWs.send(JSON.stringify({ type: "command", id: operationId, protocol: msg.protocol, target: msg.target, command: msg.command }));
        } catch {
          clearTimeout(timer);
          this.pendingClientCommands.delete(operationId);
          try {
            clientWs.send(JSON.stringify({
              type: "command-response",
              id: msg.id,
              success: false,
              error: "Venue Bridge disconnected",
            }));
          } catch {}
        }
        break;
      }
      case "connect-device":
        try {
          if (typeof msg.protocol !== "string" || typeof msg.target !== "string") return;
          const settings = msg.settings ?? {};
          if (!isRecord(settings)) return;
          const protectedMessage = await this.protectDeviceSettings(this.bridgeWs, msg.protocol, msg.target, settings);
          this.bridgeWs.send(JSON.stringify(protectedMessage));
        } catch {
          this.rejectClientMessage(clientWs, msg, "Protected device settings could not be delivered. Reconnect the Bridge.");
        }
        break;

      case "ping":
        try {
          this.bridgeWs.send(JSON.stringify({ type: "ping" }));
        } catch {
          this.rejectClientMessage(clientWs, msg, "Venue Bridge disconnected");
        }
        break;
    }
  }

  private rejectClientMessage(clientWs: WebSocket, msg: BridgeMessage, error: string): void {
    const response = msg.type === "connect-device"
      ? { type: "device-status", target: msg.target, connected: false, success: false, error }
      : { type: msg.type === "ping" ? "ping-response" : "command-response", id: msg.id, success: false, error };
    try { clientWs.send(JSON.stringify(response)); }
    catch { this.clientSessions.delete(clientWs); }
  }

  // ─── Helpers ────────────────────────────────────────────

  private failPendingDispatches(error: string): void {
    for (const pending of this.pendingLocalPreparations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    this.pendingLocalPreparations.clear();
    for (const pending of [...this.pendingCommands.values(), ...this.pendingConnections.values()]) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
    }
    this.pendingCommands.clear();
    this.pendingConnections.clear();
  }

  private failPendingClientCommands(error: string): void {
    for (const owner of this.pendingClientCommands.values()) {
      clearTimeout(owner.timer);
      try {
        owner.socket.send(JSON.stringify({
          type: "command-response",
          id: owner.clientId,
          success: false,
          error,
        }));
      } catch {}
    }
    this.pendingClientCommands.clear();
  }

  private broadcastToClients(data: string): void {
    const slideOnly = proPresenterViewerMessage(data);
    for (const ws of [...this.clientSessions]) {
      if (!socketReadLeaseAllows(ws, true)) { this.clientSessions.delete(ws); continue; }
      try {
        const message = parseSocketAttachment(ws.deserializeAttachment())?.role === "propresenter-viewer" ? slideOnly : data;
        if (message !== null) ws.send(message);
      }
      catch { this.clientSessions.delete(ws); }
    }
  }

  private readAuthorityClaim(url: URL): LiveSessionAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    if (!userId || !sessionId || !this.orgId) return null;
    return { userId, sessionId, orgId: this.orgId };
  }

  private serializeBridgeAttachment(): void {
    this.bridgeWs?.serializeAttachment?.({
      role: "bridge",
      orgId: this.orgId,
      bridgeInfo: this.bridgeInfo,
      installationId: this.activeInstallation?.installationId,
      installationLabel: this.activeInstallation?.label,
      targetPolicyVersion: 3,
      settingsPublicKey: parseSocketAttachment(this.bridgeWs.deserializeAttachment())?.settingsPublicKey,
      timecodeTarget: this.timecodeTarget ?? undefined,
      ...(this.credentialId ? { credentialId: this.credentialId } : {}),
    } satisfies SocketAttachment);
  }

  /** Called by settings after rotation/revocation and by the expiry alarm. */
  refreshCredentialAuthority(): Promise<void> {
    return this.ownership.run(() => this.refreshConnections());
  }

  private async refreshConnections(): Promise<void> {
    let expiresAt: number | null = null;
    for (const [socket, installation] of this.bridges) {
      const authority = await getBridgeCredentialAuthority(this.env.DB, this.orgId, installation.credentialId);
      if (!authority) {
        socket.close(4403, "Venue Bridge credential expired or revoked");
        this.disconnectSocket(socket);
      } else if (authority.expiresAt !== null) expiresAt = expiresAt === null ? authority.expiresAt : Math.min(expiresAt, authority.expiresAt);
    }
    await scheduleSocketReadRefresh(this.ctx, ws => { const role = parseSocketAttachment(ws.deserializeAttachment())?.role; return role === "client" || role === "propresenter-viewer"; }, expiresAt);
  }

  async refreshReadAuthority(userId?: string): Promise<void> {
    await refreshSocketReadLeases(this.ctx.getWebSockets(), async socket => {
      const attachment = parseSocketAttachment(socket.deserializeAttachment());
      if (attachment?.role !== "client" && attachment?.role !== "propresenter-viewer") return null;
      if (userId && attachment.authClaim?.userId !== userId) return null;
      return Boolean(attachment.authClaim && await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, attachment.role === "propresenter-viewer" ? ["lowerthird:trigger", "rundown:control"] : "devices:access"));
    });
    await this.refreshCredentialAuthority();
  }

  async alarm(): Promise<void> { await this.refreshReadAuthority(); }

  private async authorizeBridgeWrite(socket: WebSocket, action: BridgeAuditAction, direction: "from-bridge" | "to-bridge", actorUserId?: string): Promise<boolean> {
    const credentialId = this.credentialId;
    if (socket !== this.bridgeWs || !credentialId) return false;
    let allowed = false;
    try {
      const authority = await getBridgeCredentialAuthority(this.env.DB, this.orgId, credentialId);
      allowed = Boolean(authority && await recordBridgeWrite(this.env.DB, authority, { action, direction, actorUserId }));
    } catch {
      if (socket === this.bridgeWs) { socket.close(1011, "Bridge authorization unavailable"); this.disconnectSocket(socket); }
      return false;
    }
    if (socket !== this.bridgeWs || credentialId !== this.credentialId) return false;
    if (!allowed) {
      socket.close(4403, "Venue Bridge credential expired or revoked");
      this.disconnectSocket(socket);
      return false;
    }
    return true;
  }

  private async pushPreviewSlide(data: string): Promise<void> {
    if (!this.orgId) return;

    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed === null) {
        await this.clearPreviewSlide();
        return;
      }
      if (!isRecord(parsed)) return;
      const slide = parsed;

      const content = parseRelayPPSlide({
        text: String(slide.text ?? ""),
        notes: String(slide.notes ?? ""),
        presentationName: String(slide.presentationName ?? slide.pn ?? ""),
        isScripture: Boolean(slide.isScripture ?? slide.scripture ?? false),
        slideId: slide.slideId,
        nextText: slide.nextText,
        nextSlideId: slide.nextSlideId,
      });
      if (!content) return;
      const payload = { ...content, updatedAt: Date.now() };

      const target = await getActiveRundownRelayTarget(this.env.DB, this.orgId);
      const rdId = this.env.RUNDOWN_RELAY.idFromName(target.key);
      const rdStub = this.env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        rundownInternalRequest(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, this.env.BETTER_AUTH_SECRET, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pp-preview",
            payload: { slide: payload, outputEnabled: target.ppOutputEnabled },
          }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to push preview slide", err);
    }
  }

  private async clearPreviewSlide(): Promise<void> {
    if (!this.orgId) return;

    try {
      const target = await getActiveRundownRelayTarget(this.env.DB, this.orgId);
      const rdId = this.env.RUNDOWN_RELAY.idFromName(target.key);
      const rdStub = this.env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        rundownInternalRequest(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, this.env.BETTER_AUTH_SECRET, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pp-preview",
            payload: { slide: null, outputEnabled: target.ppOutputEnabled },
          }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to clear preview slide", err);
    }
  }

  private async pushTimecode(message: BridgeMessage): Promise<void> {
    const receivedAt = Date.now();
    const target = this.timecodeTarget;
    const socket = this.bridgeWs;
    const transport = message.type === "timecode-transport";
    if (!target || !this.env.BETTER_AUTH_SECRET) return;
    if (transport ? message.state !== "stopped" && message.state !== "waiting" : !isRecord(message.timecode) || !isRecord(message.format)) return;
    const relay = this.env.TIMECODE_RELAY.getByName(timecodeRelayKey(target));
    const binding = await relay.bindShow(target);
    if (!binding.ok) return;
    if (socket !== this.bridgeWs || target !== this.timecodeTarget) return;
    // Room preparation must not turn a delayed native sample into fresh input.
    // Transport Stop/Continue still reaches the relay even when binding is slow.
    if (!transport && Date.now() - receivedAt >= TIMECODE_FEED_STALL_MS) return;
    const response = await relay.fetch(new Request(timecodeTargetUrl(target, transport ? "/internal/bridge-transport" : "/internal/bridge-feed"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-showpilot-internal-secret": this.env.BETTER_AUTH_SECRET },
      body: JSON.stringify({
        payload: transport ? { state: message.state } : {
          source: message.source ?? "mtc",
          timecode: message.timecode,
          format: message.format,
          totalFrames: message.totalFrames,
        },
      }),
    }));
    await response.body?.cancel();
  }

  private async stopBridgeTimecode(target: TimecodeTarget | null): Promise<void> {
    if (!target || !this.env.BETTER_AUTH_SECRET) return;
    const relay = this.env.TIMECODE_RELAY.getByName(timecodeRelayKey(target));
    const response = await relay.fetch(new Request(timecodeTargetUrl(target, "/internal/bridge-disconnected"), {
      method: "POST",
      headers: { "x-showpilot-internal-secret": this.env.BETTER_AUTH_SECRET },
    }));
    await response.body?.cancel();
    if (!response.ok) throw new Error("Previous Bridge clock could not be stopped. Retry takeover after checking its status.");
  }
}
