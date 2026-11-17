import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

export const getCspNonce = createIsomorphicFn().server(() => getRequestHeader("x-showpilot-csp-nonce")).client(() => undefined);
