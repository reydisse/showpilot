import { useEffect, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { enable } from "@tauri-apps/plugin-autostart";
import { Activity, CheckCircle2, Eye, EyeOff, RefreshCw, Server, ShieldCheck, Square, XCircle } from "lucide-react";
import { getBridgeConfig, getBridgeStatus, startBridge, stopBridge, type BridgeConfig, type BridgeStatus } from "./desktop";

const emptyConfig: BridgeConfig = { site: "", org: "", key: "" };

export function App() {
  const [config, setConfig] = useState<BridgeConfig>(emptyConfig);
  const [status, setStatus] = useState<BridgeStatus>({ configured: false, running: false, connection: "offline", pid: null, logs: [] });
  const [error, setError] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  async function refresh() {
    const next = await getBridgeStatus();
    setStatus(next);
  }

  useEffect(() => {
    void getBridgeConfig().then((saved) => saved && setConfig(saved));
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const updateTimer = window.setTimeout(() => void checkForUpdates({ automatic: true }), 2500);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(updateTimer);
    };
  }, []);

  async function saveAndStart() {
    setError("");
    try {
      setStatus(await startBridge(config));
      try {
        await enable();
      } catch {
        setError("Bridge started, but automatic login start could not be enabled.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function stop() {
    await stopBridge();
    await refresh();
  }

  async function checkForUpdates(options: { automatic?: boolean } = {}) {
    const automatic = options.automatic === true;
    setCheckingUpdate(true);
    if (!automatic) setUpdateMessage("");
    try {
      const update = await check();
      if (!update) {
        if (!automatic) setUpdateMessage("You are up to date.");
        return;
      }
      if (automatic) {
        setUpdateMessage(`ShowPilot Bridge ${update.version} is available. Use Check for updates when it is safe to install.`);
        await update.close();
        return;
      }
      if (window.confirm(`ShowPilot Bridge ${update.version} is available. Download and install it now?`)) {
        setUpdateMessage(`Downloading ShowPilot Bridge ${update.version}…`);
        try {
          await update.downloadAndInstall();
          setUpdateMessage(`Update ${update.version} installed. Quit and reopen ShowPilot Bridge to finish.`);
        } finally {
          await update.close();
        }
      } else {
        setUpdateMessage(`Update ${update.version} is available.`);
        await update.close();
      }
    } catch (reason) {
      if (!automatic) {
        setUpdateMessage(`Update check failed: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    } finally {
      setCheckingUpdate(false);
    }
  }

  const update = (next: Partial<BridgeConfig>) => setConfig((current) => ({ ...current, ...next }));
  const connectionCopy = {
    offline: {
      title: "Bridge is offline",
      detail: "Configure the connection below to start the local connector.",
    },
    connecting: {
      title: "Connecting to ShowPilot",
      detail: "The Bridge process is running and negotiating the cloud connection.",
    },
    connected: {
      title: "Connected to ShowPilot",
      detail: `Process ${status.pid ?? "—"} · cloud connection active`,
    },
    disconnected: {
      title: "Disconnected from ShowPilot",
      detail: "The Bridge process is running but the cloud connection closed. See the output below.",
    },
    unauthorized: {
      title: "ShowPilot rejected this connection",
      detail: "Check the organization slug and replace the Bridge API key with the current key from Settings.",
    },
    error: {
      title: "Could not connect to ShowPilot",
      detail: "Check the site URL, organization slug, API key, and network, then review the output below.",
    },
  } satisfies Record<BridgeStatus["connection"], { title: string; detail: string }>;
  const connection = status.running ? status.connection : "offline";
  const connectionStatus = connectionCopy[connection];
  const isConnected = connection === "connected";

  return (
    <main className="shell">
      <header className="header">
        <div className="brand"><span className="brand-mark">SP</span><div><strong>ShowPilot Bridge</strong><small>Local production connector</small></div></div>
        <button className="refresh" onClick={() => void refresh()} aria-label="Refresh bridge status"><RefreshCw /></button>
      </header>

      <section className={`status ${isConnected ? "online" : connection === "connecting" ? "connecting" : "offline"}`}>
        {isConnected ? <CheckCircle2 /> : connection === "connecting" ? <RefreshCw className="spin" /> : <XCircle />}
        <div><strong>{connectionStatus.title}</strong><small>{connectionStatus.detail}</small></div>
      </section>

      <section className="card">
        <div className="card-title"><Server /><div><h1>ShowPilot connection</h1><p>Connect this production computer to your ShowPilot organization.</p></div></div>
        <label>ShowPilot site<input value={config.site} onChange={(event) => update({ site: event.target.value })} placeholder="https://showpilot.tech" /></label>
        <label>Organization slug<input value={config.org} onChange={(event) => update({ org: event.target.value })} placeholder="faithfire-production" /></label>
        <label>Bridge API key<div className="input-with-action"><input type={showKey ? "text" : "password"} value={config.key} onChange={(event) => update({ key: event.target.value })} placeholder="sp_…" /><button type="button" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff /> : <Eye />}</button></div></label>
      </section>

      <section className="card">
        <div className="card-title"><Activity /><div><h1>ProPresenter</h1><p>Optional local connection for slides, scriptures, and control.</p></div></div>
        <label>Computer address<input value={config.propresenterHost ?? ""} onChange={(event) => update({ propresenterHost: event.target.value || undefined })} placeholder="192.168.1.50" /></label>
        <div className="two-fields"><label>Stage port<input inputMode="numeric" value={config.propresenterPort ?? ""} onChange={(event) => update({ propresenterPort: event.target.value ? Number(event.target.value) : undefined })} placeholder="50001" /></label><label>API port<input inputMode="numeric" value={config.propresenterApiPort ?? ""} onChange={(event) => update({ propresenterApiPort: event.target.value ? Number(event.target.value) : undefined })} placeholder="1025" /></label></div>
        <label>Stage app password<input type="password" value={config.propresenterPassword ?? ""} onChange={(event) => update({ propresenterPassword: event.target.value || undefined })} /></label>
      </section>

      {error && <div className="error">{error}</div>}
      <div className="actions">{status.running && <button className="secondary" onClick={() => void stop()}><Square /> Stop bridge</button>}<button className="primary" onClick={() => void saveAndStart()}>{status.running ? "Save & restart" : "Save & start bridge"}</button></div>

      <section className="card logs-card"><div className="logs-title"><ShieldCheck /><span>Recent bridge output</span></div>{status.logs.length ? <pre>{status.logs.slice(-10).join("\n")}</pre> : <p>No bridge output yet.</p>}</section>
      <section className="card update-card"><div><h1>Updates</h1><p>Check for signed ShowPilot Bridge releases without re-entering your setup.</p></div><button className="secondary update-button" onClick={() => void checkForUpdates()} disabled={checkingUpdate}><RefreshCw />{checkingUpdate ? "Checking…" : "Check for updates"}</button>{updateMessage && <p className="update-message">{updateMessage}</p>}</section>
      <footer>Keep this app running on the same network as the production equipment.</footer>
    </main>
  );
}
