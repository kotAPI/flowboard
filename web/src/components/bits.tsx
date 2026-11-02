import Avatar from "@radui/ui/Avatar";
import Badge from "@radui/ui/Badge";
import { initials, useUsers } from "../hooks";
import type { Priority, ResolvedField, ResolvedStatus } from "../types";

const PRIORITY_COLOR: Record<Exclude<Priority, "none">, string> = { urgent: "red", high: "orange", normal: "blue", low: "gray" };

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  return <Badge variant="soft" size="small" color={PRIORITY_COLOR[priority]} className="prio">{priority}</Badge>;
}

export function Avatars({ ids }: { ids: string[] }) {
  const users = useUsers();
  return (
    <span className="avatars">
      {ids.map((id) => {
        const name = users.data?.find((u) => u.id === id)?.name ?? id.replace("usr_", "");
        return (
          <Avatar.Root key={id} size="small" className="avatar-sm" title={name}>
            <Avatar.Fallback>{initials(name)}</Avatar.Fallback>
          </Avatar.Root>
        );
      })}
    </span>
  );
}

export function StatusPill({ status }: { status?: ResolvedStatus }) {
  if (!status) return <span className="muted">—</span>;
  return (
    <span className="pill" style={{ "--c": status.color } as React.CSSProperties}>
      <span className="dot" />
      {status.name}
    </span>
  );
}

export function formatDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

export function isOverdue(iso: string | null) {
  return !!iso && new Date(iso).getTime() < Date.now();
}

/** Read-only rendering of a custom field value. */
export function FieldValue({ field, value }: { field: ResolvedField; value: unknown }) {
  if (value === undefined || value === null || value === "") return <span className="muted">—</span>;
  switch (field.type) {
    case "single_select": {
      const o = field.options.find((x) => x.id === value);
      return o ? <span className="chip" style={{ "--c": o.color ?? "#94a3b8" } as React.CSSProperties}>{o.label}</span> : <span className="muted">?</span>;
    }
    case "multi_select":
      return (
        <span className="chips">
          {(value as string[]).map((id) => {
            const o = field.options.find((x) => x.id === id);
            return <span key={id} className="chip" style={{ "--c": o?.color ?? "#94a3b8" } as React.CSSProperties}>{o?.label ?? "?"}</span>;
          })}
        </span>
      );
    case "checkbox":
      return <span>{value ? "✓" : "—"}</span>;
    case "date":
      return <span>{formatDate(String(value))}</span>;
    case "number":
      return <span className="num">{String(value)}</span>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}
