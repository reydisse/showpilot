import { ProPresenterReservations } from "./propresenter-reservations.js";
import WebSocket, { type ClientOptions } from "ws";
import { createBridgeSettingsRecipient, type BridgeSettingsRecipient } from "@showpilot/shared/bridge-settings";
import { BridgeTargetError, parseBridgeEndpoint, resolveBridgeEndpoints, type BridgeEndpoint } from "@showpilot/shared/bridge-target";
import { credentialFreeUrl } from "./transport-url.js";
import { Atem, type AtemState } from "atem-connection";
import { TcpConnection } from "./protocols/tcp.js";
import { UdpConnection } from "./protocols/udp.js";
import { decodeOscMessage, encodeOscMessage, type OscArg } from "./protocols/osc.js";
import {
  applyOscMixerMessage,
  createOscMixerState,
  mixerProbeAddress,
  mixerQueryAddresses,
  oscMixerEventPayload,
  type OscMixerConsole,
  type OscMixerState,
} from "./protocols/osc-mixer.js";
import { DmxConnection } from "./protocols/dmx.js";
import { ObsConnection } from "./protocols/obs.js";
import { PjlinkConnection } from "./protocols/pjlink.js";
import { frameViscaPacket, inspectViscaReply, type ViscaUdpMode } from "./protocols/visca.js";
import {
  ProPresenterBridge,
  type PPBridgeDebugState,
} from "./protocols/propresenter.js";
import { BRIDGE_VERSION } from "./version.js";
import { LocalShowStore } from "./local-show-store.js";
import { LocalShowManager } from "./local-show-manager.js";
import { LocalShowError, parsePreparedLocalShow, type PreparedLocalShow, type LocalShowAction } from "./local-show-model.js";
import type { LocalShowRequest } from "./local-show-control.js";

interface BridgeOptions {
  url: string;
  key?: string;
  reconnect?: boolean;
  propresenter?: {
    host: string;
    port?: number;
    apiPort?: number;
    password?: string;
  };
}

interface CommandMessage {
  type: "command";
  id: string;
  protocol: string;
  target: string;
  command: string;
  settings?: Record<string, unknown>;
}

interface ReservedProPresenterMessage {
  type: "prepare-propresenter-command" | "execute-propresenter-command";
  id: string; reservationId: string; target: string; command: "next" | "previous" | "clear";
}

interface DeviceConnectionInput {
  type: "connect-device";
  protocol: string;
  target: string;
  settings: Record<string, unknown>;
}

interface ConnectDeviceMessage extends Omit<DeviceConnectionInput, "settings"> {
  protectedSettings: unknown;
}

interface DisconnectDeviceMessage {
  type: "disconnect-device";
  target: string;
}

type ConnectionApprovalRequest =
  | { type: "command-connection-requested"; id: string }
  | { type: "automatic-connection-requested"; target: string; apiPort: number };

interface BridgeRoleMessage {
  type: "bridge-role";
  role: "active" | "standby";
  selectionId?: string;
  activeInstallation: { installationId: string; label: string } | null;
  approvedTargets: BridgeEndpoint[];
  orgId: string;
  installationId: string;
}

interface BridgePolicyMessage {
  type: "bridge-policy";
  policyId: string;
  approvedTargets: BridgeEndpoint[];
}

interface PingMessage {
  type: "ping";
}

interface PrepareLocalShowMessage {
  type: "prepare-local-show";
  id: string;
  showId: string;
  protectedSettings: unknown;
}

const CONNECT_DEVICE_PROTOCOLS = new Set([
  "propresenter",
  "http-command",
  "atem",
  "dmx-artnet",
  "dmx-sacn",
  "obs",
  "tcp-command",
  "pjlink",
  "osc",
  "udp",
  "visca-ip",
]);

export function isSupportedConnectProtocol(protocol: string): boolean {
  return CONNECT_DEVICE_PROTOCOLS.has(protocol);
}

export function connectedBridgeTargets(...groups: Iterable<string>[]): string[] {
  return [...new Set(groups.flatMap((group) => [...group]))].sort();
}

type IncomingMessage = ReservedProPresenterMessage | CommandMessage | ConnectDeviceMessage | DisconnectDeviceMessage | PingMessage | BridgeRoleMessage | BridgePolicyMessage | PrepareLocalShowMessage;

function endpointKey(endpoint: BridgeEndpoint): string {
  return JSON.stringify([endpoint.protocol, endpoint.host, endpoint.port]);
}

function parseApprovedTargets(value: unknown): BridgeEndpoint[] {
  if (!Array.isArray(value)) return [];
  // A malformed policy grants nothing; never retain a stale approval snapshot.
  try { return value.map(parseBridgeEndpoint); }
  catch { return []; }
}

function networkAddress(target: string) {
  const [endpoint] = resolveBridgeEndpoints({ type: "connect-device", protocol: "tcp-command", target });
  return { host: endpoint.host.replace(/^\[|\]$/g, ""), port: endpoint.port };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIncomingMessage(value: unknown): IncomingMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "prepare-propresenter-command":
    case "execute-propresenter-command":
      return typeof value.id === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value.id)
        && typeof value.reservationId === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value.reservationId)
        && typeof value.target === "string" && value.target.length <= 300
        && (value.command === "next" || value.command === "previous" || value.command === "clear")
        ? { type: value.type, id: value.id, reservationId: value.reservationId, target: value.target, command: value.command } : null;
    case "prepare-local-show":
      return typeof value.id === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value.id)
        && typeof value.showId === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value.showId)
        ? {type:value.type,id:value.id,showId:value.showId,protectedSettings:value.protectedSettings} : null;
    case "command":
      return typeof value.id === "string"
        && typeof value.protocol === "string"
        && typeof value.target === "string"
        && typeof value.command === "string"
        ? { type: value.type, id: value.id, protocol: value.protocol, target: value.target, command: value.command }
        : null;
    case "connect-device":
      return typeof value.protocol === "string"
        && typeof value.target === "string"
        ? { type: value.type, protocol: value.protocol, target: value.target, protectedSettings: value.protectedSettings }
        : null;
    case "disconnect-device":
      return typeof value.target === "string" ? { type: value.type, target: value.target } : null;
    case "ping":
      return { type: value.type };
    case "bridge-policy":
      return typeof value.policyId === "string"
        ? { type: value.type, policyId: value.policyId, approvedTargets: parseApprovedTargets(value.approvedTargets) }
        : null;
    case "bridge-role": {
      if (value.role !== "active" && value.role !== "standby") return null;
      if (typeof value.orgId !== "string" || !value.orgId || typeof value.installationId !== "string" || !value.installationId) return null;
      if (value.selectionId !== undefined && typeof value.selectionId !== "string") return null;
      const active = value.activeInstallation;
      if (active !== null && (!isRecord(active) || typeof active.installationId !== "string" || typeof active.label !== "string")) return null;
      return { type: value.type, role: value.role, orgId: value.orgId, installationId: value.installationId, selectionId: value.selectionId, approvedTargets: parseApprovedTargets(value.approvedTargets),
        activeInstallation: active === null ? null : { installationId: String(active.installationId), label: String(active.label) } };
    }
    default:
      return null;
  }
}

