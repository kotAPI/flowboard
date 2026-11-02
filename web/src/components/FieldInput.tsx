import type { ResolvedField } from "../types";

/** Editable input for one custom field, chosen by type. `null` means "no value". */
export function FieldInput({ field, value, onChange, error }: { field: ResolvedField; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const id = `cf-${field.key}`;
  const label = (
    <label htmlFor={id}>
      {field.name}
      {field.required && <span className="req" title="Required"> *</span>}
      <span className="muted small"> · {field.ownerType}</span>
    </label>
  );
  let input: React.ReactNode;
  switch (field.type) {
    case "number":
      input = (
        <input id={id} type="number" value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      );
      break;
    case "checkbox":
      input = <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "date":
      input = <input id={id} type="date" value={typeof value === "string" ? value.slice(0, 10) : ""} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "single_select":
      input = (
        <select id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      );
      break;
    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      input = (
        <div id={id} className="multi" role="group" aria-label={field.name}>
          {field.options.map((o) => (
            <label key={o.id} className="multi-opt">
              <input type="checkbox" checked={selected.includes(o.id)}
                onChange={(e) => {
                  const next = e.target.checked ? [...selected, o.id] : selected.filter((x) => x !== o.id);
                  onChange(next.length ? next : null);
                }} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    default:
      input = <input id={id} type="text" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />;
  }
  return (
    <div className={`form-row ${error ? "has-error" : ""}`}>
      {label}
      {input}
      {error && <span className="field-error" role="alert">{error}</span>}
    </div>
  );
}
