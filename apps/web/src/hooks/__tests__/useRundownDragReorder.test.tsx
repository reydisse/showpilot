import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRundownDragReorder } from "../useRundownDragReorder";

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();

  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) values.delete(format);
      else values.clear();
    },
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    setDragImage: () => undefined,
  };
}

function DragHarness({ onReorder }: { onReorder: (sourceId: string, targetId: string) => void }) {
  const drag = useRundownDragReorder({ enabled: true, onReorder });

  return (
    <div>
      {["first", "second"].map((itemId) => (
        <div
          key={itemId}
          data-testid={`row-${itemId}`}
          data-rundown-item-id={itemId}
          onDragOver={(event) => drag.handleDragOver(event, itemId)}
          onDrop={(event) => drag.handleDrop(event, itemId)}
        >
          <div
            draggable
            data-testid={`handle-${itemId}`}
            onDragStart={(event) => drag.handleDragStart(event, itemId)}
            onDragEnd={drag.cancelDrag}
          />
        </div>
      ))}
      <output data-testid="active-drag">{drag.draggedItemId ?? "none"}</output>
      <output data-testid="drop-target">{drag.dropTargetItemId ?? "none"}</output>
    </div>
  );
}

describe("useRundownDragReorder", () => {
  it("accepts a native browser drop and reports the requested reorder", () => {
    const calls: Array<[string, string]> = [];
    const dataTransfer = createDataTransfer();
    render(<DragHarness onReorder={(sourceId, targetId) => calls.push([sourceId, targetId])} />);

    fireEvent.dragStart(screen.getByTestId("handle-first"), { dataTransfer });
    const accepted = fireEvent.dragOver(screen.getByTestId("row-second"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("row-second"), { dataTransfer });

    expect(accepted).toBe(false);
    expect(calls).toEqual([["first", "second"]]);
    expect(screen.getByTestId("active-drag").textContent).toBe("none");
    expect(screen.getByTestId("drop-target").textContent).toBe("none");
  });

  it("does not reorder when an item is dropped on itself", () => {
    const calls: Array<[string, string]> = [];
    const dataTransfer = createDataTransfer();
    render(<DragHarness onReorder={(sourceId, targetId) => calls.push([sourceId, targetId])} />);

    fireEvent.dragStart(screen.getByTestId("handle-first"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("row-first"), { dataTransfer });

    expect(calls).toEqual([]);
  });
});
