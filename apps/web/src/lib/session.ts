import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";

export const getSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.getSession({ headers });
  }
);

export const getSessionWithOrg = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
    if (!session) return null;

    const orgId = session.session.activeOrganizationId;
    if (!orgId) return { ...session, org: null };

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
    });
    return { ...session, org };
  }
);

export const getOrgBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.organization.findUnique({
      where: { slug: data },
    });
  });

export const setActiveOrg = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: data },
    });
  });
