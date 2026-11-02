import Button from "@radui/ui/Button";
import Callout from "@radui/ui/Callout";
import Drawer from "@radui/ui/Drawer";
import TextArea from "@radui/ui/TextArea";
import TextField from "@radui/ui/TextField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, del, get, patch, post } from "../api";
import { keys, useUsers } from "../hooks";
import { PRIORITIES, type Activity, type Board, type Priority, type Task } from "../types";
import { FieldInput } from "./FieldInput";
import { Check, Picker } from "./ui";

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
    <Drawer.Root open swipeDirection="right" onOpenChange={(open) => !open && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay />
        <Drawer.Content className="drawer">
        <header className="drawer-head">
          <Drawer.Title className="drawer-title">{taskId ? "Task details" : "New task"}</Drawer.Title>
          <span className="muted small">{board.list.name}</span>
          <span className="spacer" />
          <Button variant="ghost" size="small" className="icon-btn" aria-label="Close" onClick={onClose}>✕</Button>
        </header>
        {task.error && <Callout.Root color="red" role="alert" className="drawer-callout"><Callout.Text>{(task.error as Error).message}</Callout.Text></Callout.Root>}
        {!draft ? (
          <p className="muted">Loading…</p>
        ) : (
          <form className="drawer-body" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            <div className={`form-row ${fieldError("title") ? "has-error" : ""}`}>
              <label htmlFor="title">Title</label>
              <TextField id="title" value={draft.title} maxLength={500} required onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("title", e.target.value)} />
              {fieldError("title") && <span className="field-error">{fieldError("title")}</span>}
            </div>
            <div className="grid2">
              <div className={`form-row ${fieldError("statusKey") ? "has-error" : ""}`}>
                <label htmlFor="status">Status</label>
                <Picker id="status" label="Status" value={draft.statusKey} onChange={(v) => set("statusKey", v)}
                  options={board.statuses.map((st) => ({ value: st.key, label: st.name, swatch: st.color }))} />
                {fieldError("statusKey") && <span className="field-error">{fieldError("statusKey")}</span>}
              </div>
              <div className="form-row">
                <label htmlFor="priority">Priority</label>
                <Picker id="priority" label="Priority" value={draft.priority} onChange={(v) => set("priority", v as Priority)}
                  options={PRIORITIES.map((p) => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) }))} />
              </div>
              <div className="form-row">
                <label htmlFor="due">Due date</label>
                <TextField id="due" type="date" value={draft.dueDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("dueDate", e.target.value)} />
              </div>
              <div className="form-row">
                <span className="label">Assignees</span>
                <div className="multi" role="group" aria-label="Assignees">
                  {users.data?.map((u) => (
                    <Check key={u.id} checked={draft.assigneeIds.includes(u.id)}
                      onChange={(on) => set("assigneeIds", on ? [...draft.assigneeIds, u.id] : draft.assigneeIds.filter((x) => x !== u.id))}>
                      {u.name}
                    </Check>
                  ))}
                </div>
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="desc">Description</label>
              <TextArea id="desc" rows={3} value={draft.description} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set("description", e.target.value)} />
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
              <Callout.Root color="red" role="alert">
                <Callout.Text>
                  <strong>{error.body.code === "VERSION_CONFLICT" ? "Someone else edited this task." : error.message}</strong>{" "}
                  {error.body.code === "VERSION_CONFLICT" && (
                    <Button type="button" variant="soft" size="small" onClick={async () => { const t = await task.refetch(); if (t.data) setDraft(toDraft(t.data)); setError(null); }}>Load latest</Button>
                  )}
                </Callout.Text>
              </Callout.Root>
            )}
            <div className="drawer-actions">
              {taskId && <Button type="button" variant="ghost" color="red" onClick={() => remove.mutate()}>Delete</Button>}
              <span className="spacer" />
              {saved && <span className="saved" role="status">Saved</span>}
              <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : taskId ? "Save" : "Create task"}</Button>
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
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
