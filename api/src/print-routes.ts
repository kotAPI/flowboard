// Prints every /v1 route as a README table row skeleton: `npm run routes`.
import pg from "pg";
import { buildApp } from "./app.js";

process.env.JWT_SECRET ??= "unused-for-route-listing";
const app = buildApp(new pg.Pool());
await app.ready();
for (const r of app.routeList.filter((r) => r.includes(" /v1/"))) {
  const [method, url] = r.split(" ");
  console.log(`| \`${method}\` | \`${url}\` |  |`);
}
await app.close();
