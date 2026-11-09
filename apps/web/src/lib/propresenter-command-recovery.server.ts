import type {
  ProPresenterCommand,
  ProPresenterReply,
} from "@showpilot/shared/propresenter-command";
import type { LiveRundownAuthorityClaim } from "./live-rundown-authority.server";
import type { BridgeDispatchResult } from "../durable-objects/BridgeRelay";

export type ProPresenterCommandContext = {
  installationId: string;
  fingerprint: string;
  target: string;
};
type Receipt = {
  command: ProPresenterCommand;
  context: ProPresenterCommandContext;
  status: ProPresenterReply["status"];
  message: string;
  deadline: number;
};
interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
interface Ports {
  queue<T>(work: () => Promise<T>): Promise<T>;
  context(
    command: ProPresenterCommand,
    claim: LiveRundownAuthorityClaim,
  ): Promise<ProPresenterCommandContext>;
  dispatch(
    command: ProPresenterCommand,
    context: ProPresenterCommandContext,
    mode: "connect" | "prepare" | "execute",
  ): Promise<{ result: Promise<BridgeDispatchResult> }>;
}

/** The durable claim is saved before any send. Checking or repeating an ID
 * never sends it again, including after eviction or a lost device reply. */
export class ProPresenterCommandRecovery {
  constructor(
    private readonly store: Store,
    private readonly ports: Ports,
    private readonly now: () => number = Date.now,
  ) {}
  private key(command: ProPresenterCommand) {
    return `pp-command:${command.userId}:${command.requestId}`;
  }
  private reply(receipt: Receipt): ProPresenterReply {
    if (receipt.deadline <= this.now()) {
      if (receipt.status === "prepared" || receipt.status === "preparing")
        return {
          ...receipt.command,
          status: "rejected",
          message:
            "This slide command expired before it was sent. Check the output before trying again.",
        };
      if (receipt.status === "sending")
        return {
          ...receipt.command,
          status: "uncertain",
          message:
            "ProPresenter did not confirm this command. It may have changed the slide. Check the output before sending another command.",
        };
    }
    return {
      ...receipt.command,
      status: receipt.status,
      message: receipt.message,
    };
  }
  private async existing(command: ProPresenterCommand) {
    const receipt = await this.store.get<Receipt>(this.key(command));
    if (receipt && JSON.stringify(receipt.command) !== JSON.stringify(command))
      throw new Error(
        "The original slide command changed. Return to the original request.",
      );
    return receipt;
  }
  private async save(
    receipt: Receipt,
    status: Receipt["status"],
    message: string,
  ) {
    const next = { ...receipt, status, message };
    await this.store.put(this.key(receipt.command), next);
    return next;
  }
  async check(
    command: ProPresenterCommand,
    claim: LiveRundownAuthorityClaim,
  ): Promise<ProPresenterReply> {
    return this.ports.queue(async () => {
      // The HTTP boundary checks the live session and permission for status reads.
      // A missing receipt means execution cannot have claimed this ID.
      if (command.orgId !== claim.orgId || command.userId !== claim.userId)
        throw new Error("Account changed.");
      const receipt = await this.existing(command);
      return receipt
        ? this.reply(receipt)
        : {
            ...command,
            status: "rejected",
            message:
              "This command was not prepared and was not sent. Check the output before trying again.",
          };
    });
  }
  async prepare(
    command: ProPresenterCommand,
    claim: LiveRundownAuthorityClaim,
  ): Promise<ProPresenterReply> {
    const operation = await this.ports.queue(async () => {
      const existing = await this.existing(command);
      if (existing) return { receipt: existing };
      const context = await this.ports.context(command, claim);
      const receipt: Receipt = {
        command,
        context,
        status: "preparing",
        message: "Preparing the slide command…",
        deadline: this.now() + 12000,
      };
      await this.store.put(this.key(command), receipt);
      return {
        receipt,
        result: (await this.ports.dispatch(command, context, "connect")).result,
      };
    });
    if (!operation.result) return this.reply(operation.receipt);
    let connection: BridgeDispatchResult;
    try {
      connection = await operation.result;
    } catch {
      connection = { success: false };
    }
    const reservation = await this.ports.queue(async () => {
      const receipt = await this.existing(command);
      if (!receipt || receipt.status !== "preparing")
        return { receipt: receipt ?? operation.receipt };
      if (!connection.success || receipt.deadline <= this.now())
        return {
          receipt: await this.save(
            receipt,
            "rejected",
            "The connection was not ready in time. The slide command was not sent. Check ProPresenter and try again.",
          ),
        };
      try {
        const current = await this.ports.context(command, claim);
        if (JSON.stringify(current) !== JSON.stringify(receipt.context))
          throw new Error(
            "ProPresenter or the active Bridge changed. The slide command was not sent.",
          );
        const next = { ...receipt, deadline: this.now() + 5000 };
        await this.store.put(this.key(command), next);
        return {
          receipt: next,
          result: (await this.ports.dispatch(command, current, "prepare"))
            .result,
        };
      } catch {
        return {
          receipt: await this.save(
            receipt,
            "rejected",
            "Access, ProPresenter settings, or the active Bridge changed. The slide command was not sent.",
          ),
        };
      }
    });
    if (!reservation.result) return this.reply(reservation.receipt);
    let result: BridgeDispatchResult;
    try {
      result = await reservation.result;
    } catch {
      result = { success: false };
    }
    return this.ports.queue(async () => {
      const receipt = await this.existing(command);
      if (!receipt || receipt.status !== "preparing")
        return this.reply(receipt ?? reservation.receipt);
      return this.reply(
        await this.save(
          receipt,
          result.success && receipt.deadline > this.now()
            ? "prepared"
            : "rejected",
          result.success
            ? receipt.deadline > this.now()
              ? "Slide command ready."
              : "This slide command expired before it was sent. Check the output before trying again."
            : "The Bridge could not prepare this slide command. Update or reconnect the Bridge and check ProPresenter. Nothing was sent to ProPresenter.",
        ),
      );
    });
  }
  async execute(
    command: ProPresenterCommand,
    claim: LiveRundownAuthorityClaim,
  ): Promise<ProPresenterReply> {
    const operation = await this.ports.queue(async () => {
      const receipt = await this.existing(command);
      if (!receipt) throw new Error("Prepare the slide command first.");
      if (receipt.status !== "prepared" || receipt.deadline <= this.now())
        return { receipt };
      let current: ProPresenterCommandContext;
      try {
        current = await this.ports.context(command, claim);
        if (
          JSON.stringify(current) !== JSON.stringify(receipt.context) ||
          receipt.deadline <= this.now()
        )
          throw new Error("Context changed.");
      } catch {
        return {
          receipt: await this.save(
            receipt,
            "rejected",
            "Access, ProPresenter settings, or the active Bridge changed. The slide command was not sent.",
          ),
        };
      }
      const sending = await this.save(
        { ...receipt, deadline: this.now() + 12000 },
        "sending",
        "Waiting for ProPresenter to confirm…",
      );
      return {
        receipt: sending,
        result: (await this.ports.dispatch(command, current, "execute")).result,
      };
    });
    if (!operation.result) return this.reply(operation.receipt);
    let result: BridgeDispatchResult;
    try {
      result = await operation.result;
    } catch {
      result = { success: false };
    }
    return this.ports.queue(async () =>
      this.reply(
        await this.save(
          operation.receipt,
          result.success
            ? "confirmed"
            : result.notExecuted
              ? "rejected"
              : "uncertain",
          result.success
            ? "ProPresenter confirmed the command."
            : result.notExecuted
              ? "The slide command expired or was rejected before execution. Check the output before trying again."
              : "ProPresenter did not confirm this command. It may have changed the slide. Check the output before sending another command.",
        ),
      ),
    );
  }
}
