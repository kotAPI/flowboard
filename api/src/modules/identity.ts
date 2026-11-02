import { jwtVerify, SignJWT } from "jose";
import type { Db } from "../lib/db.js";
import { unauthorized } from "../lib/errors.js";

export interface User {
  id: string;
  name: string;
  role: "admin" | "member";
}

const TOKEN_TTL_SECONDS = 15 * 60;

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 16) throw new Error("JWT_SECRET must be set (16+ chars)");
  return new TextEncoder().encode(value);
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query("SELECT id, name, role FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listUsers(db: Db): Promise<User[]> {
  const { rows } = await db.query("SELECT id, name, role FROM users ORDER BY id");
  return rows;
}

/**
 * Dev-only token issuer standing in for an OIDC provider. The token carries { userId, role } as the
 * brief asks, but the role claim is informational: authorization always re-reads the user row.
 */
export async function issueToken(user: User): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({ userId: user.id, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer("flowboard-dev")
    .sign(secret());
  return { token, expiresIn: TOKEN_TTL_SECONDS };
}

/**
 * The auth boundary. Accepts `Authorization: Bearer <jwt>` or the mock `X-User-Id` header
 * (when ALLOW_DEV_HEADER_AUTH is on). Returns the user loaded from the database; nothing about
 * identity or role is ever taken from the request body.
 */
export async function authenticate(db: Db, headers: Record<string, string | string[] | undefined>): Promise<User> {
  const auth = header(headers, "authorization");
  let userId: string | undefined;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) throw unauthorized("Authorization header must be 'Bearer <token>'");
    try {
      const { payload } = await jwtVerify(match[1]!, secret(), { issuer: "flowboard-dev", algorithms: ["HS256"] });
      userId = typeof payload.sub === "string" ? payload.sub : undefined;
    } catch {
      throw unauthorized("Token is invalid or expired");
    }
  } else if (process.env.ALLOW_DEV_HEADER_AUTH !== "false") {
    userId = header(headers, "x-user-id");
  }
  if (!userId) throw unauthorized();
  const user = await getUser(db, normaliseUserId(userId));
  if (!user) throw unauthorized("Unknown user");
  return user;
}

/** `X-User-Id: alice` and `X-User-Id: usr_alice` both work. */
function normaliseUserId(raw: string): string {
  const v = raw.trim().toLowerCase();
  return v.startsWith("usr_") ? v : `usr_${v}`;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}
