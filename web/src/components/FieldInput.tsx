import TextField from "@radui/ui/TextField";
import type { ResolvedField } from "../types";
import { Check, Picker } from "./ui";

const NONE = "__none";

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
        <TextField id={id} type="number" value={value === undefined || value === null ? "" : String(value)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      );
      break;
    case "checkbox":
      input = <Check id={id} checked={value === true} onChange={onChange}>{value === true ? "Yes" : "No"}</Check>;
      break;
    case "date":
      input = <TextField id={id} type="date" value={typeof value === "string" ? value.slice(0, 10) : ""} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value || null)} />;
      break;
    case "single_select":
      input = (
        <Picker id={id} label={field.name} placeholder="—" value={typeof value === "string" ? value : NONE}
          onChange={(v) => onChange(v === NONE ? null : v)}
          options={[{ value: NONE, label: "—" }, ...field.options.map((o) => ({ value: o.id, label: o.label, swatch: o.color ?? undefined }))]} />
      );
      break;
    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      input = (
        <div id={id} className="multi" role="group" aria-label={field.name}>
          {field.options.map((o) => (
            <Check key={o.id} checked={selected.includes(o.id)}
              onChange={(on) => {
                const next = on ? [...selected, o.id] : selected.filter((x) => x !== o.id);
                onChange(next.length ? next : null);
              }}>
              {o.label}
            </Check>
          ))}
        </div>
      );
      break;
    }
    default:
      input = <TextField id={id} type="text" value={typeof value === "string" ? value : ""} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value === "" ? null : e.target.value)} />;
  }
  return (
    <div className={`form-row ${error ? "has-error" : ""}`}>
      {label}
      {input}
      {error && <span className="field-error" role="alert">{error}</span>}
    </div>
  );
}
