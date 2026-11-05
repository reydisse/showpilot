import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import { createServerOnlyFn } from "@tanstack/react-start";
import { databaseRequestKey, markDatabaseWrite, requestDatabase, withPrimaryDatabase } from "./request-database.server";

// Revocation checks must never depend on replica lag. These models also cover
// Better Auth's adapter queries and membership helpers outside org-access.
const PRIMARY_MODELS: ReadonlySet<string> = new Set<Prisma.ModelName>(["User", "Session", "Account", "Verification", "RateLimit", "Member", "MemberPermissionGrant", "OrgMember", "Invitation"]);
const READ_OPERATIONS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);

function createPrisma() {
  return new PrismaClient({ adapter: new PrismaD1(requestDatabase) }).$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const write = !READ_OPERATIONS.has(operation);
        if (write) markDatabaseWrite();
        if (write || !model || PRIMARY_MODELS.has(model)) {
          return withPrimaryDatabase(async () => await query(args));
        }
        return query(args);
      },
    },
  });
}

// The installed Prisma/D1 engine batches queries across calls. Sharing it
// across HTTP requests fails workerd's I/O ownership checks, even after warmup.
// Reuse within a request/task without retaining another request's engine.
const clients = new WeakMap<object, ReturnType<typeof createPrisma>>();

export const getPrisma = createServerOnlyFn(() => {
  const key = databaseRequestKey();
  if (!key) return createPrisma();
  let client = clients.get(key);
  if (!client) { client = createPrisma(); clients.set(key, client); }
  return client;
});
