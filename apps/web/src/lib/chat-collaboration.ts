import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";


async function assertChatMember(orgId: string) {
  const { user } = await assertOrgPermission(orgId, "chat:access");
  return user;
}

export interface ChatMemberSummary {
  userId: string;
  name: string;
  role: string;
  image: string | null;
}

export const getChatMembers = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<ChatMemberSummary[]> => {
    await assertChatMember(data.orgId);
    const members = await getPrisma().member.findMany({
      where: { organizationId: data.orgId },
      select: { userId: true, role: true, user: { select: { name: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
    return members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      role: member.role,
      image: member.user.image,
    }));
  });
