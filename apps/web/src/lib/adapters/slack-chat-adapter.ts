import { ExternalChatAdapterBase } from "./external-chat-adapter-base";

export class SlackChatAdapter extends ExternalChatAdapterBase {
  constructor(orgId: string) {
    super(orgId, "slack");
  }
}
