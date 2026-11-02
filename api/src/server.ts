import { buildApp } from "./app.js";
import { createPool } from "./lib/db.js";
import { migrate } from "./lib/migrate.js";
import { seed } from "./seed.js";

const pool = createPool();
await migrate(pool);
if (process.env.SEED_ON_BOOT !== "false") await seed(pool, { onlyIfEmpty: true });

const app = buildApp(pool, { logger: true });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "0.0.0.0", port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
