import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProPresenterSlideControls } from "../ProPresenterSlideControls";
afterEach(cleanup);
it("requires explicit Clear confirmation and Cancel never sends", () => {
  const onCommand = vi.fn();
  render(
    <ProPresenterSlideControls
      scope="show-one"
      disabled={false}
      onCommand={onCommand}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear slide" }));
  expect(onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCommand).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear slide" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Clear ProPresenter slide",
    }),
  );
  expect(onCommand).toHaveBeenCalledExactlyOnceWith("clear");
});
it("invalidates review when the show or target changes and explains why", () => {
  const onCommand = vi.fn();
  const f = render(
    <ProPresenterSlideControls
      scope="one"
      disabled={false}
      onCommand={onCommand}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear slide" }));
  f.rerender(
    <ProPresenterSlideControls
      scope="two"
      disabled={false}
      onCommand={onCommand}
    />,
  );
  expect(screen.getByText(/settings changed/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Clear ProPresenter slide",
    }),
  );
  expect(onCommand).not.toHaveBeenCalled();
});
it("keeps Previous and Next single-tap and respects disabled controls", () => {
  const onCommand = vi.fn();
  const f = render(
    <ProPresenterSlideControls
      scope="one"
      disabled={false}
      onCommand={onCommand}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
  fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
  expect(onCommand.mock.calls).toEqual([["previous"], ["next"]]);
  f.rerender(
    <ProPresenterSlideControls scope="one" disabled onCommand={onCommand} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
  expect(onCommand).toHaveBeenCalledTimes(2);
});
