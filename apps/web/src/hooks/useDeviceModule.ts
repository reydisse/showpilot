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
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useDeviceModule(
  device: DeviceRecord | null,
  orgId?: string
): UseDeviceModuleReturn {
  const [status, setStatus] = useState<DeviceConnectionStatus>("disconnected");
  const [feedbacks, setFeedbacks] = useState<Map<string, unknown>>(new Map());
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moduleRef = useRef<DeviceModule | null>(null);
  const [module, setModule] = useState<DeviceModule | null>(null);
  const moduleDeviceIdRef = useRef<string | null>(null);
  const definition = device ? moduleRegistry.get(device.adapterType) : undefined;
  const storedCredential = Boolean(device?.settings.includes(CREDENTIAL_MASK));
  const requiresBridge = storedCredential || definition?.connectivity === "bridge-required";

  useEffect(() => {
    setError(null);
    setFeedbacks(new Map());
    setStatus("disconnected");
  }, [device?.id]);

  // Track bridge status for bridge-required devices
  useEffect(() => {
    if (!orgId || !definition) return;
    if (!requiresBridge) return;

    const proxy = getSharedBridgeProxy(orgId);
    setBridgeOnline(proxy.isBridgeOnline());

    const unsub = proxy.onBridgeStatus((online, reason) => {
      setBridgeOnline(online);
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
  }, [definition, orgId, requiresBridge]);

  // Create module instance and manage lifecycle
  useEffect(() => {
    if (!device || !definition) {
      moduleRef.current = null;
      setModule(null);
      moduleDeviceIdRef.current = null;
      setStatus("disconnected");
      return;
    }

    // Bridge-required and no bridge → show banner
    if (
      requiresBridge &&
      !bridgeOnline
    ) {
      setStatus("bridge-required");
      moduleRef.current = null;
      setModule(null);
      moduleDeviceIdRef.current = null;
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(device.settings || "{}");
    } catch {
      settings = {};
    }

    if (storedCredential && (!orgId || !definition.remoteControl)) {
      setStatus("error");
      setError("This device needs a supported venue Bridge control configuration.");
      return;
    }
    const mod = storedCredential && orgId && definition.remoteControl
      ? new StoredDeviceModule(orgId, device.id, definition.remoteControl, settings)
      : definition.createInstance({ ...settings, orgId });
    moduleRef.current = mod;
    setModule(mod);
    moduleDeviceIdRef.current = device.id;
    setStatus(mod.connectionStatus());
    setFeedbacks(new Map());

    // Wire listeners
    const unsubStatus = mod.onStatusChange((s, message) => {
      setStatus(s);
      setError(s === "error" ? message ?? "Connection failed" : null);
    });

    const unsubFeedback = mod.onFeedbackChange((id, value) => {
      setFeedbacks((prev) => {
        const next = new Map(prev);
        next.set(id, value);
        return next;
      });
    });

    // Auto-connect if enabled
    if (device.enabled) {
      void mod.connect().catch((cause: unknown) => {
        if (moduleRef.current !== mod) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Connection failed");
      });
    }

    return () => {
      unsubStatus();
      unsubFeedback();
      mod.disconnect();
      moduleRef.current = null;
      moduleDeviceIdRef.current = null;
      setStatus("disconnected");
    };
  }, [bridgeOnline, definition, device?.enabled, device?.id, device?.settings, orgId, requiresBridge, storedCredential]);

  const connect = useCallback(async () => {
    const mod = moduleRef.current;
    if (!mod) {
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
      if (moduleRef.current !== mod) return;
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Connection failed");
    }
  }, [bridgeOnline, requiresBridge]);

  const disconnect = useCallback(() => {
    const mod = moduleRef.current;
    if (mod instanceof StoredDeviceModule) {
      void mod.disconnectDevice().catch(cause => {
        if (moduleRef.current !== mod) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : "Could not disconnect device.");
      });
    } else mod?.disconnect();
  }, []);

  return {
    module: moduleDeviceIdRef.current === device?.id ? module : null,
    status,
    feedbacks,
    definition,
    bridgeOnline,
    error,
    connect,
    disconnect,
  };
}
