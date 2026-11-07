import { AsyncLocalStorage } from "node:async_hooks";
import { EmailDeliveryRejected } from "./email";
import type { SetupAttempt } from "./setup-save-contract";
interface DeliveryContext {
  orgId: string; email: string;
  record: (state: SetupAttempt["state"], invitationId: string) => Promise<void>;
}
const delivery = new AsyncLocalStorage<DeliveryContext>();
export const withSetupInvitationDelivery = <T>(context: DeliveryContext, run: () => Promise<T>) => delivery.run(context, run);

/** Better Auth catches email-hook errors. Persist delivery evidence inside the hook. */
export async function sendInvitationWithSetupReceipt(input: {
  orgId: string; email: string; invitationId: string; send: (signal?: AbortSignal) => Promise<void>;
}) {
  const context = delivery.getStore();
  if (!context) return input.send();
  if (context.orgId !== input.orgId || context.email !== input.email.toLowerCase()) throw new Error("Invitation delivery scope changed.");
  await context.record("running", input.invitationId);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      input.send(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Invitation delivery timed out.")); }, 8_000); }),
    ]);
    await context.record("accepted", input.invitationId);
  } catch (error) {
    await context.record(error instanceof EmailDeliveryRejected ? "failed" : "uncertain", input.invitationId);
    throw error;
  } finally { clearTimeout(timer); }
}
