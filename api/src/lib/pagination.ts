import { badRequest } from "./errors.js";

/** Opaque keyset cursor: base64url of [sortValue, id] of the last row on the previous page. */
export function encodeCursor(value: unknown, id: string): string {
  return Buffer.from(JSON.stringify([value, id])).toString("base64url");
}

export function decodeCursor(cursor: string): [unknown, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string") return parsed as [unknown, string];
  } catch {}
  throw badRequest("INVALID_CURSOR", "cursor is malformed");
}

export function page<T>(items: T[], limit: number, cursorOf: (last: T) => string) {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  return { data, page: { nextCursor: hasMore && data.length ? cursorOf(data[data.length - 1]!) : null, limit } };
}
