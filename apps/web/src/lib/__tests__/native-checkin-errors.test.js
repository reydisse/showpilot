import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import * as queries from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// Run the actual native screens with web React, replacing native host APIs only.
function loadScreen(name, read, write = vi.fn()) {
  const container = ({ children }) => jsx.jsx("div", { children });
  const text = ({ children, accessibilityRole }) => jsx.jsx("span", { role: accessibilityRole, children });
  const button = ({ children, onPress, accessibilityLabel, disabled }) => jsx.jsx("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled, children });
  const modules = {
    react: React, "react/jsx-runtime": jsx, "@tanstack/react-query": queries,
    "@/lib/auth-client": { authClient: { useActiveOrganization: () => ({ data: { id: "org", slug: "demo", name: "Demo" }, isPending: false }) } },
    "@/lib/mobile-api": { getMobileCheckIn: read, getMobileShowBoard: read, setMobileCheckInStatus: write },
    "@/hooks/use-screen-polling": { useScreenPollingInterval: () => false },
    "@/lib/haptics": { notificationAsync: async () => {}, NotificationFeedbackType: { Success: "success" } },
    "@/components/page": { Page: container }, "@/components/loading-view": { LoadingView: () => null },
    "@/components/failure-text": { FailureText: text },
    "@/components/app-button": { AppButton: ({ label, ...props }) => button({ ...props, children: label }) },
    "@/theme/tokens": { createThemedStyles: () => () => ({}), useAppTheme: () => ({ colors: {} }) },
    "@/providers/workspace-provider": { useTerms: () => ({}) },
    "@showpilot/shared": { workspaceCopy: copy => copy },
    "@/lib/env": { SHOWPILOT_URL: "https://app.showpilot.tech" },
    "react-native-svg": { SvgUri: () => null },
    "expo-router": { Redirect: () => null, router: { push: vi.fn() } },
    "react-native": {
      View: container, Text: text, Pressable: button, Image: () => null, ActivityIndicator: () => null,
      TextInput: ({ value, onChangeText, accessibilityLabel }) => jsx.jsx("input", { value, onChange: event => onChangeText(event.target.value), "aria-label": accessibilityLabel }),
      FlatList: ({ ListHeaderComponent, data, renderItem, ListEmptyComponent }) => jsx.jsxs("div", { children: [ListHeaderComponent, data.length ? data.map((item) => jsx.jsx(React.Fragment, { children: renderItem({ item }) }, item.id)) : ListEmptyComponent] }),
      StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 390 }),
      Alert: { alert: vi.fn() }, Linking: {}, Share: {},
    },
  };
  const code = ts.transpileModule(readFileSync(resolve(process.cwd(), `../mobile/src/app/${name}.tsx`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exported = {};
  new Function("require", "exports", code)(key => {
    if (key.startsWith("lucide-react-native/")) return { default: () => null };
    if (!(key in modules)) throw new Error(`Unmocked native screen import ${key}`);
    return modules[key];
  }, exported);
  const client = new queries.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Screen = exported.default;
  render(jsx.jsx(queries.QueryClientProvider, { client, children: jsx.jsx(Screen, {}) }));
  return { client };
}
afterEach(cleanup);
const member = { id: "crew-1", memberId: "CREW001", name: "Ada", role: "Crew", photoUrl: "", isOnline: false, lastCheckIn: null, lastCheckOut: null };
const raw = '[{"path":["members",14,"lastCheckOut"],"message":"Invalid input: expected string, received number"}]';
it.each(["checkin", "show-board"])("%s hides schema/network payloads and reloads the crew on Tap to retry", async name => {
  const read = vi.fn().mockRejectedValueOnce(new Error(raw)).mockResolvedValue({ members: [member], clockFormat: "24hr", timeZone: "America/Toronto" });
  loadScreen(name, read);
  await screen.findByText("Crew could not load.");
  expect(document.body.textContent).not.toContain("lastCheckOut");
  fireEvent.click(screen.getByRole("button", { name: /Tap to retry/ }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("Crew could not load.")).toBeNull());
});
it("failed attendance has a human row error and retries the same intended status after a refreshed snapshot", async () => {
  const read = vi.fn().mockResolvedValue({ members: [member] });
  const write = vi.fn().mockRejectedValueOnce(new Error(raw)).mockResolvedValue({ member: { ...member, isOnline: true } });
  const { client } = loadScreen("checkin", read, write);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Browse crew" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check in" }));
  await screen.findByText("Attendance could not be updated.");
  expect(document.body.textContent).not.toContain("lastCheckOut");
  client.setQueryData(["mobile-checkin", "org"], { members: [{ ...member, isOnline: true }] });
  fireEvent.click(screen.getByRole("button", { name: /Tap to retry/ }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(write.mock.calls[1][0]).toEqual(write.mock.calls[0][0]);
  expect(write.mock.calls[1][0]).toMatchObject({ memberId: member.id, checkedIn: true });
  await waitFor(() => expect(screen.queryByText("Attendance could not be updated.")).toBeNull());
});
