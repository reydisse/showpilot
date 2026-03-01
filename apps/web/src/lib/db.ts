import { PrismaClient } from "@/generated/prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import { env } from "cloudflare:workers";

export function getPrisma() {
  const adapter = new PrismaD1(env.DB);
  return new PrismaClient({ adapter });
}
