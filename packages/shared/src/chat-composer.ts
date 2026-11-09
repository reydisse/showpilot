/** Conversation drafts live for the client session, independently of mounted views. */
export type ChatComposerSnapshot<Message> = {
  message: { text: string; messageType: "text" | "cue" | "alert"; replyingTo: Message | null };
  edit: { target: Message; text: string } | null;
  poll: { question: string; options: string[]; open: boolean };
};
type Value<T> = T | ((previous: T) => T);
function value<T>(next: Value<T>, previous: T): T {
  return typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
}
function blankMessage<Message>(): ChatComposerSnapshot<Message>["message"] {
  return { text: "", messageType: "text", replyingTo: null };
}
function blankPoll(): ChatComposerSnapshot<never>["poll"] { return { question: "", options: ["", ""], open: false }; }

export class ChatComposer<Message extends { text: string }> {
  private state: ChatComposerSnapshot<Message> = { message: blankMessage(), edit: null, poll: blankPoll() };
  private listeners = new Set<() => void>();
  private sending = false;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: ChatComposerSnapshot<Message>) {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  setText = (next: Value<string>) => {
    const { edit, message } = this.state;
    this.publish(edit ? { ...this.state, edit: { ...edit, text: value(next, edit.text) } }
      : { ...this.state, message: { ...message, text: value(next, message.text) } });
  };
  setMessageType = (messageType: ChatComposerSnapshot<Message>["message"]["messageType"]) => {
    this.publish({ ...this.state, message: { ...this.state.message, messageType } });
  };
  setReplyingTo = (replyingTo: Message | null) => {
    this.publish({ ...this.state, edit: null, message: { ...this.state.message, replyingTo } });
  };
  beginEdit = (target: Message) => {
    this.publish({ ...this.state, edit: { target, text: target.text } });
  };
  cancelEdit = () => this.publish({ ...this.state, edit: null });
  setPollQuestion = (question: string) => this.publish({ ...this.state, poll: { ...this.state.poll, question } });
  setPollOptions = (options: Value<string[]>) => this.publish({ ...this.state, poll: { ...this.state.poll, options: value(options, this.state.poll.options) } });
  setPollOpen = (open: Value<boolean>) => this.publish({ ...this.state, poll: { ...this.state.poll, open: value(open, this.state.poll.open) } });
  /** Compare the submitted section, so unrelated poll typing cannot resurrect a sent message. */
  private clear = (expected: ChatComposerSnapshot<Message>) => {
    if (expected.edit) {
      if (this.state.edit === expected.edit) this.publish({ ...this.state, edit: null });
    } else if (this.state.message === expected.message) {
      this.publish({ ...this.state, message: blankMessage() });
    }
  };
  private clearPoll = (expected: ChatComposerSnapshot<Message>) => {
    if (this.state.poll === expected.poll) this.publish({ ...this.state, poll: blankPoll() });
  };
  /** The lock survives navigation and multiple views of the same room. */
  async send(kind: "message" | "poll", enqueue: (snapshot: ChatComposerSnapshot<Message>) => void | Promise<void>) {
    if (this.sending) return false;
    this.sending = true;
    const submitted = this.state;
    try {
      await enqueue(submitted);
      if (kind === "poll") this.clearPoll(submitted); else this.clear(submitted);
      return true;
    } finally { this.sending = false; }
  }
}

export function composerFields<Message>(snapshot: ChatComposerSnapshot<Message>) {
  return {
    text: snapshot.edit?.text ?? snapshot.message.text,
    messageType: snapshot.message.messageType,
    replyingTo: snapshot.edit ? null : snapshot.message.replyingTo,
    editing: snapshot.edit?.target ?? null,
    pollQuestion: snapshot.poll.question, pollOptions: snapshot.poll.options, pollOpen: snapshot.poll.open,
  };
}
