import Button from "@radui/ui/Button";
import Callout from "@radui/ui/Callout";
import TextField from "@radui/ui/TextField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, containerPath, del, get, patch, post } from "../api";
import { findNode, keys, useTree } from "../hooks";
import { Check, Picker } from "./ui";
import { CATEGORIES, FIELD_TYPES, type FieldDef, type FieldType, type ResolvedField, type ResolvedStatus, type StatusCategory, type StatusDef, type TreeNode } from "../types";

/**
 * Config for one container: its *resolved* statuses (what boards below it show) next to what is
 * defined *locally* here. Every row says where it comes from, and actions are phrased as the
 * inheritance operation they perform: override, hide, revert, remove.
 */
export function ConfigPanel({ nodeId, node }: { nodeId: string; node: { node: TreeNode; path: TreeNode[] } | null }) {
  if (!node) return <div className="empty muted">Loading…</div>;
  const base = containerPath(node.node.type, nodeId);
  return (
    <div className="config">
      <nav className="crumbs muted small">{node.path.map((n) => n.name).join(" / ")}</nav>
      <h1>
        {node.node.name} <span className="muted small">{node.node.type}</span>
      </h1>
      <p className="muted">
        Statuses and fields set here apply to this {node.node.type} and everything below it, unless a lower level overrides them.
      </p>
      <StatusConfig base={base} nodeId={nodeId} />
      {node.node.type !== "workspace" && <FieldConfig base={base} nodeId={nodeId} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["config"] });
    qc.invalidateQueries({ queryKey: ["board"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
}

function StatusConfig({ base, nodeId }: { base: string; nodeId: string }) {
  const tree = useTree();
  const invalidate = useInvalidateAll();
  const q = useQuery({ queryKey: keys.config(nodeId, "statuses"), queryFn: () => get<{ local: StatusDef[]; resolved: ResolvedStatus[] }>(`${base}/statuses`) });
  const [error, setError] = useState<ApiError | null>(null);
  /** a status change that removes an in-use status: retry with remapTo once the user picks a target */
  const [pending, setPending] = useState<{ run: (remapTo?: string) => Promise<unknown>; err: ApiError } | null>(null);
  const [remapTo, setRemapTo] = useState("");

  const run = useMutation({
    mutationFn: (v: { fn: (remapTo?: string) => Promise<unknown>; remapTo?: string }) => v.fn(v.remapTo),
    onSuccess: () => { setError(null); setPending(null); invalidate(); },
    onError: (err, v) => {
      if (err instanceof ApiError && err.body.code === "STATUS_IN_USE" && !v.remapTo) {
        // ask which status the affected tasks should move to, then retry with ?remapTo=
        setPending({ run: (r) => v.fn(r), err });
        setRemapTo("");
        setError(null);
      } else setError(err as ApiError);
    },
  });
  const attempt = (fn: (remapTo?: string) => Promise<unknown>) => run.mutate({ fn });

  if (!q.data) return <section className="panel"><h2>Statuses</h2><p className="muted">Loading…</p></section>;
  const { local, resolved } = q.data;
  const localByKey = new Map(local.map((d) => [d.key, d]));
  const hidden = local.filter((d) => d.hidden);
  const ownerName = (id: string) => findNode(tree.data, id)?.node.name ?? id;

  const move = (i: number, dir: -1 | 1) => {
    const order = resolved.map((s) => s.key);
    const [k] = order.splice(i, 1);
    order.splice(i + dir, 0, k!);
    attempt(() => post(`${base}/statuses/reorder`, { keys: order }));
  };

  return (
    <section className="panel" aria-label="Statuses">
      <h2>Statuses</h2>
      <table className="config-table">
        <thead><tr><th /><th>Status</th><th>Key</th><th>Category</th><th>Source</th><th /></tr></thead>
        <tbody>
          {resolved.map((s, i) => {
            const def = localByKey.get(s.key);
            const isOverride = !!def && s.originOwnerId !== nodeId;
            return (
              <StatusRow
                key={s.key}
                status={s}
                source={!def ? `inherited from ${ownerName(s.ownerId)}` : isOverride ? `overrides ${ownerName(s.originOwnerId)}` : "defined here"}
                local={def}
                canUp={i > 0}
                canDown={i < resolved.length - 1}
                onMove={(dir) => move(i, dir)}
                onSave={(p) => attempt(() => (def ? patch(`/v1/statuses/${def.id}`, p) : post(`${base}/statuses`, { key: s.key, ...p })))}
                onHide={() => attempt((r) => post(`${base}/statuses${r ? `?remapTo=${r}` : ""}`, { key: s.key, hidden: true }))}
                onRemove={def ? () => attempt((r) => del(`/v1/statuses/${def.id}${r ? `?remapTo=${r}` : ""}`)) : undefined}
                removeLabel={isOverride ? "Revert" : "Remove"}
              />
            );
          })}
        </tbody>
      </table>
      {hidden.length > 0 && (
        <p className="muted small">
          Hidden here:{" "}
          {hidden.map((d) => (
            <Button key={d.id} variant="ghost" size="small" onClick={() => attempt(() => del(`/v1/statuses/${d.id}`))}>{d.key} (unhide)</Button>
          ))}
        </p>
      )}
      <AddStatus onAdd={(body) => attempt(() => post(`${base}/statuses`, body))} />
      {pending && (
        <Callout.Root color="amber" role="alert" className="remap">
          <Callout.Text>
            <strong>Tasks still use this status.</strong> {pending.err.body.details?.map((d) => d.message).join("; ")}
          </Callout.Text>
          <div className="add-row">
            <span>Move those tasks to</span>
            <Picker label="Remap tasks to" value={remapTo} onChange={setRemapTo}
              options={resolved.filter((s) => !pending.err.body.details?.some((d) => d.statusKey === s.key)).map((s) => ({ value: s.key, label: s.name, swatch: s.color }))} />
            <Button disabled={!remapTo} onClick={() => run.mutate({ fn: pending.run, remapTo })}>Apply and move tasks</Button>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </Callout.Root>
      )}
      {error && <ErrorBox error={error} />}
    </section>
  );
}

function StatusRow({ status, source, local, canUp, canDown, onMove, onSave, onHide, onRemove, removeLabel }: {
  status: ResolvedStatus; source: string; local?: StatusDef; canUp: boolean; canDown: boolean;
  onMove: (dir: -1 | 1) => void; onSave: (p: { name: string; color: string; category: StatusCategory }) => void;
  onHide: () => void; onRemove?: () => void; removeLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  const [category, setCategory] = useState<StatusCategory>(status.category);
  return (
    <tr>
      <td className="order">
        <Button variant="ghost" size="small" className="icon-btn" aria-label={`Move ${status.name} up`} disabled={!canUp} onClick={() => onMove(-1)}>↑</Button>
        <Button variant="ghost" size="small" className="icon-btn" aria-label={`Move ${status.name} down`} disabled={!canDown} onClick={() => onMove(1)}>↓</Button>
      </td>
      <td>
        {editing ? (
          <span className="inline-edit">
            <input type="color" aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value)} />
            <TextField aria-label="Status name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
          </span>
        ) : (
          <span className="pill" style={{ "--c": status.color } as React.CSSProperties}><span className="dot" />{status.name}</span>
        )}
      </td>
      <td><code>{status.key}</code></td>
      <td>
        {editing ? (
          <Picker label="Category" value={category} onChange={(v) => setCategory(v as StatusCategory)} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
        ) : status.category}
      </td>
      <td className="muted small">{source}</td>
      <td className="actions">
        {editing ? (
          <>
            <Button size="small" onClick={() => { onSave({ name, color, category }); setEditing(false); }}>Save</Button>
            <Button variant="ghost" size="small" onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="small" onClick={() => setEditing(true)}>{local ? "Edit" : "Override"}</Button>
            {status.inherited && !local && <Button variant="ghost" size="small" onClick={onHide}>Hide</Button>}
            {onRemove && <Button variant="ghost" size="small" onClick={onRemove}>{removeLabel}</Button>}
          </>
        )}
      </td>
    </tr>
  );
}

function AddStatus({ onAdd }: { onAdd: (body: { key: string; name: string; category: StatusCategory; color: string }) => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<StatusCategory>("active");
  const [color, setColor] = useState("#8b5cf6");
  const key = slug(name);
  return (
    <form className="add-row" onSubmit={(e) => { e.preventDefault(); if (key) { onAdd({ key, name, category, color }); setName(""); } }}>
      <input type="color" aria-label="New status colour" value={color} onChange={(e) => setColor(e.target.value)} />
      <TextField aria-label="New status name" placeholder="New status name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
      <Picker label="New status category" value={category} onChange={(v) => setCategory(v as StatusCategory)} options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
      {key && <code className="muted small">{key}</code>}
      <Button type="submit" variant="soft" disabled={!key}>Add status</Button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

function FieldConfig({ base, nodeId }: { base: string; nodeId: string }) {
  const tree = useTree();
  const invalidate = useInvalidateAll();
  const q = useQuery({ queryKey: keys.config(nodeId, "fields"), queryFn: () => get<{ local: FieldDef[]; resolved: ResolvedField[] }>(`${base}/fields`) });
  const [error, setError] = useState<ApiError | null>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err) => setError(err as ApiError),
  });
  if (!q.data) return <section className="panel"><h2>Custom fields</h2><p className="muted">Loading…</p></section>;
  const ownerName = (id: string) => findNode(tree.data, id)?.node.name ?? id;

  return (
    <section className="panel" aria-label="Custom fields">
      <h2>Custom fields</h2>
      <table className="config-table">
        <thead><tr><th>Field</th><th>Key</th><th>Type</th><th>Required</th><th>Options</th><th>Source</th><th /></tr></thead>
        <tbody>
          {q.data.resolved.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td><code>{f.key}</code></td>
              <td>{f.type}</td>
              <td>
                <Check label={`${f.name} required`} checked={f.required} disabled={f.inherited}
                  onChange={(on) => run.mutate(() => patch(`/v1/fields/${f.id}`, { required: on }))} />
              </td>
              <td className="small">{f.options.map((o) => o.label).join(", ")}</td>
              <td className="muted small">{f.inherited ? `inherited from ${ownerName(f.ownerId)}` : "defined here"}</td>
              <td className="actions">
                {!f.inherited && (
                  <Button variant="ghost" size="small" color="red" onClick={() => run.mutate(() => del(`/v1/fields/${f.id}`))}>Delete</Button>
                )}
              </td>
            </tr>
          ))}
          {q.data.resolved.length === 0 && <tr><td colSpan={7} className="muted">No fields yet.</td></tr>}
        </tbody>
      </table>
      <p className="muted small">Deleting a field removes its values from every task below this container. Field types can't change; create a new field instead.</p>
      <AddField onAdd={(body) => run.mutate(() => post(`${base}/fields`, body))} />
      {error && <ErrorBox error={error} />}
    </section>
  );
}

