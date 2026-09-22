export const MOBILE_REPORT_SUMMARY_SQL = `WITH selected AS (
  SELECT id, serviceDate, name, location, status, scheduledStartTime
  FROM rundown WHERE orgId = ?
  ORDER BY serviceDate DESC, scheduledStartTime DESC, createdAt DESC LIMIT 100
), item_counts AS (
  SELECT showId,
    COUNT(CASE WHEN LOWER(TRIM(type)) NOT IN ('header', 'heading', 'section') THEN 1 END) AS itemCount,
    COUNT(CASE WHEN LOWER(TRIM(type)) NOT IN ('header', 'heading', 'section') AND status = 'complete' THEN 1 END) AS completedItems
  FROM rundown_item WHERE orgId = ? AND showId IN (SELECT id FROM selected) GROUP BY showId
), incident_counts AS (
  SELECT showId, COUNT(*) AS incidentCount FROM incident
  WHERE orgId = ? AND showId IN (SELECT id FROM selected) GROUP BY showId
), assignment_counts AS (
  SELECT showId, COUNT(*) AS assignmentCount,
    COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS confirmedAssignments
  FROM service_assignment WHERE orgId = ? AND showId IN (SELECT id FROM selected) GROUP BY showId
), checklist_counts AS (
  SELECT showId, COUNT(*) AS checklistCount,
    COUNT(CASE WHEN checked = 1 THEN 1 END) AS completedChecks
  FROM checklist_entry WHERE orgId = ? AND showId IN (SELECT id FROM selected) GROUP BY showId
)
SELECT selected.*,
  COALESCE(item_counts.itemCount, 0) AS itemCount,
  COALESCE(item_counts.completedItems, 0) AS completedItems,
  COALESCE(incident_counts.incidentCount, 0) AS incidentCount,
  COALESCE(assignment_counts.assignmentCount, 0) AS assignmentCount,
  COALESCE(assignment_counts.confirmedAssignments, 0) AS confirmedAssignments,
  COALESCE(checklist_counts.checklistCount, 0) AS checklistCount,
  COALESCE(checklist_counts.completedChecks, 0) AS completedChecks
FROM selected
LEFT JOIN item_counts ON item_counts.showId = selected.id
LEFT JOIN incident_counts ON incident_counts.showId = selected.id
LEFT JOIN assignment_counts ON assignment_counts.showId = selected.id
LEFT JOIN checklist_counts ON checklist_counts.showId = selected.id
ORDER BY selected.serviceDate DESC, selected.scheduledStartTime DESC`;
