import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { reviewShowCreationSchema } from "./show-creation-contract";
import { parseOrThrow } from "./validation";
export const reviewShowCreation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(reviewShowCreationSchema, data),
  )
  .handler(async ({ data }) => {
    const { reviewShowCreationRequest } =
      await import("./show-creation-review.server");
    return reviewShowCreationRequest(getRequestHeaders(), data);
  });
