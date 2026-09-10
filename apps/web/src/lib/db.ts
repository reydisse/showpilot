import { PrismaClient } from "@/generated/prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import { env } from "cloudflare:workers";

export function getPrisma() {
  // Server functions often redirect into a loader immediately after a write
  // (for example, creating and opening a show). Anchor each request's first
  // query to primary so that loader cannot observe a stale replica and report
  // the row it just created as missing. The session keeps later queries
  // sequentially consistent while Prisma only relies on prepare/batch.
  const database = env.DB.withSession("first-primary") as unknown as D1Database;
  const adapter = new PrismaD1(database);
  return new PrismaClient({ adapter });
}