export function bridgeWebSocketOptions(
  url: string,
  key?: string,
  settingsPublicKey?: string,
): { url: string; options?: ClientOptions } {
  const wsUrlObject = credentialFreeUrl(url);
  wsUrlObject.searchParams.set("role", "bridge");
  wsUrlObject.searchParams.delete("key");
  return {
    url: wsUrlObject.toString(),
    options: { headers: { "x-showpilot-bridge-policy": "3", ...(settingsPublicKey ? { "x-showpilot-settings-key": settingsPublicKey } : {}), ...(key ? { "x-showpilot-api-key": key } : {}) } },
  };
}

export function shouldReconnectBridge(code: number): boolean {
  return code !== 4410;
}

/**
 * ShowPilot Bridge — connects to ShowPilot cloud via WebSocket
 * and proxies commands to local network devices.
 */
export class Bridge {
  private readonly ppReservations = new ProPresenterReservations();
  private commandSource: "cloud" | "entering-local" | "local" | "local-held" | "leaving-local" | "stopped" = "cloud";
  private localStore: LocalShowStore | null = null;
  private localShow: LocalShowManager | null = null;
  private localScope: Pick<BridgeRoleMessage, "orgId" | "installationId"> | null = null;
  private deviceGeneration = 0;
  private ws: WebSocket | null = null;
  private role: "waiting" | "active" | "standby" = "waiting";
  private activeInstallation: BridgeRoleMessage["activeInstallation"] = null;
  private messageWork: Promise<void> = Promise.resolve();
  private settingsRecipient: BridgeSettingsRecipient | null = null;
  private settingsScope: Pick<BridgeRoleMessage, "orgId" | "installationId"> | null = null;
  private connectionAttempt = 0;
  private pendingConnectionApproval: {
    socket: WebSocket;
    request: ConnectionApprovalRequest;
    requestId: string;
    finish: (approved: boolean) => void;
  } | null = null;
  private approvedTargets = new Map<string, BridgeEndpoint>();
  private connectionEndpoints = new Map<string, BridgeEndpoint[]>();
  private url: string;
  private key: string | undefined;
  private reconnect: boolean;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tcpConnections = new Map<string, TcpConnection>();
  private udpConnections = new Map<string, UdpConnection>();
  private viscaModes = new Map<string, ViscaUdpMode>();
  private viscaSequences = new Map<string, number>();
  private ppConnections = new Map<string, ProPresenterBridge>();
  private atemConnections = new Map<string, Atem>();
  private dmxConnections = new Map<string, DmxConnection>();
  private obsConnections = new Map<string, ObsConnection>();
  private pjlinkConnections = new Map<string, PjlinkConnection>();
  private httpDeviceSettings = new Map<string, Record<string, unknown>>();
  private oscMixerStates = new Map<string, OscMixerState>();
  private oscMixerListeners = new Map<string, () => void>();
  private oscMixerPollers = new Map<string, NodeJS.Timeout>();
  private oscMixerFlushTimers = new Map<string, NodeJS.Timeout>();
  private startTime = Date.now();
  private propresenter?: BridgeOptions["propresenter"];

  constructor(options: BridgeOptions) {
    this.url = options.url;
    this.key = options.key;
    this.reconnect = options.reconnect ?? true;
    this.propresenter = options.propresenter;
  }

  /** The parent chooses a credential-scoped cache path before cloud startup. */
  configureLocalShow(store: LocalShowStore): void {
    if (this.localStore || this.ws) throw new LocalShowError("Configure local storage before starting Bridge.");
    this.localStore=store;
    const saved=store.load();
    if(saved===null)return;
    if(!isRecord(saved))throw new LocalShowError("The saved local show cannot be read. Keep the cache for recovery.");
    const prepared=parsePreparedLocalShow(saved.prepared);
    this.initializeLocalShow({orgId:prepared.orgId,installationId:prepared.installationId});
    if(this.localShow?.status().mode==='active')this.commandSource='local-held';
  }

  private initializeLocalShow(scope:Pick<BridgeRoleMessage,"orgId"|"installationId">): void {
    if(!this.localStore)return;
    if(this.localScope && (this.localScope.orgId!==scope.orgId || this.localScope.installationId!==scope.installationId))
      throw new LocalShowError("The cached show belongs to another workspace or Bridge installation.");
    if(this.localShow)return;
    this.localScope=scope;
    this.localShow=new LocalShowManager({store:this.localStore,scope,
      activate:prepared=>this.enterLocalControl(prepared),
      deactivate:()=>this.leaveLocalControl(),
      execute:action=>this.executeLocalAction(action),
    });
  }

  async handleLocalShow(request:LocalShowRequest):Promise<unknown> {
    if(this.commandSource==='stopped')throw new LocalShowError("The local device engine stopped. Start it before continuing.");
    if(!this.localStore)throw new LocalShowError("Local show storage is not configured by the desktop app.");
    if(request.operation==='status')return {...(this.localShow?.status()??{mode:'empty'}),installationId:this.localScope?.installationId??null,commandSource:this.commandSource};
    if(!this.localShow)throw new LocalShowError("Connect to ShowPilot and prepare a show before enabling local control.");
    const result=await this.localShow.handle(request);
    return {...result,installationId:this.localScope?.installationId??null,commandSource:this.commandSource};
  }

