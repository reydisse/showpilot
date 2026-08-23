import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type TouchEvent,
} from "react";

interface DragSession {
  sourceItemId: string | null;
  targetItemId: string | null;
}

interface UseRundownDragReorderOptions {
  enabled: boolean;
  onReorder: (sourceItemId: string, targetItemId: string) => void;
}

export function useRundownDragReorder({
  enabled,
  onReorder,
}: UseRundownDragReorderOptions) {
  const sessionRef = useRef<DragSession>({
    sourceItemId: null,
    targetItemId: null,
  });
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dropTargetItemId, setDropTargetItemId] = useState<string | null>(null);

  const beginDrag = useCallback((itemId: string) => {
    sessionRef.current = { sourceItemId: itemId, targetItemId: itemId };
    setDraggedItemId(itemId);
    setDropTargetItemId(itemId);
  }, []);

  const setDropTarget = useCallback((itemId: string) => {
    sessionRef.current.targetItemId = itemId;
    setDropTargetItemId((current) => (current === itemId ? current : itemId));
  }, []);

  const cancelDrag = useCallback(() => {
    sessionRef.current = { sourceItemId: null, targetItemId: null };
    setDraggedItemId(null);
    setDropTargetItemId(null);
  }, []);

  const completeDrag = useCallback((targetItemId?: string) => {
    const sourceItemId = sessionRef.current.sourceItemId;
    const resolvedTargetItemId = targetItemId ?? sessionRef.current.targetItemId;
    cancelDrag();

    if (
      !enabled ||
      !sourceItemId ||
      !resolvedTargetItemId ||
      sourceItemId === resolvedTargetItemId
    ) {
      return;
    }

    onReorder(sourceItemId, resolvedTargetItemId);
  }, [cancelDrag, enabled, onReorder]);

  const handleDragStart = useCallback((event: DragEvent<HTMLElement>, itemId: string) => {
    if (!enabled) return;

    beginDrag(itemId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }, [beginDrag, enabled]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>, itemId: string) => {
    const sourceItemId = sessionRef.current.sourceItemId;
    if (!enabled || !sourceItemId || sourceItemId === itemId) return;

    // Browsers only dispatch `drop` when `dragover` is cancelled. The source
    // lives in a ref so this works immediately, before React's next render.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(itemId);
  }, [enabled, setDropTarget]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>, targetItemId: string) => {
    event.preventDefault();

    if (!sessionRef.current.sourceItemId) {
      sessionRef.current.sourceItemId = event.dataTransfer.getData("text/plain") || null;
    }
    completeDrag(targetItemId);
  }, [completeDrag]);

  const handleTouchStart = useCallback((itemId: string) => {
    if (!enabled) return;
    beginDrag(itemId);
  }, [beginDrag, enabled]);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const sourceItemId = sessionRef.current.sourceItemId;
    if (!enabled || !sourceItemId) return;

    const touch = event.touches[0];
    if (!touch) return;

    const element = document.elementFromPoint(touch.clientX, touch.clientY);
    const row = element?.closest<HTMLElement>("[data-rundown-item-id]");
    const targetItemId = row?.dataset.rundownItemId;
    if (!targetItemId || targetItemId === sourceItemId) return;

    event.preventDefault();
    setDropTarget(targetItemId);
  }, [enabled, setDropTarget]);

  const handleTouchEnd = useCallback(() => {
    completeDrag();
  }, [completeDrag]);

  return {
    draggedItemId,
    dropTargetItemId,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    cancelDrag,
  };
}
