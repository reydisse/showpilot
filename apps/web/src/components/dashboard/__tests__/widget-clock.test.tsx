import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useNow } from "../widget";

afterEach(() => vi.restoreAllMocks());

it("preserves the server snapshot during hydration, then ticks with the client clock", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  function OperatorClock() {
    const now = useNow();
    return <div><button>Operator control</button><output>{now ?? "Recorded time"}</output></div>;
  }
  const container = document.createElement("div");
  container.innerHTML = renderToString(<OperatorClock />);
  document.body.appendChild(container);
  const control = container.querySelector("button");
  expect(container.querySelector("output")?.textContent).toBe("Recorded time");
  const onRecoverableError = vi.fn();
  clock.mockReturnValue(9_000);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <OperatorClock />, { onRecoverableError }); });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBe(control);
    expect(container.querySelector("output")?.textContent).toBe("9000");
  } finally {
    await act(async () => root?.unmount());
    container.remove();
  }
});