  private async waitForCloudWork():Promise<void> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([this.messageWork,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new LocalShowError("A previous cloud device command is still settling. Local control remains held; check the equipment and retry.")),12000);
      })]);
    } finally {clearTimeout(timer);}
  }

  private async enterLocalControl(prepared:PreparedLocalShow):Promise<void> {
    if(this.commandSource==='stopped')throw new LocalShowError("The local device engine has stopped.");
    if(this.ws?.readyState===WebSocket.OPEN && this.role!=='active')throw new LocalShowError("This Bridge is not the active installation. Select it in ShowPilot before enabling local control.");
    this.commandSource='entering-local';
    const generation=++this.deviceGeneration;
    this.connectionAttempt++;
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
    this.pendingConnectionApproval?.finish(false);
    const socket=this.ws;
    this.ws=null;
    socket?.close(1000,'Local show control enabled');
    this.settingsRecipient=null;
    this.settingsScope=null;
    this.role='waiting';
    try {
      await this.waitForCloudWork();
      await this.disconnectDevices();
      if(generation!==this.deviceGeneration)throw new LocalShowError("The local device engine stopped during the handoff.");
      await this.applyTargetPolicy(prepared.approvedTargets);
      if(generation!==this.deviceGeneration)throw new LocalShowError("The local device engine stopped during the handoff.");
      this.commandSource='local';
    } catch(error) {
      if(generation===this.deviceGeneration)this.commandSource='local-held';
      throw error;
    }
  }

  private async leaveLocalControl():Promise<void> {
    if(this.commandSource==='stopped')throw new LocalShowError("The local device engine has stopped.");
    this.commandSource='leaving-local';
    const generation=++this.deviceGeneration;
    await this.disconnectDevices();
    if(generation!==this.deviceGeneration)throw new LocalShowError("The local device engine stopped during the handoff.");
    this.approvedTargets.clear();
    this.commandSource='cloud';
    this.connect();
  }

  private async executeLocalAction(action:LocalShowAction):Promise<'acknowledged'|'sent'> {
    if(this.commandSource!=='local')throw new LocalShowError("Local device control is not enabled.");
    const generation=this.deviceGeneration;
    // Credentials come from the authenticated preparation, never native UI input.
    if(action.protocol!=='wol')await this.connectConfiguredDevice({type:'connect-device',protocol:action.protocol,target:action.target,settings:action.settings});
    if(this.commandSource!=='local'||generation!==this.deviceGeneration)throw new LocalShowError("Device ownership changed before the command was sent.");
    await this.executeDeviceCommand({type:'command',id:crypto.randomUUID(),protocol:action.protocol,target:action.target,command:action.command});
    return ['udp','osc','dmx-artnet','dmx-sacn','wol'].includes(action.protocol)?'sent':'acknowledged';
  }

  private async prepareLocalShow(msg:PrepareLocalShowMessage):Promise<void> {
    try {
      const socket=this.ws;
      if(!this.localShow || !this.settingsRecipient || !this.settingsScope)throw new LocalShowError("This Bridge does not have local show storage enabled.");
      const prepared=await this.settingsRecipient.open(msg.protectedSettings,{...this.settingsScope,protocol:'local-show',target:msg.showId});
      if(this.ws!==socket||socket?.readyState!==WebSocket.OPEN||this.role!=='active'||this.commandSource!=='cloud')throw new LocalShowError("The active Bridge changed while preparing the local show.");
      if(prepared.showId!==msg.showId)throw new LocalShowError("The prepared show does not match the requested show.");
      const approvedTargets=[...this.approvedTargets.values()];
      const result=this.localShow.prepare(prepared,approvedTargets);
      this.send({type:'local-show-prepared',id:msg.id,success:true,sessionId:'sessionId' in result?result.sessionId:null});
    } catch(error) {
      this.send({type:'local-show-prepared',id:msg.id,success:false,error:error instanceof LocalShowError?error.message:'Local show preparation could not be verified. Reconnect and try again.'});
    }
  }

  getStatus() {
    const propresenter: Record<string, PPBridgeDebugState> = {};
    for (const [target, bridge] of this.ppConnections.entries()) {
      propresenter[target] = bridge.getDebugState();
    }

    return {
      connectedToShowPilot: this.ws?.readyState === WebSocket.OPEN,
      role: this.role,
      activeInstallation: this.activeInstallation,
      propresenter,
    };
  }

  start(): void {
    this.connect();
  }

  feedTimecode(payload: {
    source?: "mtc" | "ltc-bridge";
    timecode: { hours: number; minutes: number; seconds: number; frames: number };
    format: { frameRate: 24 | 25 | 29.97 | 30; dropFrame: "df" | "ndf" };
    totalFrames: number;
  }): void {
    this.send({ type: "timecode-feed", ...payload });
  }

  transportTimecode(state: "stopped" | "waiting"): void {
    this.send({ type: "timecode-transport", state });
  }

  stop(): void {
    this.commandSource='stopped';
    this.deviceGeneration++;
    this.connectionAttempt++;
    this.settingsRecipient = null;
    this.settingsScope = null;
    this.reconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.role = "waiting";
    void this.disconnectDevices().catch(() => console.error("[bridge] Device shutdown failed"));
  }

  private async disconnectDevices(): Promise<void> {
    this.ppReservations.clear();
    this.pendingConnectionApproval?.finish(false);
    // Stop device output and polling when this installation becomes standby.
    for (const conn of this.ppConnections.values()) conn.disconnect();
    for (const conn of this.tcpConnections.values()) conn.disconnect();
    for (const conn of this.udpConnections.values()) conn.disconnect();
    const switcherShutdowns = [...this.atemConnections.values()].map(conn => conn.disconnect());
    for (const conn of this.dmxConnections.values()) conn.disconnect();
    for (const conn of this.obsConnections.values()) conn.disconnect();
    for (const conn of this.pjlinkConnections.values()) conn.disconnect();
    for (const unsubscribe of this.oscMixerListeners.values()) unsubscribe();
    for (const timer of this.oscMixerPollers.values()) clearInterval(timer);
    for (const timer of this.oscMixerFlushTimers.values()) clearTimeout(timer);
    this.ppConnections.clear();
    this.tcpConnections.clear();
    this.udpConnections.clear();
    this.atemConnections.clear();
    this.dmxConnections.clear();
    this.obsConnections.clear();
    this.pjlinkConnections.clear();
    this.oscMixerStates.clear();
    this.oscMixerListeners.clear();
    this.oscMixerPollers.clear();
    this.oscMixerFlushTimers.clear();
    this.httpDeviceSettings.clear();
    this.viscaModes.clear();
    this.viscaSequences.clear();
    this.connectionEndpoints.clear();
    await Promise.all(switcherShutdowns);
  }

  private connect(): void {
    if(this.commandSource!=='cloud')return;
    const attempt = ++this.connectionAttempt;
    this.settingsRecipient = null;
    this.settingsScope = null;
    void createBridgeSettingsRecipient().then(recipient => {
      if (this.connectionAttempt !== attempt) return;
      this.settingsRecipient = recipient;
      this.openConnection(recipient.publicKey);
    }).catch(() => {
      if (this.connectionAttempt !== attempt) return;
      console.error("[bridge] Unable to initialize protected device settings.");
      if (this.reconnect) this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    });
  }

  private openConnection(settingsPublicKey: string): void {
    const connection = bridgeWebSocketOptions(this.url, this.key, settingsPublicKey);
    console.log(`[bridge] Connecting to ${connection.url}...`);

    this.ws = new WebSocket(connection.url, connection.options);
    const socket = this.ws;

    this.ws.on("open", () => {
      console.log("[bridge] Connected to ShowPilot");
      this.sendStatus();
      this.role = "waiting";
      // Device connections start only after the server selects this installation.
    });

    this.ws.on("message", (data) => {
      try {
        const parsed: unknown = JSON.parse(data.toString());
        // The command queue waits for this receipt. Process only its exact,
        // socket-bound acknowledgement outside that queue to avoid deadlock.
        if (isRecord(parsed) && (parsed.type === "command-connection-approved" || parsed.type === "automatic-connection-approved")) {
          const pending = this.pendingConnectionApproval;
          const matches = pending?.request.type === "command-connection-requested"
            ? parsed.type === "command-connection-approved" && parsed.id === pending.request.id
            : parsed.type === "automatic-connection-approved";
          if (pending?.socket === socket && matches && parsed.requestId === pending.requestId) {
            pending.finish(parsed.approved === true);
          }
          return;
        }
        const message = parseIncomingMessage(parsed);
        if (message) {
          this.messageWork = this.messageWork.then(async () => {
            if (this.commandSource!=='cloud' || this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
            try { await this.handleMessage(message); }
            finally {
              if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) {
                this.role = "waiting";
                await this.disconnectDevices();
              }
            }
          }).catch((error) => {
            console.error("[bridge] Message handling failed:", error instanceof Error ? error.message : String(error));
          });
        }
      } catch {
        // Ignore
      }
    });

    this.ws.on("close", (code, reason) => {
      if (this.ws !== socket) return;
      if(code===4403 || code===4410) {
        try {this.localShow?.applyCloudPolicy([],false);}
        catch {console.error('[bridge] Local preparation could not record its revocation; local control remains unavailable.');}
      }
      this.ppReservations.clear();
      this.settingsRecipient = null;
      this.settingsScope = null;
      this.role = "waiting";
      void this.disconnectDevices().catch(() => console.error("[bridge] Device shutdown failed"));
      const detail = reason.toString().trim();
      if (code === 1002 && detail.toLowerCase().includes("expected 101")) {
        console.error(
          "[bridge] Connection rejected before WebSocket upgrade. Check the organization slug and Bridge API key.",
        );
      }
      console.log(
        `[bridge] Disconnected (code ${code}${detail ? `: ${detail}` : ""})`,
      );
      if (this.reconnect && shouldReconnectBridge(code)) {
        console.log("[bridge] Reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      } else if (code === 4410) {
        console.log("[bridge] Another connection uses this installation. Create a separate named Bridge key for each computer; select the active Bridge in ShowPilot settings.");
      }
    });

    this.ws.on("error", (err) => {
      if (err.message.includes("Unexpected server response: 426")) {
        this.reconnect = false;
        console.error("[bridge] This server requires a newer Bridge device-policy protocol. Update ShowPilot Desktop or Bridge before reconnecting.");
        return;
      }
      if (err.message.includes("Unexpected server response: 401")) {
        console.error(
          "[bridge] Authentication failed (HTTP 401). Check the organization slug and Bridge API key.",
        );
        return;
      }
      const responseMatch = err.message.match(
        /Unexpected server response: (\d+)/,
      );
      if (responseMatch) {
        console.error(
          `[bridge] Connection rejected (HTTP ${responseMatch[1]}). Check the ShowPilot site URL and organization slug.`,
        );
        return;
      }
      console.error("[bridge] WebSocket error:", err.message);
    });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type === "bridge-policy") {
      await this.applyTargetPolicy(msg.approvedTargets);
      if(this.role==='active'||this.role==='standby')this.localShow?.applyCloudPolicy(msg.approvedTargets,this.role==='active');
      this.send({ type: "bridge-policy-applied", policyId: msg.policyId });
      if (this.role === "active") await this.ensureProPresenterConnection();
      return;
    }
    if (msg.type === "bridge-role") {
      const changed = this.role !== msg.role;
      if (changed) this.ppReservations.clear();
      await this.applyTargetPolicy(msg.approvedTargets);
      this.role = msg.role;
      this.settingsScope = { orgId: msg.orgId, installationId: msg.installationId };
      this.initializeLocalShow(this.settingsScope);
      this.localShow?.applyCloudPolicy(msg.approvedTargets,msg.role==='active');
      this.activeInstallation = msg.activeInstallation;
      if (msg.role === "standby") {
        await this.disconnectDevices();
        console.log(`[bridge] STANDBY. ${msg.activeInstallation?.label ?? "Another installation"} controls venue devices. Use ShowPilot settings to take control.`);
      } else if (changed) {
        console.log("[bridge] ACTIVE. This installation controls venue devices.");
        await this.ensureProPresenterConnection();
        for (const pp of this.ppConnections.values()) pp.replayCurrentSlide();
      }
      if (msg.selectionId) this.send({ type: "bridge-role-applied", role: msg.role, selectionId: msg.selectionId });
      this.sendStatus();
      return;
    }
    if (msg.type !== "ping" && this.role !== "active") return;
    switch (msg.type) {
      case "prepare-propresenter-command":
      case "execute-propresenter-command":
        await this.handleReservedProPresenterCommand(msg);
        break;
      case "prepare-local-show":
        await this.prepareLocalShow(msg);
        break;
      case "command":
        await this.handleCommand(msg);
        break;
      case "connect-device":
        await this.handleConnectDevice(msg);
        break;
      case "disconnect-device":
        await this.handleDisconnectDevice(msg);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private async applyTargetPolicy(endpoints: BridgeEndpoint[]): Promise<void> {
    this.approvedTargets = new Map(endpoints.map(endpoint => [endpointKey(endpoint), endpoint]));
    for (const [target, connected] of this.connectionEndpoints) {
      if (!connected.every(endpoint => this.approvedTargets.has(endpointKey(endpoint)))) {
        await this.handleDisconnectDevice({ target });
      }
    }
  }

  private async authorizeDestination(msg: CommandMessage | DeviceConnectionInput): Promise<void> {
    const endpoints = resolveBridgeEndpoints(msg);
    const connected = this.connectionEndpoints.get(msg.target);
    const effective = msg.type === "command" && connected ? [...endpoints, ...connected] : endpoints;
    if (!effective.every(endpoint => this.approvedTargets.has(endpointKey(endpoint)))) throw new BridgeTargetError("unapproved-target");
    if (connected && msg.type === "connect-device"
      // ProPresenter replaces its instance after comparing private settings,
      // suppressing old callbacks until the replacement has an actual result.
      && msg.protocol !== "propresenter"
      && connected.map(endpointKey).join() !== endpoints.map(endpointKey).join()) {
      await this.handleDisconnectDevice({ target: msg.target });
    }
    // Keep actual connection destinations, including PP's API port. A later
    // command cannot replace that metadata with its primary port alone.
    this.connectionEndpoints.set(msg.target, msg.type === "connect-device" ? endpoints
      : [...new Map(effective.map(endpoint => [endpointKey(endpoint), endpoint])).values()]);
  }

  private async handleReservedProPresenterCommand(msg: ReservedProPresenterMessage): Promise<void> {
    let invoked = false;
    try {
      const socket = this.ws;
      await this.authorizeDestination({ type: "command", id: msg.id, protocol: "propresenter", target: msg.target, command: msg.command });
      if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN || this.role !== "active") throw new Error("Bridge ownership changed before the slide command.");
      if (msg.type === "prepare-propresenter-command") this.ppReservations.reserve(msg.reservationId, msg.target, msg.command);
      else {
        const beforeMutation = this.ppReservations.take(msg.reservationId, msg.target, msg.command);
        invoked = true;
        await this.executePPCommand(msg.target, msg.command, beforeMutation);
      }
      this.send({ type: "command-response", id: msg.id, success: true });
    } catch (error) {
      this.send({ type: "command-response", id: msg.id, success: false, notExecuted: !invoked,
        error: error instanceof Error ? error.message : "Slide command could not be confirmed." });
    }
  }

  private async handleCommand(msg: CommandMessage): Promise<void> {
    try {
      const response = await this.executeDeviceCommand(msg);

      this.send({
        type: "command-response",
        id: msg.id,
        success: true,
        response: response ?? undefined,
      });
    } catch (err) {
      this.send({
        type: "command-response",
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeDeviceCommand(msg: CommandMessage): Promise<string | void> {
      await this.authorizeDestination(msg);
      let response: string | void = undefined;

      switch (msg.protocol) {
        case "tcp-command":
          response = await this.executeTcpCommand(msg);
          break;
        case "pjlink":
          response = await this.executePjlinkCommand(msg.target, msg.command);
          break;
        case "osc":
          await this.executeOscCommand(msg);
          break;
        case "http-command":
          response = await this.executeHttpCommand(msg);
          break;
        case "udp":
          await this.executeUdpCommand(msg);
          break;
        case "visca-ip":
          await this.executeViscaCommand(msg.target, msg.command);
          break;
        case "propresenter":
          response = await this.executePPCommand(msg.target, msg.command);
          break;
        case "atem":
          await this.executeAtemCommand(msg.target, msg.command);
          break;
        case "dmx-artnet":
        case "dmx-sacn":
          await this.executeDmxCommand(msg.target, msg.command);
          break;
        case "obs":
          await this.executeObsCommand(msg.target, msg.command);
          break;
        case "wol":
          await this.executeWol(msg);
          break;
        default:
          throw new Error(`Unknown protocol: ${msg.protocol}`);
      }

      return response;
  }

  private async handleConnectDevice(msg: ConnectDeviceMessage): Promise<void> {
    const key = msg.target;

    try {
      const socket = this.ws;
      if (!this.settingsRecipient || !this.settingsScope) throw new Error("Protected Bridge settings are unavailable.");
      const settings = await this.settingsRecipient.open(msg.protectedSettings, { ...this.settingsScope, protocol: msg.protocol, target: msg.target });
      if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN || this.role !== "active") throw new Error("Bridge disconnected before device configuration.");
      const configured: DeviceConnectionInput = { type: "connect-device", protocol: msg.protocol, target: msg.target, settings };
      await this.connectConfiguredDevice(configured);
    } catch (err) {
      console.error(
        `[bridge] ${msg.protocol} connection to ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.send({
        type: "device-status",
        target: key,
        connected: false,
      });
      this.sendStatus();
    }
  }

  private async connectConfiguredDevice(msg: DeviceConnectionInput): Promise<void> {
    const key = msg.target;
    const settings = msg.settings;
    const configured = msg;
    try {
      await this.authorizeDestination(configured);
      const [endpoint] = resolveBridgeEndpoints(configured);
      const host = endpoint.host.replace(/^\[|\]$/g, "");
      const port = endpoint.port;
      if (!isSupportedConnectProtocol(msg.protocol)) {
        throw new Error(`Unknown protocol: ${msg.protocol}`);
      }

      if (msg.protocol === "propresenter") {
        await this.connectProPresenter(key, settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "http-command") {
        this.httpDeviceSettings.set(key, settings ?? {});
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "atem") {
        await this.connectAtem(key, settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "obs") {
        await this.connectObs(key, settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "dmx-artnet" || msg.protocol === "dmx-sacn") {
        await this.connectDmx(msg.protocol, key, host, port, settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "pjlink") {
        const existing = this.pjlinkConnections.get(key);
        if (existing && !existing.isConnected()) {
          existing.disconnect();
          this.pjlinkConnections.delete(key);
        }
        if (!this.pjlinkConnections.has(key)) {
          const conn = new PjlinkConnection();
          const password = typeof settings.password === "string" ? settings.password : undefined;
          await conn.connect(host, port, password);
          this.pjlinkConnections.set(key, conn);
        }
      } else if (msg.protocol === "tcp-command") {
        const existing = this.tcpConnections.get(key);
        if (existing && !existing.isConnected()) {
          existing.disconnect();
          this.tcpConnections.delete(key);
        }
        if (!this.tcpConnections.has(key)) {
          const conn = new TcpConnection();
          await conn.connect(host, port);
          this.tcpConnections.set(key, conn);
        }
      } else if (msg.protocol === "osc") {
        let conn = this.udpConnections.get(key);
        if (!conn) {
          conn = new UdpConnection();
          await conn.connect(host, port);
          this.udpConnections.set(key, conn);
        }
        await this.configureOscMixerFeedback(key, conn, settings);
      } else if (msg.protocol === "udp") {
        if (!this.udpConnections.has(key)) {
          const conn = new UdpConnection();
          await conn.connect(host, port);
          this.udpConnections.set(key, conn);
        }
      } else if (msg.protocol === "visca-ip") {
        let conn = this.udpConnections.get(key);
        if (!conn) {
          conn = new UdpConnection();
          await conn.connect(host, port);
          this.udpConnections.set(key, conn);
        }
        const mode: ViscaUdpMode = settings.viscaMode === "raw" ? "raw" : "sony-ip";
        const sequence = this.nextViscaSequence(key);
        const inquiry = Buffer.from("81090400ff", "hex");
        await conn.sendAndReceiveUntil(
          frameViscaPacket(inquiry, mode, sequence, true),
          (reply) => inspectViscaReply(reply, mode, sequence) === "complete",
        );
        this.viscaModes.set(key, mode);
      }

      this.send({ type: "device-status", target: key, connected: true });
      this.sendStatus();
    } catch (err) {
      if (msg.protocol === "osc") {
        this.teardownOscMixerFeedback(key);
        const connection = this.udpConnections.get(key);
        connection?.disconnect();
        this.udpConnections.delete(key);
      }
      if (msg.protocol === "visca-ip") {
        this.udpConnections.get(key)?.disconnect();
        this.udpConnections.delete(key);
        this.viscaModes.delete(key);
        this.viscaSequences.delete(key);
      }
      throw err;
    }
  }

  private async handleDisconnectDevice(msg: { target: string }): Promise<void> {
    this.teardownOscMixerFeedback(msg.target);
    const pp = this.ppConnections.get(msg.target);
    if (pp) {
      this.ppReservations.clear();
      pp.disconnect();
      this.ppConnections.delete(msg.target);
    }
    const tcp = this.tcpConnections.get(msg.target);
    if (tcp) {
      tcp.disconnect();
      this.tcpConnections.delete(msg.target);
    }
    const udp = this.udpConnections.get(msg.target);
    if (udp) {
      udp.disconnect();
      this.udpConnections.delete(msg.target);
    }
    this.viscaModes.delete(msg.target);
    this.viscaSequences.delete(msg.target);
    const atem = this.atemConnections.get(msg.target);
    if (atem) {
      await atem.disconnect();
      this.atemConnections.delete(msg.target);
    }
    const dmx = this.dmxConnections.get(msg.target);
    if (dmx) {
      dmx.disconnect();
      this.dmxConnections.delete(msg.target);
    }
    const obs = this.obsConnections.get(msg.target);
    if (obs) {
      obs.disconnect();
      this.obsConnections.delete(msg.target);
    }
    const pjlink = this.pjlinkConnections.get(msg.target);
    if (pjlink) {
      pjlink.disconnect();
      this.pjlinkConnections.delete(msg.target);
    }
    this.httpDeviceSettings.delete(msg.target);
    this.connectionEndpoints.delete(msg.target);
    this.send({ type: "device-status", target: msg.target, connected: false });
    this.sendStatus();
  }

  // ─── Protocol Execution ─────────────────────────────────

  private async executePPCommand(
    target: string,
    command: string,
    beforeMutation?: () => void,
  ): Promise<string | void> {
    const pp = this.ppConnections.get(target);
    if (!pp) throw new Error("ProPresenter is not connected");
    return pp.sendCommand(command, beforeMutation);
  }

  private async connectAtem(
    target: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    if (this.atemConnections.has(target)) return;

    const { host, port } = networkAddress(target);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("ATEM host and port are required");
    }

    // The desktop Bridge is compiled into a single Bun executable. Atem's
    // default threaded transport tries to load a sibling worker module at
    // runtime, which does not exist beside that executable and makes every
    // packaged ATEM connection fail immediately. The Bridge is already an
    // isolated sidecar process, so keep the ATEM socket in-process.
    const atem = new Atem({ disableMultithreaded: true });
    atem.on("connected", () => {
      this.send({ type: "device-status", target, connected: true });
      if (atem.state) this.sendAtemState(target, atem, atem.state);
    });
    atem.on("disconnected", () => {
      this.send({ type: "device-status", target, connected: false });
    });
    atem.on("stateChanged", (state) => this.sendAtemState(target, atem, state));
    atem.on("error", (message) => console.error(`[atem:${target}] ${message}`));

    try {
      await atem.connect(host, port);
      this.atemConnections.set(target, atem);
    } catch (error) {
      await atem.destroy().catch(() => {});
      throw error;
    }
  }

  private sendAtemState(target: string, atem: Atem, state: AtemState): void {
    const mixEffect = state.video.mixEffects[0];
    if (!mixEffect) return;
    this.send({
      type: "device-event",
      target,
      eventName: "atem-state",
      data: JSON.stringify({
        programInput: mixEffect.programInput,
        previewInput: mixEffect.previewInput,
        transitionPosition: mixEffect.transitionPosition.handlePosition,
        ftbActive: Boolean(
          mixEffect.fadeToBlack?.isFullyBlack ||
          mixEffect.fadeToBlack?.inTransition,
        ),
        tallyProgram: atem.listVisibleInputs("program"),
        tallyPreview: atem.listVisibleInputs("preview"),
      }),
    });
  }

  private async executeAtemCommand(
    target: string,
    command: string,
  ): Promise<void> {
    const atem = this.atemConnections.get(target);
    if (!atem) throw new Error("ATEM is not connected");

    let payload: unknown;
    try {
      payload = JSON.parse(command);
    } catch {
      throw new Error("Invalid ATEM command payload");
    }
    if (!isRecord(payload)) throw new Error("Invalid ATEM command payload");
    if (typeof payload.actionId !== "string")
      throw new Error("ATEM action is required");
    const params = isRecord(payload.params) ? payload.params : {};
    const integer = (name: string, minimum = 0) => {
      const value = Number(params[name]);
      if (!Number.isInteger(value) || value < minimum)
        throw new Error(`Invalid ATEM ${name}`);
      return value;
    };

    switch (payload.actionId) {
      case "set_program_input":
        await atem.changeProgramInput(integer("input", 1));
        return;
      case "set_preview_input":
        await atem.changePreviewInput(integer("input", 1));
        return;
      case "cut":
        await atem.cut();
        return;
      case "auto_transition":
        await atem.autoTransition();
        return;
      case "fade_to_black":
        await atem.fadeToBlack();
        return;
      case "run_macro":
        await atem.macroRun(integer("macro"));
        return;
      case "set_aux_source":
        await atem.setAuxSource(integer("source", 1), integer("aux", 1) - 1);
        return;
      case "toggle_downstream_key": {
        const key = integer("key", 1) - 1;
        const onAir = atem.state?.video.downstreamKeyers[key]?.onAir ?? false;
        await atem.setDownstreamKeyOnAir(!onAir, key);
        return;
      }
      default:
        throw new Error(`Unknown ATEM action: ${payload.actionId}`);
    }
  }

  private async connectObs(target: string, settings: Record<string, unknown>): Promise<void> {
    const existing = this.obsConnections.get(target);
    if (existing?.isConnected()) return;
    const [endpoint] = resolveBridgeEndpoints({ type: "connect-device", protocol: "obs", target, settings });
    const { host, port } = endpoint;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OBS host and port are required");
    const connection = new ObsConnection();
    this.obsConnections.set(target, connection);
    try {
      await connection.connect({
        host,
        port,
        password: typeof settings.password === "string" ? settings.password : undefined,
        onState: (state) => this.send({ type: "device-event", target, eventName: "obs-state", data: JSON.stringify(state) }),
        onDisconnected: () => {
          this.obsConnections.delete(target);
          this.send({ type: "device-status", target, connected: false });
          this.sendStatus();
        },
      });
    } catch (error) {
      this.obsConnections.delete(target);
      connection.disconnect();
      throw error;
    }
  }

  private async executeObsCommand(target: string, command: string): Promise<void> {
    const connection = this.obsConnections.get(target);
    if (!connection?.isConnected()) throw new Error("OBS is not connected");
    let payload: unknown;
    try {
      payload = JSON.parse(command);
    } catch {
      throw new Error("Invalid OBS command payload");
    }
    if (!isRecord(payload)) throw new Error("Invalid OBS command payload");
    const commandPayload = payload;
    if (typeof commandPayload.actionId !== "string") throw new Error("OBS action is required");
    const params = isRecord(commandPayload.params) ? commandPayload.params : {};
    await connection.executeAction(commandPayload.actionId, params);
  }

  private async connectDmx(
    protocol: "dmx-artnet" | "dmx-sacn",
    target: string,
    host: string,
    port: number,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.dmxConnections.get(target);
    if (existing?.isConnected()) return;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("DMX host and port are required");
    const connection = new DmxConnection(protocol, (state) => {
      this.send({ type: "device-event", target, eventName: "dmx-state", data: JSON.stringify(state) });
    });
    await connection.connect(host, port, settings);
    this.dmxConnections.set(target, connection);
  }

  private async executeDmxCommand(target: string, command: string): Promise<void> {
    const connection = this.dmxConnections.get(target);
    if (!connection?.isConnected()) throw new Error("DMX output is not connected");
    let payload: unknown;
    try {
      payload = JSON.parse(command);
    } catch {
      throw new Error("Invalid DMX command payload");
    }
    if (!isRecord(payload)) throw new Error("Invalid DMX command payload");
    const commandPayload = payload;
    if (typeof commandPayload.actionId !== "string") throw new Error("DMX action is required");
    const params = isRecord(commandPayload.params) ? commandPayload.params : {};
    await connection.executeAction(commandPayload.actionId, params);
  }

  private async ensureProPresenterConnection(): Promise<void> {
    if (!this.propresenter?.host) {
      this.send({ type: "configured-propresenter-requested" });
      return;
    }

    const effectivePort =
      this.propresenter.port ?? this.propresenter.apiPort ?? 1025;
    const target = `propresenter:${this.propresenter.host}:${effectivePort}`;
    if (this.ppConnections.has(target)) return;

    const settings = {
      host: this.propresenter.host,
      port: effectivePort,
      apiPort: this.propresenter.apiPort,
      password: this.propresenter.password,
    };
    try {
      await this.authorizeDestination({ type: "connect-device", protocol: "propresenter", target, settings });
    } catch (error) {
      if (!(error instanceof BridgeTargetError)) throw error;
      console.log("[pp-bridge] Waiting for administrator approval of the configured ProPresenter ports.");
      return;
    }
    // Wait until the relay records the authenticated installation. Local
    // ProPresenter passwords never leave the native process in this request.
    try {
      await this.requestConnectionApproval({ type: "automatic-connection-requested", target, apiPort: settings.apiPort ?? 1025 });
      await this.authorizeDestination({ type: "connect-device", protocol: "propresenter", target, settings });
    } catch {
      console.error("[pp-bridge] Automatic connection was not approved and recorded. Check Bridge connectivity and destination approvals.");
      this.send({ type: "device-status", target, connected: false });
      return;
    }
    await this.connectProPresenter(target, settings);
  }

  private async connectProPresenter(
    target: string,
    settings?: Record<string, unknown>,
  ): Promise<void> {
    const endpoints = resolveBridgeEndpoints({ type: "connect-device", protocol: "propresenter", target, settings });
    const ppHost = endpoints[0].host;
    const ppPort = endpoints[0].port;
    const ppApiPort = endpoints[1]?.port ?? ppPort;
    if (!ppHost || !Number.isFinite(ppPort) || ppPort <= 0) {
      throw new Error("ProPresenter host and port are required");
    }

    const password = typeof settings?.password === "string" ? settings.password : "";
    const existing = this.ppConnections.get(target);
    if (existing?.matchesConnection({ host: ppHost, port: ppPort, apiPort: ppApiPort, password })) {
      await existing.waitUntilReady();
      return;
    }
    this.ppReservations.clear();
    if (existing) {
      // Detach before closing so old status/slide callbacks cannot resolve the
      // replacement connection or clear its last confirmed browser preview.
      this.ppConnections.delete(target);
      existing.disconnect();
    }
    const pp = new ProPresenterBridge({
      host: ppHost,
      port: ppPort,
      apiPort:
        Number.isFinite(ppApiPort) && ppApiPort > 0 ? ppApiPort : undefined,
      password,
      onSlideChange: (data) => {
        if (this.ppConnections.get(target) !== pp) return;
        if (!data) {
          console.log("[pp-bridge] Clearing forwarded slide");
          this.send({
            type: "device-event",
            target,
            eventName: "slide",
            data: "null",
          });
          return;
        }
        const text = typeof data.text === "string" ? data.text : "";
        console.log(
          `[pp-bridge] Forwarding slide: ${text.slice(0, 80).replace(/\s+/g, " ")}`,
        );
        this.send({
          type: "device-event",
          target,
          eventName: "slide",
          data: JSON.stringify(data),
        });
      },
      onStatusChange: (connected) => {
        if (this.ppConnections.get(target) !== pp) return;
        this.send({ type: "device-status", target, connected });
      },
    });
    this.ppConnections.set(target, pp);
    pp.connect();
    try {
      await pp.waitUntilReady();
    } catch (error) {
      pp.disconnect();
      this.ppConnections.delete(target);
      throw error;
    }
  }

  private async requestCommandConnection(msg: CommandMessage): Promise<void> {
    if(this.commandSource==='local') {await this.authorizeDestination(msg);return;}
    await this.requestConnectionApproval({ type: "command-connection-requested", id: msg.id });
    await this.authorizeDestination(msg);
  }

  private async requestConnectionApproval(request: ConnectionApprovalRequest): Promise<void> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.role !== "active") throw new Error("Bridge connection approval unavailable");
    const requestId = crypto.randomUUID();
    const approved = await new Promise<boolean>(resolve => {
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        this.pendingConnectionApproval = null;
        resolve(allowed);
      };
      const timer = setTimeout(() => finish(false), 3000);
      this.pendingConnectionApproval = { socket, request, requestId, finish };
      try { socket.send(JSON.stringify({ ...request, requestId })); }
      catch { finish(false); }
    });
    if (!approved || this.ws !== socket || socket.readyState !== WebSocket.OPEN || this.role !== "active") {
      throw new Error("Device connection was not approved and recorded. Retry after checking Bridge connectivity and destination approvals.");
    }
  }

  private async executeTcpCommand(msg: CommandMessage): Promise<string> {
    const { target, command } = msg;
    let conn = this.tcpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      await this.requestCommandConnection(msg);
      conn?.disconnect();
      const { host, port } = networkAddress(target);
      conn = new TcpConnection();
      await conn.connect(host, port);
      this.tcpConnections.set(target, conn);
      this.sendStatus();
    }
    return await conn.sendCommand(command);
  }

  private async executePjlinkCommand(target: string, command: string): Promise<string> {
    const connection = this.pjlinkConnections.get(target);
    if (!connection?.isConnected()) throw new Error("PJLink is not connected");
    return await connection.sendCommand(command);
  }

  private async executeOscCommand(msg: CommandMessage): Promise<void> {
    const { target, command } = msg;
    let conn = this.udpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      await this.requestCommandConnection(msg);
      conn?.disconnect();
      const { host, port } = networkAddress(target);
      conn = new UdpConnection();
      await conn.connect(host, port);
      this.udpConnections.set(target, conn);
      this.sendStatus();
    }

    // Parse OSC command: "/address type:value type:value"
    // e.g., "/ch/01/mix/fader f:0.75" or "/ch/01/mix/on i:1"
    const parts = command.trim().split(/\s+/);
    const address = parts[0];
    const args: OscArg[] = parts.slice(1).map((p) => {
      const [type, val] = p.split(":");
      if (type === "f") return { type: "f" as const, value: parseFloat(val) };
      if (type === "i") return { type: "i" as const, value: parseInt(val, 10) };
      return { type: "s" as const, value: val };
    });

    const buf = encodeOscMessage(address, args);
    await conn.send(buf);
  }

  private async configureOscMixerFeedback(
    target: string,
    connection: UdpConnection,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const consoleName = typeof settings.consoleName === "string" ? settings.consoleName.toLowerCase() : "";
    if (consoleName !== "x32" && consoleName !== "wing") return;
    const consoleType: OscMixerConsole = consoleName;

    this.teardownOscMixerFeedback(target);
    const probe = encodeOscMessage(mixerProbeAddress(consoleType), []);
    try {
      const response = decodeOscMessage(await connection.sendAndReceive(probe));
      if (response.address !== mixerProbeAddress(consoleType)) throw new Error("Unexpected OSC response");
    } catch {
      throw new Error(`${consoleType === "wing" ? "WING" : "X32/M32"} did not answer the OSC connection check`);
    }

    const state = createOscMixerState(consoleType);
    this.oscMixerStates.set(target, state);
    const unsubscribe = connection.onMessage((data) => {
      try {
        const message = decodeOscMessage(data);
        if (applyOscMixerMessage(state, consoleType, message)) this.scheduleOscMixerEvent(target, state);
      } catch {
        // Other OSC traffic and bundles are unrelated to the channel surface.
      }
    });
    this.oscMixerListeners.set(target, unsubscribe);

    if (consoleType === "x32") await connection.send(encodeOscMessage("/xremote", []));
    this.queryOscMixerStateSafely(target, connection, consoleType);
    const poller = setInterval(() => {
      if (consoleType === "x32") void connection.send(encodeOscMessage("/xremote", [])).catch(() => {});
      this.queryOscMixerStateSafely(target, connection, consoleType);
    }, consoleType === "x32" ? 8_000 : 5_000);
    this.oscMixerPollers.set(target, poller);
  }

  private async queryOscMixerState(connection: UdpConnection, consoleType: OscMixerConsole): Promise<void> {
    for (const address of mixerQueryAddresses(consoleType)) {
      await connection.send(encodeOscMessage(address, []));
    }
  }

  private queryOscMixerStateSafely(
    target: string,
    connection: UdpConnection,
    consoleType: OscMixerConsole,
  ): void {
    void this.queryOscMixerState(connection, consoleType).catch((error: unknown) => {
      console.error(`[bridge] OSC mixer feedback query for ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.teardownOscMixerFeedback(target);
      connection.disconnect();
      this.udpConnections.delete(target);
      this.send({ type: "device-status", target, connected: false });
      this.sendStatus();
    });
  }

  private scheduleOscMixerEvent(target: string, state: OscMixerState): void {
    if (this.oscMixerFlushTimers.has(target)) return;
    const timer = setTimeout(() => {
      this.oscMixerFlushTimers.delete(target);
      this.send({ type: "device-event", target, eventName: "osc-mixer-state", data: oscMixerEventPayload(state) });
    }, 60);
    this.oscMixerFlushTimers.set(target, timer);
  }

  private teardownOscMixerFeedback(target: string): void {
    this.oscMixerListeners.get(target)?.();
    this.oscMixerListeners.delete(target);
    const poller = this.oscMixerPollers.get(target);
    if (poller) clearInterval(poller);
    this.oscMixerPollers.delete(target);
    const flushTimer = this.oscMixerFlushTimers.get(target);
    if (flushTimer) clearTimeout(flushTimer);
    this.oscMixerFlushTimers.delete(target);
    this.oscMixerStates.delete(target);
  }

  private async executeUdpCommand(msg: CommandMessage): Promise<void> {
    const { target, command } = msg;
    let conn = this.udpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      await this.requestCommandConnection(msg);
      conn?.disconnect();
      const { host, port } = networkAddress(target);
      conn = new UdpConnection();
      await conn.connect(host, port);
      this.udpConnections.set(target, conn);
      this.sendStatus();
    }

    // Command is hex string for VISCA, or raw bytes
    const buf = Buffer.from(command.replace(/\s+/g, ""), "hex");
    await conn.send(buf);
  }

  private nextViscaSequence(target: string): number {
    const next = (this.viscaSequences.get(target) ?? 0) + 1;
    this.viscaSequences.set(target, next >>> 0);
    return next >>> 0;
  }

  private async executeViscaCommand(target: string, command: string): Promise<void> {
    const conn = this.udpConnections.get(target);
    const mode = this.viscaModes.get(target);
    if (!conn?.isConnected() || !mode) throw new Error("VISCA camera is not verified as responding");
    const payload = Buffer.from(command.replace(/\s+/g, ""), "hex");
    const sequence = this.nextViscaSequence(target);
    await conn.sendAndReceiveUntil(
      frameViscaPacket(payload, mode, sequence),
      (reply) => inspectViscaReply(reply, mode, sequence) === "complete",
    );
  }

  private async executeHttpCommand(msg: CommandMessage): Promise<string> {
    const { target, command } = msg;
    if (!this.httpDeviceSettings.has(target)) {
      await this.requestCommandConnection(msg);
      this.httpDeviceSettings.set(target, {});
      this.sendStatus();
    }
    const settings = this.httpDeviceSettings.get(target) ?? {};
    const authToken = typeof settings.authToken === "string" ? settings.authToken : undefined;

    const trimmed = command.trim();
    const methodMatch = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
    const remainder = methodMatch
      ? trimmed.slice(methodMatch[0].length)
      : trimmed;
    const spaceIdx = remainder.indexOf(" ");
    const path = spaceIdx > 0 ? remainder.slice(0, spaceIdx) : remainder;
    const body = spaceIdx > 0 ? remainder.slice(spaceIdx + 1) : undefined;

    const baseUrl = /^https?:\/\//i.test(target)
      ? target.replace(/\/+$/, "")
      : `http://${target.replace(/\/+$/, "")}`;
    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  }

  private async executeWol(msg: CommandMessage): Promise<void> {
    // command = MAC address "AA:BB:CC:DD:EE:FF"
    const mac = msg.command.replace(/[:-]/g, "");
    if (!/^[0-9a-f]{12}$/i.test(mac)) throw new Error("Invalid MAC address");
    await this.requestCommandConnection(msg);

    const macBytes = Buffer.from(mac, "hex");
    // Magic packet: 6x 0xFF + 16x MAC
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6);
    }

    const conn = new UdpConnection();
    try {
      await conn.connect("255.255.255.255", 9);
      await conn.send(packet);
    } finally { conn.disconnect(); }
  }

  // ─── Helpers ────────────────────────────────────────────

  private send(data: { type: string; [key: string]: unknown }): void {
    if (this.role !== "active" && !["bridge-status", "bridge-role-applied", "bridge-policy-applied", "pong"].includes(data.type)) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendStatus(): void {
    const targets = connectedBridgeTargets(
      this.tcpConnections.keys(),
      this.udpConnections.keys(),
      this.ppConnections.keys(),
      this.atemConnections.keys(),
      this.dmxConnections.keys(),
      this.obsConnections.keys(),
      this.httpDeviceSettings.keys(),
    );
    this.send({
      type: "bridge-status",
      version: BRIDGE_VERSION,
      devices: targets.length,
      targets,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    });
  }
}
