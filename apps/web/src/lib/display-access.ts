import { createServerFn } from "@tanstack/react-start";
import { getRequest, setCookie } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission } from "./org-access";
import { parseOrThrow } from "./validation";
import {
  authenticateDisplayRequest,
  displayCookieName,
  issueDisplayPass,
  type DisplaySurface,
} from "./display-access.server";

const input = z.object({
  orgSlug: z.string().min(1).max(128),
  surface: z.enum(["timer", "overlay"]),
});
async function resolveOrg(slug: string) {
  const org = await env.DB.prepare("SELECT id FROM organization WHERE slug = ?")
    .bind(slug)
    .first<{ id: string }>();
  return org?.id ?? null;
}
async function requireDisplayMember(orgId: string, surface: DisplaySurface) {
  await assertOrgPermission(
    orgId,
    surface === "timer"
      ? ["show:view", "rundown:view", "timecode:access"]
      : ["lowerthird:view", "lowerthird:trigger"],
  );
}

type DisplaySessionResult =
  | { authorized: true; expiresAt: number }
  | { authorized: false; reason: "not-found" | "access-denied" };

export const ensureDisplaySession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      input.extend({ token: z.string().min(1).max(4096).optional() }),
      data,
    ),
  )
  .handler(async ({ data }): Promise<DisplaySessionResult> => {
    const orgId = await resolveOrg(data.orgSlug);
    if (!orgId) return { authorized: false, reason: "not-found" };
    const request = getRequest();
    const headers = new Headers(request.headers);
    if (data.token) headers.set("x-showpilot-display-pass", data.token);
    const presented = new Request(request.url, { headers });
    const authority = await authenticateDisplayRequest(
      env.DB,
      presented,
      orgId,
      data.surface,
      env.KIOSK_SECRET,
    );
    if (authority) {
      if (
        !data.token &&
        authority.expiresAt - Date.now() < 60_000 &&
        env.KIOSK_SECRET
      ) {
        try {
          await requireDisplayMember(orgId, data.surface);
          const renewed = await issueDisplayPass(
            orgId,
            data.surface,
            env.KIOSK_SECRET,
          );
          setCookie(displayCookieName(orgId, data.surface), renewed.token, {
            httpOnly: true,
            secure: new URL(request.url).protocol === "https:",
            sameSite: "lax",
            path: "/",
            maxAge: Math.floor(
              (renewed.authority.expiresAt - Date.now()) / 1000,
            ),
          });
          return { authorized: true, expiresAt: renewed.authority.expiresAt };
        } catch {
          /* A shared pass remains valid until its original deadline. */
        }
      }
      if (data.token)
        setCookie(displayCookieName(orgId, data.surface), data.token, {
          httpOnly: true,
          secure: new URL(request.url).protocol === "https:",
          sameSite: "lax",
          path: "/",
          maxAge: Math.floor((authority.expiresAt - Date.now()) / 1000),
        });
      return { authorized: true, expiresAt: authority.expiresAt };
    }
    // An explicitly supplied invalid pass must never silently turn into another scope.
    if (data.token) return { authorized: false, reason: "access-denied" };
    try {
      await requireDisplayMember(orgId, data.surface);
    } catch {
      return { authorized: false, reason: "access-denied" };
    }
    if (!env.KIOSK_SECRET) throw new Error("Display access is unavailable.");
    const issued = await issueDisplayPass(
      orgId,
      data.surface,
      env.KIOSK_SECRET,
    );
    setCookie(displayCookieName(orgId, data.surface), issued.token, {
      httpOnly: true,
      secure: new URL(request.url).protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor((issued.authority.expiresAt - Date.now()) / 1000),
    });
    return { authorized: true, expiresAt: issued.authority.expiresAt };
  });

export const createDisplayLink = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(input, data))
  .handler(async ({ data }) => {
    const orgId = await resolveOrg(data.orgSlug);
    if (!orgId)
      throw new Error("Organization not found. Check the display address.");
    await requireDisplayMember(orgId, data.surface);
    if (!env.KIOSK_SECRET) throw new Error("Display access is unavailable.");
    const issued = await issueDisplayPass(
      orgId,
      data.surface,
      env.KIOSK_SECRET,
    );
    return {
      path: `/${data.surface}/${encodeURIComponent(data.orgSlug)}?${new URLSearchParams({ displayPass: issued.token })}`,
      expiresAt: issued.authority.expiresAt,
    };
  });
