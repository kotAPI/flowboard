import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { keys } from "../hooks";
import type { Board, Page, Task } from "../types";
import { Avatars, FieldValue, formatDate, isOverdue, PriorityBadge, StatusPill } from "./bits";

type Sort = "position" | "dueDate" | "priority";

/**
 * Dense list. Sorting, the custom-field filter and paging are done by the API
 * (GET /v1/lists/:id/tasks?sort=&order=&cf.<key>=&cursor=), so it works the same for 20 or 20k tasks.
 */
export function TableView({ board, onOpen }: { board: Board; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<Sort>("position");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const filterable = board.fields.filter((f) => f.type === "single_select" || f.type === "multi_select" || f.type === "checkbox");
  const [filterKey, setFilterKey] = useState<string>("");
  const [filterValue, setFilterValue] = useState<string>("");
  const filterField = filterable.find((f) => f.key === filterKey);

  const params = new URLSearchParams({ sort, order, limit: "25" });
  if (filterField && filterValue) params.set(`cf.${filterField.key}`, filterValue);
  const query = useInfiniteQuery({
    queryKey: [...keys.tasks(board.list.id, params.toString()), board.tasks.map((t) => t.version).join()],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set("cursor", pageParam);
      return api<Page<Task>>("GET", `/v1/lists/${board.list.id}/tasks?${p}`);
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  const sortBy = (s: Sort) => {
    if (s === sort) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(s);
      setOrder("asc");
    }
  };
  const arrow = (s: Sort) => (sort === s ? (order === "asc" ? " ↑" : " ↓") : "");

  return (
    <div className="table-wrap">
      <div className="toolbar">
        <label>
          Filter
          <select aria-label="Filter field" value={filterKey} onChange={(e) => { setFilterKey(e.target.value); setFilterValue(""); }}>
            <option value="">No filter</option>
            {filterable.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
          </select>
        </label>
        {filterField && (
          <select aria-label="Filter value" value={filterValue} onChange={(e) => setFilterValue(e.target.value)}>
            <option value="">Any</option>
            {filterField.type === "checkbox"
              ? [<option key="t" value="true">Checked</option>, <option key="f" value="false">Unchecked</option>]
              : filterField.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        )}
        <span className="spacer" />
        {sort !== "position" && <button className="btn ghost" onClick={() => { setSort("position"); setOrder("asc"); }}>Reset sort</button>}
      </div>
      <table className="tasks">
        <thead>
          <tr>
            <th>Title</th>
            <th>Status</th>
            <th>Assignees</th>
            <th><button className="th-sort" onClick={() => sortBy("priority")}>Priority{arrow("priority")}</button></th>
            <th><button className="th-sort" onClick={() => sortBy("dueDate")}>Due{arrow("dueDate")}</button></th>
            {board.fields.map((f) => <th key={f.key}>{f.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
              <td className="title-cell">{t.title}</td>
              <td><StatusPill status={board.statuses.find((s) => s.key === t.statusKey)} /></td>
              <td><Avatars ids={t.assigneeIds} /></td>
              <td><PriorityBadge priority={t.priority} /></td>
              <td className={isOverdue(t.dueDate) ? "overdue" : ""}>{formatDate(t.dueDate)}</td>
              {board.fields.map((f) => <td key={f.key}><FieldValue field={f} value={t.customFields[f.key]} /></td>)}
            </tr>
          ))}
          {!query.isLoading && rows.length === 0 && (
            <tr><td colSpan={5 + board.fields.length} className="muted center">No tasks match.</td></tr>
          )}
        </tbody>
      </table>
      {query.hasNextPage && (
        <button className="btn ghost load-more" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
