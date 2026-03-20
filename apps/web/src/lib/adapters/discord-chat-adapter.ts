import { ExternalChatAdapterBase } from "./external-chat-adapter-base";

export class DiscordChatAdapter extends ExternalChatAdapterBase {
  constructor(orgId: string) {
    super(orgId, "discord");
  }
}
