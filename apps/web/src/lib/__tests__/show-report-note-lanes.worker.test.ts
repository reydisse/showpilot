import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("show report note lane identity", () => {
  it("keys a contributor independently by PM and TM lane", async () => {
    const indexes = await env.DB.prepare("PRAGMA index_list('show_report_note')").all<{ name: string; unique: number }>();
    const laneIndex = indexes.results?.find((index) => index.name === "show_report_note_author_lane_key");
    expect(laneIndex?.unique).toBe(1);
    const columns = await env.DB.prepare("PRAGMA index_info('show_report_note_author_lane_key')").all<{ name: string }>();
    expect(columns.results?.map((column) => column.name)).toEqual(["orgId", "showId", "userId", "role"]);
    expect(indexes.results?.some((index) => index.name === "show_report_note_author_key")).toBe(false);
  });
});
