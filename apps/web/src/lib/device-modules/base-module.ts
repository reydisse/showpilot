import type {
  DeviceConnectionStatus,
  DeviceModule,
  ModuleAction,
  ModuleFeedback,
  StatusChangeCallback,
  FeedbackChangeCallback,
} from "./types";

/**
 * Abstract base class for device modules.
 * Handles connection lifecycle, listener management, and feedback emission.
 * Subclasses implement doConnect(), doDisconnect(), getActions(), executeAction(), getFeedbacks().
 */
export abstract class BaseDeviceModule implements DeviceModule {
  private _status: DeviceConnectionStatus = "disconnected";
  private _statusListeners = new Set<StatusChangeCallback>();
  private _feedbackListeners = new Set<FeedbackChangeCallback>();

  // ─── Connection lifecycle ───────────────────────────────

  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") return;

    this.setStatus("connecting");
    try {
      await this.doConnect();
      this.setStatus("connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
    }
  }

  disconnect(): void {
    if (this._status === "disconnected") return;

    this.doDisconnect();
    this.setStatus("disconnected");
  }

  connectionStatus(): DeviceConnectionStatus {
    return this._status;
  }

  // ─── Status listeners ───────────────────────────────────

  onStatusChange(callback: StatusChangeCallback): () => void {
    this._statusListeners.add(callback);
    return () => this._statusListeners.delete(callback);
  }

  // ─── Feedback listeners ─────────────────────────────────

  onFeedbackChange(callback: FeedbackChangeCallback): () => void {
    this._feedbackListeners.add(callback);
    return () => this._feedbackListeners.delete(callback);
  }

  // ─── Protected helpers ──────────────────────────────────

  protected setStatus(status: DeviceConnectionStatus, error?: string): void {
    this._status = status;
    for (const cb of this._statusListeners) {
      cb(status, error);
    }
  }

  protected emitFeedback(feedbackId: string, value: unknown): void {
    for (const cb of this._feedbackListeners) {
      cb(feedbackId, value);
    }
  }

  /** Public wrapper for testing — subclasses use protected emitFeedback */
  emitFeedbackPublic(feedbackId: string, value: unknown): void {
    this.emitFeedback(feedbackId, value);
  }

  // ─── Abstract methods ───────────────────────────────────

  protected abstract doConnect(): Promise<void>;
  protected abstract doDisconnect(): void;
  abstract getActions(): ModuleAction[];
  abstract executeAction(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<void>;
  abstract getFeedbacks(): ModuleFeedback[];
}
