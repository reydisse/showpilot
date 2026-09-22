import { isHeaderItem, type RundownItem } from "@/types/rundown";

export interface ReportCueColumn {
  id: string;
  label: string;
  sortOrder: number;
}

export interface ReportCueNote {
  itemId: string;
  columnId: string;
  text: string;
}

export interface ReportCueRow {
  id: string;
  cueNumber: number;
  rundownItem: string;
  cameraAssignments: string;
  notes: string;
}

/**
 * Project the current cue-sheet model into the stable report/export shape.
 *
 * Cue notes are stored per department and rundown item. Reports historically
 * exposed one row with a single `cameraAssignments` string, so department
 * labels are retained in that field instead of dropping all but one column.
 */
export function buildReportCueRows(
  items: RundownItem[],
  columns: ReportCueColumn[],
  notes: ReportCueNote[],
): ReportCueRow[] {
  const orderedColumns = [...columns].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.label.localeCompare(right.label),
  );
  const columnById = new Map(
    orderedColumns.map((column) => [column.id, column]),
  );
  const notesByItem = new Map<string, ReportCueNote[]>();

  for (const note of notes) {
    if (!note.text.trim() || !columnById.has(note.columnId)) continue;
    const itemNotes = notesByItem.get(note.itemId) ?? [];
    itemNotes.push(note);
    notesByItem.set(note.itemId, itemNotes);
  }

  return items
    .filter((item) => !isHeaderItem(item))
    .map((item, index) => {
      const itemNotes = notesByItem.get(item.id) ?? [];
      itemNotes.sort((left, right) => {
        const leftColumn = columnById.get(left.columnId)!;
        const rightColumn = columnById.get(right.columnId)!;
        return leftColumn.sortOrder - rightColumn.sortOrder;
      });
      return {
        id: `cue-report:${item.id}`,
        cueNumber: index + 1,
        rundownItem: item.title,
        cameraAssignments: itemNotes
          .map(
            (note) =>
              `${columnById.get(note.columnId)!.label}: ${note.text.trim()}`,
          )
          .join("\n"),
        notes: item.notes ?? "",
      };
    })
    .filter(
      (row) => row.cameraAssignments.length > 0 || row.notes.trim().length > 0,
    );
}
