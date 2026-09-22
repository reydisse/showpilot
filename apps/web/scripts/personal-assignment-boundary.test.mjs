import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("personal assignment reads and writes stay scoped to the signed-in crew identity", () => {
  const schedule = read("../src/lib/schedule.ts");
  const route = read("../src/routes/$slug/assignments.tsx");
  const notifications = read("../src/lib/assignment-notifications.server.ts");

  assert.match(
    schedule,
    /SELECT id, name FROM crew_member WHERE orgId = \? AND LOWER\(email\) = \? LIMIT 1/,
  );
  assert.match(
    schedule,
    /where:\s*\{\s*id: data\.assignmentId,\s*orgId: data\.orgId,\s*crewMemberId: crew\.id,/,
  );
  assert.match(
    schedule,
    /WHERE id = \? AND orgId = \? AND crewMemberId = \? AND status = 'assigned'/,
  );
  assert.match(route, /getMyAssignments/);
  assert.doesNotMatch(route, /schedule:view/);
  assert.match(
    notifications,
    /actionUrl: `assignments\?assignment=\$\{encodeURIComponent\(input\.assignmentId\)\}`/,
  );
});
