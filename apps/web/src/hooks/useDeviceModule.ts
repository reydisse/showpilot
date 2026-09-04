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
  const moduleDeviceIdRef = useRef<string | null>(null);
  const definition = device ? moduleRegistry.get(device.adapterType) : undefined;

  useEffect(() => {
    setError(null);
    setFeedbacks(new Map());
    setStatus("disconnected");
  }, [device?.id]);

  // Track bridge status for bridge-required devices
  useEffect(() => {
    if (!orgId || !definition) return;
    if (definition.connectivity !== "bridge-required") return;

    const proxy = getSharedBridgeProxy(orgId);
    setBridgeOnline(proxy.isBridgeOnline());

    const unsub = proxy.onBridgeStatus((online) => {
      setBridgeOnline(online);
      // Bridge availability and device connectivity are separate states. A
      // bridge-status heartbeat can arrive immediately after device-status.
      // Resetting the device here made a successful connection look
      // disconnected and turned the Connect button into a silent no-op.
      if (!online) {
        setStatus("bridge-required");
      }
    });

    return unsub;
  }, [definition, orgId]);

  // Create module instance and manage lifecycle
  useEffect(() => {
    if (!device || !definition) {
      moduleRef.current = null;
      moduleDeviceIdRef.current = null;
      setStatus("disconnected");
      return;
    }

    // Bridge-required and no bridge → show banner
    if (
      definition.connectivity === "bridge-required" &&
      !bridgeOnline
    ) {
      setStatus("bridge-required");
      moduleRef.current = null;
      moduleDeviceIdRef.current = null;
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(device.settings || "{}");
    } catch {
      settings = {};
    }

    const mod = definition.createInstance({ ...settings, orgId });
    moduleRef.current = mod;
    moduleDeviceIdRef.current = device.id;

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
      mod.connect();
    }

    return () => {
      unsubStatus();
      unsubFeedback();
      mod.disconnect();
      moduleRef.current = null;
      moduleDeviceIdRef.current = null;
      setStatus("disconnected");
    };
  }, [bridgeOnline, definition, device?.enabled, device?.id, device?.settings, orgId]);

  const connect = useCallback(async () => {
    const mod = moduleRef.current;
    if (!mod) {
      const bridgeRequired = definition?.connectivity === "bridge-required";
      const message = bridgeRequired && !bridgeOnline
        ? "Venue Bridge is offline. Start it on the venue network before connecting this device."
        : "Device controls are still starting. Try Connect again in a moment.";
      setError(message);
      setStatus(bridgeRequired && !bridgeOnline ? "bridge-required" : "error");
      return;
    }

    setError(null);
    await mod.connect();
  }, [bridgeOnline, definition?.connectivity]);

  const disconnect = useCallback(() => {
    moduleRef.current?.disconnect();
  }, []);

  return {
    module: moduleDeviceIdRef.current === device?.id ? moduleRef.current : null,
    status,
    feedbacks,
    definition,
    bridgeOnline,
    error,
    connect,
    disconnect,
  };
}
