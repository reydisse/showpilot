import { ExternalChatAdapterBase } from "./external-chat-adapter-base";

/** Teams adapter is send-only — incoming webhook cannot receive messages. */
export class TeamsChatAdapter extends ExternalChatAdapterBase {
  constructor(orgId: string) {
    super(orgId, "teams", { sendOnly: true });
  }
}
