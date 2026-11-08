import { z } from "zod";
import {
  profileNameCommandSchema,
  profileRequestSchema,
} from "./account-profile-contract";
import {
  AccountProfileError,
  profileActor,
  checkProfileRequest,
  profilePhotoKey,
  readAccountProfile,
  writeAccountProfile,
} from "./account-profile.server";
import {
  readRequestBytesWithinLimit,
  readRequestJsonWithinLimit,
} from "./request-body.server";
import { isAllowedApiOrigin } from "./auth-origins";

export async function handleAccountProfileRequest(
  request: Request,
  storage: Pick<R2Bucket, "put">,
): Promise<Response> {
  const respond = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  try {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/user/profile")
      return respond(await readAccountProfile(request.headers));
    if (request.method !== "POST")
      return respond({ error: "Method not allowed" }, 405);
    if (!isAllowedApiOrigin(request.headers.get("origin"), request.url))
      return respond(
        { error: "Profile changes require an allowed origin." },
        403,
      );
    const actor = await profileActor(request.headers);
    if (path === "/api/user/profile") {
      const body = await readRequestJsonWithinLimit(request, 4_096);
      if (!body.ok)
        return respond(
          { error: "Profile change could not be read." },
          body.status,
        );
      return respond(
        await writeAccountProfile(
          request.headers,
          profileNameCommandSchema.parse(body.value),
        ),
      );
    }
    const body = await readRequestBytesWithinLimit(request, 3 * 1024 * 1024);
    if (!body.ok)
      return respond(
        { error: "Photo must be smaller than 2 MB." },
        body.status,
      );
    let form: FormData;
    try {
      form = await new Response(body.buffer, {
        headers: request.headers,
      }).formData();
    } catch {
      return respond({ error: "Photo upload could not be read." }, 400);
    }
    const command = profileRequestSchema.parse({
      userId: form.get("userId"),
      requestId: form.get("requestId"),
      expectedRevision: form.has("expectedRevision")
        ? Number(form.get("expectedRevision"))
        : undefined,
    });
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.type !== "image/jpeg" ||
      !file.size ||
      file.size > 2 * 1024 * 1024
    )
      return respond({ error: "Choose a JPEG photo smaller than 2 MB." }, 400);
    const bytes = await file.arrayBuffer();
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const photo = { ...command, kind: "photo", hash } satisfies Parameters<
      typeof writeAccountProfile
    >[1];
    await checkProfileRequest(actor, photo);
    // Content-addressed bytes cannot mutate a previously published photo.
    // Upload precedes D1 publication; unused versions remain available for retry
    // and are removed by account deletion with the rest of this user's versions.
    await storage.put(profilePhotoKey(actor.userId, hash), bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    return respond(await writeAccountProfile(request.headers, photo));
  } catch (error) {
    if (error instanceof AccountProfileError)
      return respond({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return respond({ error: "Check the profile change and try again." }, 400);
    console.error(
      JSON.stringify({ message: "Profile change could not be confirmed" }),
    );
    return respond(
      {
        error:
          "Profile change could not be confirmed. It may have saved; retry the same change.",
      },
      500,
    );
  }
}
