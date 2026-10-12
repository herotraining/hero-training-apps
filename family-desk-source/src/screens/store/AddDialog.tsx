// One item into the cart: who it's for, which color, which size, how many.
import { useState, type FormEvent } from "react";
import type { CartLine, Child, Family, StoreItem } from "../../types";
import { money } from "../../lib/util";
import { Dialog } from "../../ui";
import { KIND_WORDS, Photo, colorHex, sizeName } from "./shared";

export function AddDialog({ item, family, onClose, onAdd }: { item: StoreItem; family: Family | null; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const kids = (family?.children ?? []).filter((c) => c.active).sort((a, b) => (a.birth_date ?? "9999").localeCompare(b.birth_date ?? "9999"));
  const sizeFor = (c: Child | undefined) => { const s = sizeName(c?.uniform_size); return s && item.sizes.includes(s) ? s : null; };
  const [childId, setChildId] = useState<string | null>(kids.length === 1 ? kids[0].id : null);
  const [size, setSize] = useState<string | null>(item.sizes.length ? sizeFor(kids.length === 1 ? kids[0] : undefined) : null);
  const [color, setColor] = useState<string | null>(item.colors.length === 1 ? item.colors[0] : null);
  const [qty, setQty] = useState(1);
  const child = kids.find((c) => c.id === childId);
  const needSize = item.sizes.length > 0 && !size;
  const needColor = item.colors.length > 0 && !color;

  function pickChild(id: string | null) {
    setChildId(id);
    const s = sizeFor(kids.find((c) => c.id === id));
    if (s) setSize(s);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (needSize || needColor) return;
    onAdd({
      key: `${item.id}|${color ?? ""}|${size ?? ""}|${childId ?? ""}`, item_id: item.id, name: item.name, size, color, quantity: qty, unit_cents: item.price_cents,
      child_id: childId, child_name: child ? child.first_name : null, esa_ok: item.esa_ok, image_url: item.image_url,
    });
  }

  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <div className="hero">
          <Photo url={item.image_url} alt="" className="ph" />
          <div>
            <h2>{item.name}</h2>
            <p className="hint">{money(item.price_cents)} each · {KIND_WORDS[item.kind]}{item.esa_ok ? ", ESA can pay" : ""}</p>
            {item.description && <p className="hint" style={{ marginTop: 4 }}>{item.description}</p>}
          </div>
        </div>
        {kids.length > 0 && (
          <div className="field" style={{ marginTop: 14 }}>
            <span className="label">For</span>
            <div className="chips" style={{ marginTop: 0 }} role="group" aria-label="For">
              {kids.map((c) => <button type="button" key={c.id} className="chipbtn" aria-pressed={childId === c.id} onClick={() => pickChild(c.id)}>{c.first_name}</button>)}
              <button type="button" className="chipbtn" aria-pressed={childId === null} onClick={() => pickChild(null)}>Someone else</button>
            </div>
          </div>
        )}
        {item.colors.length > 0 && (
          <div className="field" style={{ marginTop: 12 }}>
            <span className="label">Color</span>
            <div className="chips" style={{ marginTop: 0 }} role="group" aria-label="Color">
              {item.colors.map((c) => (
                <button type="button" key={c} className="chipbtn" aria-pressed={color === c} onClick={() => setColor(c)}>
                  <span className="swatch" style={{ "--sw": colorHex(c), marginRight: 6, verticalAlign: "-2px" } as React.CSSProperties} />{c}
                </button>
              ))}
            </div>
          </div>
        )}
        {item.sizes.length > 0 && (
          <div className="field" style={{ marginTop: 12 }}>
            <span className="label">Size{child?.uniform_size && !sizeFor(child) ? <span className="hint"> (on file for {child.first_name}: {child.uniform_size})</span> : null}</span>
            <div className="chips" style={{ marginTop: 0 }} role="group" aria-label="Size">
              {item.sizes.map((s) => <button type="button" key={s} className="chipbtn" aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}
            </div>
          </div>
        )}
        <div className="field" style={{ marginTop: 12 }}>
          <span className="label">How many</span>
          <div className="stepper">
            <button type="button" className="btn quiet small" aria-label="One fewer" disabled={qty <= 1} onClick={() => setQty((n) => Math.max(1, n - 1))}>−</button>
            <b aria-live="polite">{qty}</b>
            <button type="button" className="btn quiet small" aria-label="One more" disabled={qty >= 50} onClick={() => setQty((n) => Math.min(50, n + 1))}>+</button>
          </div>
        </div>
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button className="btn" disabled={needSize || needColor}>{needColor ? "Pick a color" : needSize ? "Pick a size" : `Add ${money(item.price_cents * qty)}`}</button></div>
      </form>
    </Dialog>
  );
}
