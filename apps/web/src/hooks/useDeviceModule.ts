import { CREDENTIAL_MASK } from "@/lib/credential-fields";
import { StoredDeviceModule } from "@/lib/stored-device-module";
import { useState, useEffect, useRef, useCallback } from "react";
import "@/lib/device-modules/register-all";
import { moduleRegistry } from "@/lib/device-modules/registry";
import { getSharedBridgeProxy } from "@/lib/device-modules/bridge-proxy";
import type {
  DeviceModule,
  DeviceConnectionStatus,
} from "@/lib/device-modules/types";

interface DeviceRecord {
  id: string;
  adapterType: string;
  settings: string;
  enabled: boolean;
}

interface UseDeviceModuleReturn {
  module: DeviceModule | null;
  status: DeviceConnectionStatus;
  feedbacks: Map<string, unknown>;
  definition: ReturnType<typeof moduleRegistry.get>;
  bridgeOnline: boolean;
  error: string | null;
  errorAt: number | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useDeviceModule(
  device: DeviceRecord | null,
  orgId?: string
): UseDeviceModuleReturn {
  const [status, setStatus] = useState<DeviceConnectionStatus>("disconnected");
  const [feedbacks, setFeedbacks] = useState<Map<string, unknown>>(new Map());
  const [bridgeState, setBridgeState] = useState<{ orgId: string; online: boolean } | null>(null);
  const bridgeOnline = bridgeState?.orgId === orgId && bridgeState?.online === true;
  const scope = `${orgId ?? ""}:${device?.id ?? ""}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [failure, setFailure] = useState<{ scope: string; message: string; occurredAt: number } | null>(null);
  const setError = useCallback((message: string | null) => setFailure(message ? { scope: currentScope.current, message, occurredAt: Date.now() } : null), []);
  const visibleFailure = failure?.scope === scope ? failure : null;
  const error = visibleFailure?.message ?? null;
  const moduleRef = useRef<DeviceModule | null>(null);
  const [module, setModule] = useState<DeviceModule | null>(null);
  const moduleScopeRef = useRef<string | null>(null);
  const definition = device ? moduleRegistry.get(device.adapterType) : undefined;
  const storedCredential = Boolean(device?.settings.includes(CREDENTIAL_MASK));
  const requiresBridge = storedCredential || definition?.connectivity === "bridge-required";

  useEffect(() => {
    setError(null);
    setFeedbacks(new Map());
    setStatus("disconnected");
  }, [device?.id, orgId]);

  // Track bridge status for bridge-required devices
  useEffect(() => {
    if (!orgId || !definition) return;
    if (!requiresBridge) return;

    const proxy = getSharedBridgeProxy(orgId);
    setBridgeState({ orgId, online: proxy.isBridgeOnline() });
    if (proxy.getLastError()) setError(proxy.getLastError());

    const unsub = proxy.onBridgeStatus((online, reason) => {
      if (currentScope.current !== scope) return;
      setBridgeState({ orgId, online });
      // Bridge availability and device connectivity are separate states. A
      // bridge-status heartbeat can arrive immediately after device-status.
      // Resetting the device here made a successful connection look
      // disconnected and turned the Connect button into a silent no-op.
      if (!online) {
        setStatus("bridge-required");
        if (reason) setError(reason);
      }
    });

    return unsub;
  }, [definition, orgId, requiresBridge, scope]);

  // Create module instance and manage lifecycle
  useEffect(() => {
    moduleRef.current = null;
    moduleScopeRef.current = null;
    setModule(null);
    if (!device || !definition) {
      setStatus(device ? "error" : "disconnected");
      if (device) setError("This device type is not supported. Edit the configuration before connecting.");
      return;
    }

    let settings: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(device.settings || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid device settings");
      settings = Object.fromEntries(Object.entries(parsed));
    } catch {
      setStatus("error");
      setError("Device settings could not be read. Edit the configuration and save it before connecting.");
      return;
    }

    if (requiresBridge && !bridgeOnline) {
      setStatus("bridge-required");
      return;
    }

    if (storedCredential && (!orgId || !definition.remoteControl)) {
      setStatus("error");
      setError("This device needs a supported venue Bridge control configuration.");
      return;
    }
    let mod: DeviceModule;
    try {
      mod = storedCredential && orgId && definition.remoteControl
        ? new StoredDeviceModule(orgId, device.id, definition.remoteControl, settings)
        : definition.createInstance({ ...settings, orgId });
    } catch {
      setStatus("error");
      setError("Device controls could not start. Check the configuration and save it again.");
      return;
    }
    moduleRef.current = mod;
    setModule(mod);
    moduleScopeRef.current = scope;
    setError(null);
    setStatus(mod.connectionStatus());
    setFeedbacks(new Map());

    // Wire listeners
    const unsubStatus = mod.onStatusChange((s, message) => {
      if (moduleRef.current !== mod || currentScope.current !== scope) return;
      setStatus(s);
      setError(s === "error" ? message ?? "Connection failed" : null);
    });

    const unsubFeedback = mod.onFeedbackChange((id, value) => {
      if (moduleRef.current !== mod || currentScope.current !== scope) return;
      setFeedbacks((prev) => {
        const next = new Map(prev);
        next.set(id, value);
        return next;
      });
    });

    // Auto-connect if enabled
    if (device.enabled) {
      void mod.connect().catch((cause: unknown) => {
        if (moduleRef.current !== mod || currentScope.current !== scope) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Connection failed");
      });
    }

    return () => {
      unsubStatus();
      unsubFeedback();
      try { mod.disconnect(); }
      catch {
        if (currentScope.current === scope) setError("The previous device connection could not be closed. Review the venue connection before retrying.");
      } finally {
        if (moduleRef.current === mod) { moduleRef.current = null; moduleScopeRef.current = null; }
      }
    };
  }, [bridgeOnline, definition, device?.enabled, device?.id, device?.settings, orgId, requiresBridge, storedCredential, scope]);

  const connect = useCallback(async () => {
    if (currentScope.current !== scope) return;
    const mod = moduleRef.current;
    if (!mod) {
      if (error) return;
      const bridgeRequired = requiresBridge;
      const message = bridgeRequired && !bridgeOnline
        ? "Venue Bridge is offline. Start it on the venue network before connecting this device."
        : "Device controls are still starting. Try Connect again in a moment.";
      setError(message);
      setStatus(bridgeRequired && !bridgeOnline ? "bridge-required" : "error");
      return;
    }

    setError(null);
    try {
      await mod.connect();
    } catch (cause) {
      if (moduleRef.current !== mod || currentScope.current !== scope) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Connection failed");
    }
  }, [bridgeOnline, requiresBridge, error, scope]);

  const disconnect = useCallback(() => {
    if (currentScope.current !== scope) return;
    const mod = moduleRef.current;
    if (mod instanceof StoredDeviceModule) {
      void mod.disconnectDevice().catch(cause => {
        if (moduleRef.current !== mod || currentScope.current !== scope) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Could not disconnect device.");
      });
    } else {
      try { mod?.disconnect(); }
      catch { setStatus("error"); setError("Device disconnect could not be confirmed. Review the connection before retrying."); }
    }
  }, [scope]);

  return {
    module: moduleScopeRef.current === scope ? module : null,
    status,
    feedbacks,
    definition,
    bridgeOnline,
    error,
    errorAt: visibleFailure?.occurredAt ?? null,
    connect,
    disconnect,
  };
}
