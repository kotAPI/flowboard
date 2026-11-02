import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, del, get, patch, post } from "../api";
import { keys, useUsers } from "../hooks";
import { PRIORITIES, type Activity, type Board, type Priority, type Task } from "../types";
import { FieldInput } from "./FieldInput";

interface Draft {
  title: string;
  description: string;
  statusKey: string;
  priority: Priority;
  assigneeIds: string[];
  dueDate: string;
  customFields: Record<string, unknown>;
}

const toDraft = (t: Task): Draft => ({
  title: t.title,
  description: t.description ?? "",
  statusKey: t.statusKey,
  priority: t.priority,
  assigneeIds: t.assigneeIds,
  dueDate: t.dueDate ? t.dueDate.slice(0, 10) : "",
  customFields: t.customFields,
});

/**
 * Task detail drawer for create and edit. Built-ins + every field of the list's resolved schema.
 * Only changed custom fields are sent (PATCH merges; null clears), with the task version for
 * optimistic concurrency. Server validation errors are shown next to the field they name.
 */
export function TaskDrawer({ listId, board, taskId, initialStatus, onClose }: {
  listId: string; board: Board; taskId: string | null; initialStatus?: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const users = useUsers();
  const task = useQuery({ queryKey: keys.task(taskId ?? "new"), queryFn: () => get<Task>(`/v1/tasks/${taskId}`), enabled: !!taskId });
  const activity = useQuery({
    queryKey: keys.activity(taskId ?? "new"),
    queryFn: () => get<Activity[]>(`/v1/tasks/${taskId}/activity`),
    enabled: !!taskId,
    refetchInterval: 2000, // the feed is built asynchronously by the worker
  });
  const [draft, setDraft] = useState<Draft | null>(
    taskId ? null : { title: "", description: "", statusKey: initialStatus ?? board.statuses.find((s) => s.category === "not_started")?.key ?? board.statuses[0]!.key, priority: "none", assigneeIds: [], dueDate: "", customFields: {} },
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (task.data && !draft) setDraft(toDraft(task.data));
  }, [task.data, draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.board(listId) });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    if (taskId) qc.invalidateQueries({ queryKey: keys.task(taskId) });
  };

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const dueDate = d.dueDate ? new Date(`${d.dueDate}T12:00:00Z`).toISOString() : null;
      if (!taskId) {
        const customFields = Object.fromEntries(Object.entries(d.customFields).filter(([, v]) => v !== null && v !== undefined));
        return post<Task>(`/v1/lists/${listId}/tasks`, {
          title: d.title, description: d.description || null, statusKey: d.statusKey, priority: d.priority,
          assigneeIds: d.assigneeIds, dueDate, customFields,
        });
      }
      const original = task.data!;
      const changedFields = Object.fromEntries(
        [...new Set([...Object.keys(d.customFields), ...Object.keys(original.customFields)])]
          .filter((k) => JSON.stringify(d.customFields[k] ?? null) !== JSON.stringify(original.customFields[k] ?? null))
          .map((k) => [k, d.customFields[k] ?? null]),
      );
      return patch<Task>(`/v1/tasks/${taskId}`, {
        title: d.title, description: d.description || null, statusKey: d.statusKey, priority: d.priority,
        assigneeIds: d.assigneeIds, dueDate, version: original.version,
        ...(Object.keys(changedFields).length ? { customFields: changedFields } : {}),
      });
    },
    onSuccess: (t) => {
      setError(null);
      refresh();
      if (!taskId) onClose();
      else {
        qc.setQueryData(keys.task(taskId), t);
        setDraft(toDraft(t));
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err : new ApiError(0, { code: "NETWORK", message: String(err) })),
  });

  const remove = useMutation({
    mutationFn: () => del(`/v1/tasks/${taskId}`),
    onSuccess: () => { refresh(); onClose(); },
    onError: (err) => setError(err as ApiError),
  });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const fieldError = (path: string) => error?.detailFor(path);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={taskId ? "Task details" : "New task"} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{taskId ? "Task" : "New task"}</h2>
          <span className="muted small">{board.list.name}</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        {task.error && <p className="error" role="alert">{(task.error as Error).message}</p>}
        {!draft ? (
          <p className="muted">Loading…</p>
        ) : (
          <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <div className={`form-row ${fieldError("title") ? "has-error" : ""}`}>
              <label htmlFor="title">Title</label>
              <input id="title" value={draft.title} maxLength={500} required onChange={(e) => set("title", e.target.value)} />
              {fieldError("title") && <span className="field-error">{fieldError("title")}</span>}
            </div>
            <div className="grid2">
              <div className={`form-row ${fieldError("statusKey") ? "has-error" : ""}`}>
                <label htmlFor="status">Status</label>
                <select id="status" value={draft.statusKey} onChange={(e) => set("statusKey", e.target.value)}>
                  {board.statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
                {fieldError("statusKey") && <span className="field-error">{fieldError("statusKey")}</span>}
              </div>
              <div className="form-row">
                <label htmlFor="priority">Priority</label>
                <select id="priority" value={draft.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-row">
                <label htmlFor="due">Due date</label>
                <input id="due" type="date" value={draft.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
              </div>
              <div className="form-row">
                <span className="label">Assignees</span>
                <div className="multi" role="group" aria-label="Assignees">
                  {users.data?.map((u) => (
                    <label key={u.id} className="multi-opt">
                      <input type="checkbox" checked={draft.assigneeIds.includes(u.id)}
                        onChange={(e) => set("assigneeIds", e.target.checked ? [...draft.assigneeIds, u.id] : draft.assigneeIds.filter((x) => x !== u.id))} />
                      {u.name}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="desc">Description</label>
              <textarea id="desc" rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </div>
            {board.fields.length > 0 && (
              <fieldset className="custom-fields">
                <legend>Custom fields</legend>
                {board.fields.map((f) => (
                  <FieldInput key={f.key} field={f} value={draft.customFields[f.key]} error={fieldError(`customFields.${f.key}`)}
                    onChange={(v) => set("customFields", { ...draft.customFields, [f.key]: v })} />
                ))}
              </fieldset>
            )}
            {error && (
              <div className="error" role="alert">
                <strong>{error.body.code === "VERSION_CONFLICT" ? "Someone else edited this task." : error.message}</strong>
                {error.body.code === "VERSION_CONFLICT" && (
                  <button type="button" className="btn ghost" onClick={async () => { const t = await task.refetch(); if (t.data) setDraft(toDraft(t.data)); setError(null); }}>Load latest</button>
                )}
              </div>
            )}
            <div className="drawer-actions">
              {taskId && <button type="button" className="btn danger ghost" onClick={() => remove.mutate()}>Delete</button>}
              <span className="spacer" />
              {saved && <span className="saved" role="status">Saved</span>}
              <button type="submit" className="btn primary" disabled={save.isPending}>{save.isPending ? "Saving…" : taskId ? "Save" : "Create task"}</button>
            </div>
          </form>
        )}
        {taskId && (
          <section className="activity" aria-label="Activity">
            <h3>Activity</h3>
            {activity.data?.length ? (
              <ul>{activity.data.map((a) => <li key={a.id}><span>{a.summary}</span><time className="muted small">{new Date(a.createdAt).toLocaleString()}</time></li>)}</ul>
            ) : (
              <p className="muted small">No activity yet. The feed is filled by the background worker, so it can lag a second behind.</p>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
