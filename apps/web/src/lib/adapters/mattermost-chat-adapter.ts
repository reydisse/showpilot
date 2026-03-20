import { ExternalChatAdapterBase } from "./external-chat-adapter-base";

export class MattermostChatAdapter extends ExternalChatAdapterBase {
  constructor(orgId: string) {
    super(orgId, "mattermost");
  }
}
