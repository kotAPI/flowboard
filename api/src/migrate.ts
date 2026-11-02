import { createPool } from "./lib/db.js";
import { migrate } from "./lib/migrate.js";

const pool = createPool();
await migrate(pool);
await pool.end();
