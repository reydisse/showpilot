// Client-side shim — Prisma only runs in the Worker (server).
// The client bundle must not import real Prisma modules.
export default {};
export const PrismaClient = undefined;
export const PrismaD1 = undefined;
