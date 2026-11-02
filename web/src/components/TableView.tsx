import Button from "@radui/ui/Button";
import Table from "@radui/ui/Table";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { keys } from "../hooks";
import type { Board, Page, Task } from "../types";
import { Avatars, FieldValue, formatDate, isOverdue, PriorityBadge, StatusPill } from "./bits";
import { Picker } from "./ui";

const ANY = "__any";

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
        <span className="muted">Filter</span>
        <Picker label="Filter field" value={filterKey || ANY} onChange={(v) => { setFilterKey(v === ANY ? "" : v); setFilterValue(""); }}
          options={[{ value: ANY, label: "No filter" }, ...filterable.map((f) => ({ value: f.key, label: f.name }))]} />
        {filterField && (
          <Picker key={filterField.key} label="Filter value" value={filterValue || ANY} onChange={(v) => setFilterValue(v === ANY ? "" : v)}
            options={[{ value: ANY, label: "Any" }, ...(filterField.type === "checkbox"
              ? [{ value: "true", label: "Checked" }, { value: "false", label: "Unchecked" }]
              : filterField.options.map((o) => ({ value: o.id, label: o.label, swatch: o.color ?? undefined })))]} />
        )}
        <span className="spacer" />
        {sort !== "position" && <Button variant="ghost" size="small" onClick={() => { setSort("position"); setOrder("asc"); }}>Reset sort</Button>}
      </div>
      <Table.Root className="tasks">
        <Table.Head>
          <Table.Row>
            <Table.ColumnCellHeader>Title</Table.ColumnCellHeader>
            <Table.ColumnCellHeader>Status</Table.ColumnCellHeader>
            <Table.ColumnCellHeader>Assignees</Table.ColumnCellHeader>
            <Table.ColumnCellHeader><button className="th-sort" onClick={() => sortBy("priority")}>Priority{arrow("priority")}</button></Table.ColumnCellHeader>
            <Table.ColumnCellHeader><button className="th-sort" onClick={() => sortBy("dueDate")}>Due{arrow("dueDate")}</button></Table.ColumnCellHeader>
            {board.fields.map((f) => <Table.ColumnCellHeader key={f.key}>{f.name}</Table.ColumnCellHeader>)}
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((t) => (
            <Table.Row key={t.id} onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
              <Table.Cell className="title-cell">{t.title}</Table.Cell>
              <Table.Cell><StatusPill status={board.statuses.find((s) => s.key === t.statusKey)} /></Table.Cell>
              <Table.Cell><Avatars ids={t.assigneeIds} /></Table.Cell>
              <Table.Cell><PriorityBadge priority={t.priority} /></Table.Cell>
              <Table.Cell className={isOverdue(t.dueDate) ? "overdue" : ""}>{formatDate(t.dueDate)}</Table.Cell>
              {board.fields.map((f) => <Table.Cell key={f.key}><FieldValue field={f} value={t.customFields[f.key]} /></Table.Cell>)}
            </Table.Row>
          ))}
          {!query.isLoading && rows.length === 0 && (
            <Table.Row><Table.Cell colSpan={5 + board.fields.length} className="muted center">No tasks match.</Table.Cell></Table.Row>
          )}
        </Table.Body>
      </Table.Root>
      {query.hasNextPage && (
        <Button variant="soft" className="load-more" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
