import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialSettingInput } from "../CredentialSettingInput";
import type { CredentialChange } from "@/lib/credential-fields";
afterEach(cleanup);
function Harness({ save, initial = true }: { save: (change: CredentialChange) => Promise<void>; initial?: boolean }) {
  const [configured, setConfigured] = useState(initial);
  return <CredentialSettingInput label="Fixture password" configured={configured} save={async change => { await save(change); setConfigured(change.action !== "clear"); }} />;
}
it("never retrieves or resubmits a stored value on blur and clears the replacement draft only after acknowledgement", async () => {
  let finish = () => {};
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<Harness save={save} />);
  const input = screen.getByLabelText("Fixture password") as HTMLInputElement;
  expect(input.value).toBe("");
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "replacement" } });
  fireEvent.blur(input);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
  expect(save).toHaveBeenCalledExactlyOnceWith({ action: "replace", value: "replacement" });
  expect(input.value).toBe("replacement");
  expect(input.disabled).toBe(true);
  await act(async () => finish());
  await waitFor(() => expect(input.value).toBe(""));
  expect(screen.getByText("Credential saved. Leave this blank to keep it.")).toBeTruthy();
});
it("keeps a failed draft and shows the failure so the operator can retry", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Encryption unavailable")).mockResolvedValueOnce(undefined);
  render(<Harness save={save} initial={false} />);
  const input = screen.getByLabelText("Fixture password") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "new-credential" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Encryption unavailable");
  expect(input.value).toBe("new-credential");
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
  await waitFor(() => expect(input.value).toBe(""));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("requires confirmation before clearing and leaves the saved credential intact when cancelled", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<Harness save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear credential" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear credential" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear credential" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledExactlyOnceWith({ action: "clear" });
  expect(screen.getByText("No credential saved.")).toBeTruthy();
});
