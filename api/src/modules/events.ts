import type { Db } from "../lib/db.js";
import { newId } from "../lib/ids.js";

/**
 * Domain events go through a transactional outbox: the row is written in the same transaction as
 * the change, so an event exists if and only if the change committed. The worker process drains
 * the table (see worker.ts). Swapping the worker's source for Kafka/SQS/NATS later only changes the
 * relay, not the producers.
 */
export interface DomainEvent<P = Record<string, unknown>> {
  eventId: string;
  type: string;
  aggregateId: string;
  occurredAt: string;
  payload: P;
}

export async function emit(db: Db, type: string, aggregateId: string, payload: Record<string, unknown>): Promise<string> {
  const eventId = newId("evt");
  await db.query(
    "INSERT INTO outbox (event_id, type, aggregate_id, payload) VALUES ($1, $2, $3, $4)",
    [eventId, type, aggregateId, JSON.stringify(payload)],
  );
  return eventId;
}
