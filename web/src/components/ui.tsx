import Checkbox from "@radui/ui/Checkbox";
import Select from "@radui/ui/Select";
import type { ComponentProps, ComponentType, ReactNode } from "react";

// Small wrappers over Rad UI (https://rad-ui.com) so the components below stay terse.

// Select.Trigger shows the selected item's text unless given renderValue, which the published
// types omit (https://github.com/rad-ui/ui/issues/2248). Remove the cast once that's fixed.
const Trigger = Select.Trigger as ComponentType<
  ComponentProps<typeof Select.Trigger> & { renderValue?: (value: string, label: string) => ReactNode }
>;

export interface PickerOption {
  value: string;
  label: string;
  swatch?: string;
}

/** Rad UI Select with a label for screen readers, a placeholder and optional colour swatches. */
export function Picker({ label, value, options, onChange, placeholder = "Choose…", id, className }: {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className={`picker ${className ?? ""}`}>
      <Select.Root value={value} onValueChange={onChange}>
        <Trigger
          id={id}
          aria-label={label}
          renderValue={() => (
            <span className="picker-value">
              {current?.swatch && <span className="dot" style={{ background: current.swatch }} />}
              <span className={current ? "" : "muted"}>{current?.label ?? placeholder}</span>
            </span>
          )}
        >
          {placeholder}
        </Trigger>
        <Select.Portal>
          <Select.Content>
            <Select.Group>
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value}>
                  <Select.Indicator />
                  <span className="picker-value">
                    {o.swatch && <span className="dot" style={{ background: o.swatch }} />}
                    {o.label}
                  </span>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/** Rad UI Checkbox with an inline text label. */
export function Check({ checked, onChange, children, label, disabled, id }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  label?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className="check">
      <Checkbox.Root id={id} checked={checked} disabled={disabled} aria-label={label} onCheckedChange={(v) => onChange(v === true)}>
        <Checkbox.Indicator />
      </Checkbox.Root>
      {children}
    </label>
  );
}

/**
 * A link that looks like a Rad UI Button. `<Button asChild>` would hand the link the button role,
 * so it would be announced as a button (https://github.com/rad-ui/ui/issues/2256).
 */
export function ButtonLink({ variant, size, className = "", ...props }: ComponentProps<"a"> & { variant?: "solid" | "soft" | "outline" | "ghost"; size?: "small" }) {
  return <a {...props} data-variant={variant} data-size={size} className={`rad-ui-button-root ${className}`} />;
}
