import { describe, expect, it } from "vitest";
import { chatRelayKey } from "@/lib/chat-relay-key";

describe("chat relay routing", () => {
	it("keeps each organization room on its own Durable Object", () => {
		expect(chatRelayKey("org-1", "production")).toBe("org-1:production");
		expect(chatRelayKey("org-1", "planning")).toBe("org-1:planning");
		expect(chatRelayKey("org-2", "production")).toBe("org-2:production");
	});
});
