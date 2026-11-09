const PRIORITY_PREFIX = "!!PRIORITY!!";

export interface DecodedStageMessage {
  text: string;
  priority: boolean;
}

export function encodeStageMessage(text: string, priority: boolean): string {
  const normalized = text.trim();
  return priority && normalized ? `${PRIORITY_PREFIX}${normalized}` : normalized;
}

export function decodeStageMessage(value: string): DecodedStageMessage {
  const priority = value.startsWith(PRIORITY_PREFIX);
  return {
    text: priority ? value.slice(PRIORITY_PREFIX.length) : value,
    priority,
  };
}
