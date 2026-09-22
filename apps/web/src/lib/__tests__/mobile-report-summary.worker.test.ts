import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MOBILE_REPORT_SUMMARY_SQL } from "../mobile-report-summary";

describe("mobile report aggregation", () => {
  it("combines independent child aggregates without multiplying their rows", async () => {
    const orgId = "mobile-report-summary-org";
    const showId = "mobile-report-summary-show";
    await env.DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Reports', ?, CURRENT_TIMESTAMP)`,
    )
      .bind(orgId, orgId)
      .run();
    await env.DB.prepare(
      `INSERT INTO rundown (id, orgId, serviceDate, name, location, status, createdAt, updatedAt)
       VALUES (?, ?, '2026-09-22', 'Evening', 'Main room', 'complete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
      .bind(showId, orgId)
      .run();

    const item = (id: string, type: string, status: string, order: number) =>
      env.DB.prepare(
        `INSERT INTO rundown_item
       (id, orgId, showId, serviceDate, itemId, title, type, duration, notes, assignee, cue, status, sortOrder, hardStop, createdAt, updatedAt)
       VALUES (?, ?, ?, '2026-09-22', ?, ?, ?, 60000, '', '', '', ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
        .bind(id, orgId, showId, id, id, type, status, order)
        .run();
    await item("report-item-1", "segment", "complete", 0);
    await item("report-item-2", "song", "upcoming", 1);
    await item("report-header", "header", "upcoming", 2);

    for (let index = 0; index < 3; index += 1) {
      await env.DB.prepare(
        `INSERT INTO service_assignment
         (id, orgId, showId, serviceDate, role, department, status, callTime, notes, responseNote, createdAt, updatedAt)
         VALUES (?, ?, ?, '2026-09-22', 'Camera', 'Video', ?, '', '', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
        .bind(
          `report-assignment-${index}`,
          orgId,
          showId,
          index < 2 ? "confirmed" : "assigned",
        )
        .run();
    }
    for (let index = 0; index < 2; index += 1) {
      await env.DB.prepare(
        `INSERT INTO incident
         (id, orgId, showId, category, severity, description, reportedBy, serviceDate, timestamp, status, assignedName)
         VALUES (?, ?, ?, 'video', 'low', 'Test', 'Tester', '2026-09-22', CURRENT_TIMESTAMP, 'open', '')`,
      )
        .bind(`report-incident-${index}`, orgId, showId)
        .run();
    }

    const result = await env.DB.prepare(MOBILE_REPORT_SUMMARY_SQL)
      .bind(orgId, orgId, orgId, orgId, orgId)
      .first<Record<string, number>>();
    expect(result).toMatchObject({
      itemCount: 2,
      completedItems: 1,
      incidentCount: 2,
      assignmentCount: 3,
      confirmedAssignments: 2,
      checklistCount: 0,
      completedChecks: 0,
    });
  });
});
