import type pg from "pg";
import { createPool } from "./lib/db.js";
import { migrate } from "./lib/migrate.js";
import { projectActivity } from "./modules/activity.js";
import type { DomainEvent } from "./modules/events.js";

const BATCH = 50;
const MAX_ATTEMPTS = 8;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 500);

type Handler = (db: pg.PoolClient, event: DomainEvent) => Promise<void>;

/**
 * Consumers of the outbox. Each must be idempotent (at-least-once delivery).
 *  - activity: builds the activity feed read model
 *  - webhook:  stub for the "task updated" webhook channel; logs the payload it would POST
 */
export const handlers: Record<string, Handler> = {
  activity: (db, e) => projectActivity(db, e as DomainEvent<any>),
  webhook: async (_db, e) => {
    if (!e.type.startsWith("task.") || process.env.WEBHOOK_LOG !== "true") return;
    console.log(JSON.stringify({ webhook: "would POST", url: process.env.WEBHOOK_URL ?? "(none configured)", body: e }));
  },
};

/**
 * One drain pass. Rows are claimed with FOR UPDATE SKIP LOCKED, so any number of worker replicas
 * can run side by side without double-processing a row. A failing event is retried with
 * exponential backoff and parked in dead_at after MAX_ATTEMPTS; other events keep flowing.
 */
export async function drainOnce(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, event_id, type, aggregate_id, payload, created_at, attempts FROM outbox
       WHERE processed_at IS NULL AND dead_at IS NULL AND available_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [BATCH],
    );
    for (const row of rows) {
      const event: DomainEvent = {
        eventId: row.event_id,
        type: row.type,
        aggregateId: row.aggregate_id,
        occurredAt: row.created_at,
        payload: row.payload,
      };
      try {
        await client.query("SAVEPOINT evt");
        for (const handle of Object.values(handlers)) await handle(client, event);
        await client.query("UPDATE outbox SET processed_at = now() WHERE id = $1", [row.id]);
        await client.query("RELEASE SAVEPOINT evt");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT evt");
        const attempts = row.attempts + 1;
        await client.query(
          `UPDATE outbox SET attempts = $2::int, last_error = $3,
             available_at = now() + make_interval(secs => $4::double precision),
             dead_at = CASE WHEN $2::int >= $5::int THEN now() END
           WHERE id = $1`,
          [row.id, attempts, String(err).slice(0, 2000), Math.min(2 ** attempts, 300), MAX_ATTEMPTS],
        );
        console.error(`event ${row.event_id} (${row.type}) failed, attempt ${attempts}:`, err);
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = createPool();
  await migrate(pool);
  console.log("worker: draining outbox");
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
  while (!stopping) {
    try {
      const n = await drainOnce(pool);
      if (n < BATCH) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error("worker: drain failed", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
