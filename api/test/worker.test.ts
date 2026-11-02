import { describe, expect, it } from "vitest";
import { drainOnce, handlers } from "../src/worker.js";
import { alice, ctx, SEED, useTestApp } from "./helpers.js";

useTestApp();

describe("Outbox -> activity worker", () => {
  it("task changes produce events in the same transaction and the worker projects them", async () => {
    const created = (await alice.post(`/v1/lists/${SEED.lists.sprint}/tasks`, { title: "Ship it", customFields: { component: "opt_api" } })).body.data;
    await alice.post(`/v1/tasks/${created.id}/move`, { statusKey: "done" });
    // eventually consistent: nothing in the feed until the worker runs
    expect((await alice.get(`/v1/tasks/${created.id}/activity`)).body.data).toEqual([]);
    await drainOnce(ctx.pool);
    const feed = (await alice.get(`/v1/tasks/${created.id}/activity`)).body.data.map((a: any) => a.summary);
    expect(feed).toEqual(['Alice moved "Ship it" to Done', 'Alice created "Ship it"']);
  });

  it("a rejected change emits no event", async () => {
    await alice.post(`/v1/lists/${SEED.lists.backlog}/tasks`, { title: "invalid" }); // missing required field
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM outbox");
    expect(rows[0].n).toBe(0);
  });

  it("is idempotent under redelivery", async () => {
    await alice.post(`/v1/lists/${SEED.lists.sprint}/tasks`, { title: "Once", customFields: { component: "opt_api" } });
    await drainOnce(ctx.pool);
    await ctx.pool.query("UPDATE outbox SET processed_at = NULL"); // simulate crash before ack
    await drainOnce(ctx.pool);
    const { rows } = await ctx.pool.query("SELECT count(*)::int AS n FROM activity");
    expect(rows[0].n).toBe(1);
  });

  it("a poison event is retried with backoff without blocking the others", async () => {
    await ctx.pool.query(`INSERT INTO outbox (event_id, type, aggregate_id, payload) VALUES ('evt_bad', 'task.created', 'tsk_x', '{}')`);
    await alice.post(`/v1/lists/${SEED.lists.sprint}/tasks`, { title: "Good", customFields: { component: "opt_api" } });
    handlers.poison = async (_db, e) => {
      if (e.eventId === "evt_bad") throw new Error("downstream unavailable");
    };
    try {
      await drainOnce(ctx.pool);
    } finally {
      delete handlers.poison;
    }
    const { rows } = await ctx.pool.query("SELECT event_id, attempts, processed_at, available_at > now() AS backoff FROM outbox ORDER BY id");
    expect(rows[0]).toMatchObject({ event_id: "evt_bad", attempts: 1, processed_at: null, backoff: true });
    expect(rows[1].processed_at).not.toBeNull();
  });
});
