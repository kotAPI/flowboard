import { useEffect, useState } from "react";

/** Tiny hash router: #/lists/<id>/<view> or #/config/<nodeId>. Keeps the app shareable by URL. */
export type Route =
  | { page: "home" }
  | { page: "list"; listId: string; view: "board" | "table" }
  | { page: "config"; nodeId: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "lists" && parts[1]) return { page: "list", listId: parts[1], view: parts[2] === "table" ? "table" : "board" };
  if (parts[0] === "config" && parts[1]) return { page: "config", nodeId: parts[1] };
  return { page: "home" };
}

export function href(route: Route): string {
  if (route.page === "list") return `#/lists/${route.listId}/${route.view}`;
  if (route.page === "config") return `#/config/${route.nodeId}`;
  return "#/";
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (r) => (window.location.hash = href(r))];
}