function AddField({ onAdd }: { onAdd: (body: { key: string; name: string; type: FieldType; required: boolean; options?: { label: string }[] }) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const isSelect = type === "single_select" || type === "multi_select";
  const key = slug(name);
  return (
    <form className="add-row" onSubmit={(e) => {
      e.preventDefault();
      if (!key) return;
      onAdd({ key, name, type, required, ...(isSelect ? { options: options.split(",").map((s) => s.trim()).filter(Boolean).map((label) => ({ label })) } : {}) });
      setName(""); setOptions("");
    }}>
      <TextField aria-label="New field name" placeholder="New field name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} />
      <Picker label="New field type" value={type} onChange={(v) => setType(v as FieldType)} options={FIELD_TYPES.map((t) => ({ value: t, label: t }))} />
      {isSelect && <TextField aria-label="Options" placeholder="Options, comma separated" value={options} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOptions(e.target.value)} />}
      <Check checked={required} onChange={setRequired}>required</Check>
      <Button type="submit" variant="soft" disabled={!key}>Add field</Button>
    </form>
  );
}

function ErrorBox({ error }: { error: ApiError }) {
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text><strong>{error.message}</strong></Callout.Text>
      {error.body.details && <ul className="error-list">{error.body.details.map((d, i) => <li key={i}>{d.path ? <code>{d.path}</code> : null} {d.message}</li>)}</ul>}
    </Callout.Root>
  );
}

function slug(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40);
}
