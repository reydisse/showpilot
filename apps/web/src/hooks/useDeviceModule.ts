import { useState, useEffect, useRef, useCallback } from "react";
import { moduleRegistry } from "@/lib/device-modules/registry";
import type {
  DeviceModule,
  DeviceConnectionStatus,
  ModuleFeedback,
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
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useDeviceModule(
  device: DeviceRecord | null
): UseDeviceModuleReturn {
  const [status, setStatus] = useState<DeviceConnectionStatus>("disconnected");
  const [feedbacks, setFeedbacks] = useState<Map<string, unknown>>(new Map());
  const moduleRef = useRef<DeviceModule | null>(null);
  const definitionRef = useRef<ReturnType<typeof moduleRegistry.get>>(undefined);

  // Resolve module definition
  useEffect(() => {
    if (!device) {
      definitionRef.current = undefined;
      return;
    }
    definitionRef.current = moduleRegistry.get(device.adapterType);
  }, [device?.adapterType]);

  // Create module instance and manage lifecycle
  useEffect(() => {
    if (!device || !definitionRef.current) {
      moduleRef.current = null;
      setStatus("disconnected");
      return;
    }

    // Check if bridge is required
    if (definitionRef.current.connectivity === "bridge-required") {
      setStatus("bridge-required");
      moduleRef.current = null;
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(device.settings || "{}");
    } catch {
      settings = {};
    }

    const mod = definitionRef.current.createInstance(settings);
    moduleRef.current = mod;

    // Wire listeners
    const unsubStatus = mod.onStatusChange((s, _err) => {
      setStatus(s);
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
      setStatus("disconnected");
    };
  }, [device?.id, device?.settings, device?.enabled]);

  const connect = useCallback(async () => {
    await moduleRef.current?.connect();
  }, []);

  const disconnect = useCallback(() => {
    moduleRef.current?.disconnect();
  }, []);

  return {
    module: moduleRef.current,
    status,
    feedbacks,
    definition: definitionRef.current,
    connect,
    disconnect,
  };
}
