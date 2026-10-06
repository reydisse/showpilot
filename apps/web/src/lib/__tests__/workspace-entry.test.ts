import { expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { Route } from "../../routes/$slug/index";

it.each([
  { modules: ["show", "rundown", "team", "board"], destination: "/$slug/board" },
  { modules: ["show", "rundown", "team"], destination: "/$slug/show" },
])("opens $destination when the workspace enables $modules", ({ modules, destination }) => {
  const beforeLoad = Route.options.beforeLoad;
  if (!beforeLoad) throw new Error("Workspace entry must choose a destination");
  const workspace = resolveWorkspaceProfile({ "workspace-modules": JSON.stringify(modules) });
  try {
    Reflect.apply(beforeLoad, undefined, [{ params: { slug: "test-workspace" }, context: { workspace } }]);
  } catch (error) {
    expect(isRedirect(error)).toBe(true);
    if (isRedirect(error)) {
      expect(error.options).toMatchObject({ to: destination, params: { slug: "test-workspace" } });
    }
    return;
  }
  throw new Error("Workspace entry did not redirect");
});
