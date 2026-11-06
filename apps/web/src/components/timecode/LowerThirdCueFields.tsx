import { useEffect, useId, useMemo, useState } from "react";
import type { CueDetails } from "@/lib/automation-catalog";

const types = ["freetext", "person", "scripture", "style"] as const;
type Kind = typeof types[number];
const isKind = (value: string): value is Kind => types.some(kind => kind === value);
const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text";
export function LowerThirdCueFields({ initial, onChange }: { initial: Record<string, unknown>; onChange: (details: CueDetails) => void }) {
  const initialType = typeof initial.type === "string" && isKind(initial.type) ? initial.type : "freetext";
  const [kind, setKind] = useState<Kind>(initialType);
  const text = (key: string, fallback = "") => typeof initial[key] === "string" ? initial[key] : fallback;
  const [style, setStyle] = useState(text("style", "default"));
  const [values, setValues] = useState<Record<string, string>>({ line1: text("line1"), line2: text("line2"), name: text("name"), title: text("title"), scripture: text("scripture"), translation: text("translation") });
  const id = useId();
  const details = useMemo<CueDetails>(() => {
    if (kind === "person") return values.name.trim() ? { status: "ready", payload: { type: kind, style, name: values.name, title: values.title } } : { status: "invalid", message: "Enter the person's name." };
    if (kind === "scripture") return values.scripture.trim() ? { status: "ready", payload: { type: kind, style, scripture: values.scripture, translation: values.translation } } : { status: "invalid", message: "Enter the scripture text." };
    if (kind === "style") return { status: "ready", payload: { type: kind, style } };
    return values.line1.trim() ? { status: "ready", payload: { type: kind, style, line1: values.line1, line2: values.line2 } } : { status: "invalid", message: "Enter the first line." };
  }, [kind, style, values]);
  useEffect(() => onChange(details), [details, onChange]);
  const fields = kind === "person" ? [{ key: "name", label: "Person name" }, { key: "title", label: "Person title (optional)" }]
    : kind === "scripture" ? [{ key: "scripture", label: "Scripture text" }, { key: "translation", label: "Translation (optional)" }]
    : kind === "freetext" ? [{ key: "line1", label: "First line" }, { key: "line2", label: "Second line (optional)" }] : [];
  return <div className="space-y-3">
    <div><label htmlFor={`${id}-type`} className="mb-1 block text-xs text-board-muted">Lower third type</label>
      <select id={`${id}-type`} className={inputClass} value={kind} onChange={event => { if (isKind(event.target.value)) setKind(event.target.value); }}>
        <option value="freetext">Free text</option><option value="person">Person</option><option value="scripture">Scripture</option><option value="style">Style only</option>
      </select></div>
    {fields.map(field => <div key={field.key}><label htmlFor={`${id}-${field.key}`} className="mb-1 block text-xs text-board-muted">{field.label}</label>
      {field.key === "scripture" ? <textarea id={`${id}-${field.key}`} className={inputClass} rows={3} maxLength={10000} value={values[field.key]} onChange={event => setValues(previous => ({ ...previous, [field.key]: event.target.value }))} />
        : <input id={`${id}-${field.key}`} className={inputClass} maxLength={2000} value={values[field.key]} onChange={event => setValues(previous => ({ ...previous, [field.key]: event.target.value }))} />}
    </div>)}
    <div><label htmlFor={`${id}-style`} className="mb-1 block text-xs text-board-muted">Lower third style</label>
      <select id={`${id}-style`} className={inputClass} value={style} onChange={event => setStyle(event.target.value)}>
        <option value="default">Default</option><option value="minimal">Minimal</option><option value="scripture">Scripture</option>
        {!["default", "minimal", "scripture"].includes(style) && <option value={style}>{style}</option>}
      </select></div>
    {details.status === "invalid" && <p role="status" className="text-xs text-board-muted">{details.message}</p>}
  </div>;
}
