import { describe, expect, it } from "vitest";
import { CREDENTIAL_MASK, redactCredentialPayload, redactCredentialText } from "../credential-fields";

describe("device response credential redaction", () => {
  it("redacts nested secrets, custom auth headers, array items and serialized settings", () => {
    const secret = "test-response-secret";
    const raw = { status: "ready", settings: { password: secret, nested: [{ accessToken: secret }], headers: { "X-API-Key": secret, Authorization: `Bearer ${secret}` } }, data: JSON.stringify({ api_key: secret, volume: 12 }) };
    const redacted = redactCredentialPayload(raw);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toMatchObject({ status: "ready", data: JSON.stringify({ api_key: CREDENTIAL_MASK, volume: 12 }) });
    expect(raw.settings.password).toBe(secret);
  });
  it("preserves ordinary replies, lyric contents, empty credentials and numeric feedback", () => {
    const lyric = "Amazing grace\nHow sweet the sound";
    expect(redactCredentialText(lyric)).toBe(lyric);
    const structuredFeedback = ' { "counter": 9007199254740993, "volume": 0.50 }\n';
    expect(redactCredentialText(structuredFeedback)).toBe(structuredFeedback);
    expect(redactCredentialPayload({ data: structuredFeedback })).toEqual({ data: structuredFeedback });
    expect(redactCredentialText("%1POWR=1\r")).toBe("%1POWR=1\r");
    expect(redactCredentialPayload({ text: lyric, password: "", authToken: null, count: 3, muted: false })).toEqual({ text: lyric, password: "", authToken: null, count: 3, muted: false });
  });
  it("cannot expose encrypted values under an unrecognized key or deeply nested payloads", () => {
    expect(redactCredentialPayload({ config: "spenc:v1:encoded-envelope" })).toEqual({ config: CREDENTIAL_MASK });
    let payload: unknown = { value: "too-deep" };
    for (let index = 0; index < 30; index++) payload = { nested: payload };
    expect(JSON.stringify(redactCredentialPayload(payload))).not.toContain("too-deep");
    expect(redactCredentialText('{"password":"unterminated-secret')).not.toContain("unterminated-secret");
  });
});
