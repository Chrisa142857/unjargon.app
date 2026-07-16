import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Cache the client on globalThis so Next.js dev hot-reload doesn't leak
// connections by re-instantiating the pool on every recompile.
const globalForDb = globalThis as unknown as {
  __unjargonSql?: ReturnType<typeof postgres>;
};

const sql =
  globalForDb.__unjargonSql ??
  postgres(process.env.DATABASE_URL!, { max: 10 });
globalForDb.__unjargonSql = sql;

export const db = drizzle(sql, { schema });
export * as tables from "./schema";
