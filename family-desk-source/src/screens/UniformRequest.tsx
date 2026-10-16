// The one page parents see: request a uniform for a child in a class. Linked from hero.training.
// No sign-in: the email on file and the child's first name unlock that child, and the request lands in Family Desk
// for staff to fill and bill the way the family already pays.
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { UniformLookup } from "../types";
import { money } from "../lib/util";
import { ErrorBox, Icon } from "../ui";
import { colorHex, sizeName } from "./store/shared";

type Kid = UniformLookup["children"][number];
type Item = UniformLookup["items"][number];
type Line = { key: string; item: Item; size: string | null; color: string | null; quantity: number };

const PAY_WORDS = {
  esa: "It goes on your child's next ESA invoice, which you pay through ClassWallet with tuition.",
  card: "We charge the card you have on file with HERO once it's ready, and let you know.",
  jackrabbit: "We add it to your account statement once it's ready.",
};

export function UniformRequest() {
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [found, setFound] = useState<UniformLookup | null>(null);
  const [kid, setKid] = useState<Kid | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState<Item | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ child: string; pay: "esa" | "card" | "jackrabbit"; lines: number } | null>(null);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const a = await api();
      const r = await a.uniformLookup(email.trim(), first.trim());
      setFound(r);
      setKid(r.children.length === 1 ? r.children[0] : null);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  function addLine(l: Line) {
    setLines((cur) => { const same = cur.find((x) => x.key === l.key); return same ? cur.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(10, x.quantity + l.quantity) } : x)) : [...cur, l]; });
    setPicking(null);
  }
  async function submit() {
    if (!kid || !lines.length) return;
    setBusy(true); setError(null);
    try {
      const a = await api();
      const r = await a.uniformSubmit({ email: email.trim(), child_first_name: first.trim(), child_id: kid.id, note: note.trim() || null, lines: lines.map((l) => ({ item_id: l.item.id, size: l.size, color: l.color, quantity: l.quantity })) });
      setDone(r);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const total = lines.reduce((n, l) => n + l.item.price_cents * l.quantity, 0);

  return (
    <div className="auth request">
      <div className="card">
        <div className="mark">{Icon.star}<div><b>HERO</b><span>Uniform request</span></div></div>

        {done ? (
          <>
            <h2>Got it. Thank you!</h2>
            <p style={{ marginTop: 8 }}>{done.lines === 1 ? "One uniform" : `${done.lines} uniform lines`} for <b>{done.child}</b> {done.lines === 1 ? "is" : "are"} on the front desk's list. We'll have it ready at class, usually within a week.</p>
            <p className="hint" style={{ marginTop: 8 }}>How it's paid: {PAY_WORDS[done.pay]}</p>
            <p className="hint" style={{ marginTop: 8 }}>Questions? Text or call (602) 622-7662.</p>
          </>
        ) : !found ? (
          <form onSubmit={lookup}>
            <h2>Request a uniform</h2>
            <p className="hint" style={{ marginTop: 6 }}>For families with a child in a HERO class. Enter the email you gave us and your child's first name.</p>
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="rq-email">Your email</label><input id="rq-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="field"><label htmlFor="rq-first">Your child's first name</label><input id="rq-first" autoComplete="off" required value={first} onChange={(e) => setFirst(e.target.value)} /></div>
            <ErrorBox error={error} />
            <button className="btn" style={{ width: "100%", marginTop: 6 }} disabled={busy}>{busy ? "Looking…" : "Continue"}</button>
          </form>
        ) : !kid ? (
          <>
            <h2>Which {first.trim()}?</h2>
            <p className="hint" style={{ marginTop: 6 }}>More than one child by that name is on file under this email.</p>
            <div className="chips">{found.children.map((c) => <button key={c.id} className="chipbtn" onClick={() => setKid(c)}>{c.first_name} {c.last_name} · {c.family_name}</button>)}</div>
          </>
        ) : (
          <>
            <h2>For {kid.first_name}</h2>
            <p className="hint" style={{ marginTop: 6 }}>{kid.family_name}{kid.uniform_size ? ` · size on file: ${sizeName(kid.uniform_size)}` : ""}. Tap a uniform to add it.</p>
            <div className="shop" style={{ marginTop: 12 }}>
              {found.items.map((i) => (
                <button key={i.id} className="tile" onClick={() => setPicking(i)}>
                  <span className="ph">{i.image_url ? <img src={i.image_url} alt="" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 4h8l3 3v2l-3 1v10H8V10L5 9V7Z" /></svg>}</span>
                  <span className="body"><span className="nm">{i.name}</span><span className="pr">{money(i.price_cents)}</span>{i.colors.length > 0 && <span className="swatches">{i.colors.map((c) => <span key={c} className="swatch" title={c} style={{ "--sw": colorHex(c) } as React.CSSProperties} />)}</span>}</span>
                </button>
              ))}
            </div>
            {picking && <PickDialog item={picking} sizeOnFile={sizeName(kid.uniform_size)} onClose={() => setPicking(null)} onAdd={addLine} />}
            {lines.length > 0 && (
              <div className="cart" style={{ marginTop: 14, padding: "12px 14px" }}>
                {lines.map((l) => (
                  <div key={l.key} className="cartline" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
                    <div><div className="nm">{l.quantity > 1 ? `${l.quantity} × ` : ""}{l.item.name}</div><div className="k">{[l.color, l.size].filter(Boolean).join(" · ")}</div></div>
                    <div className="v">{money(l.item.price_cents * l.quantity)} <button className="linkbtn" onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}>remove</button></div>
                  </div>
                ))}
                <div className="total"><span>Total</span><b>{money(total)}</b></div>
              </div>
            )}
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="rq-note">Anything we should know? (optional)</label><input id="rq-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Needs it before the Oct 25 meet" /></div>
            <p className="hint">How it's paid: {PAY_WORDS[kid.pay]}</p>
            <ErrorBox error={error} />
            <button className="btn" style={{ width: "100%", marginTop: 10 }} disabled={busy || !lines.length} onClick={submit}>{busy ? "Sending…" : lines.length ? `Send the request · ${money(total)}` : "Add a uniform first"}</button>
            <div className="row" style={{ justifyContent: "center", marginTop: 8 }}><button className="linkbtn" onClick={() => { setFound(null); setKid(null); setLines([]); }}>Start over</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function PickDialog({ item, sizeOnFile, onClose, onAdd }: { item: Item; sizeOnFile: string | null; onClose: () => void; onAdd: (l: Line) => void }) {
  const [size, setSize] = useState<string | null>(sizeOnFile && item.sizes.includes(sizeOnFile) ? sizeOnFile : null);
  const [color, setColor] = useState<string | null>(item.colors.length === 1 ? item.colors[0] : null);
  const [qty, setQty] = useState(1);
  const needSize = item.sizes.length > 0 && !size, needColor = item.colors.length > 0 && !color;
  return (
    <div className="pane" style={{ marginTop: 12, border: "1.5px solid var(--primary)" }}>
      <h3>{item.name} · {money(item.price_cents)}</h3>
      {item.description && <p className="hint">{item.description}</p>}
      {item.colors.length > 0 && <div className="field" style={{ marginTop: 10 }}><span className="label">Color</span><div className="chips" style={{ marginTop: 0 }}>{item.colors.map((c) => <button key={c} type="button" className="chipbtn" aria-pressed={color === c} onClick={() => setColor(c)}><span className="swatch" style={{ "--sw": colorHex(c), marginRight: 6, verticalAlign: "-2px" } as React.CSSProperties} />{c}</button>)}</div></div>}
      {item.sizes.length > 0 && <div className="field" style={{ marginTop: 10 }}><span className="label">Size</span><div className="chips" style={{ marginTop: 0 }}>{item.sizes.map((s) => <button key={s} type="button" className="chipbtn" aria-pressed={size === s} onClick={() => setSize(s)}>{s}</button>)}</div></div>}
      <div className="field" style={{ marginTop: 10 }}><span className="label">How many</span><div className="stepper"><button type="button" className="btn quiet small" disabled={qty <= 1} onClick={() => setQty((n) => n - 1)}>−</button><b>{qty}</b><button type="button" className="btn quiet small" disabled={qty >= 10} onClick={() => setQty((n) => n + 1)}>+</button></div></div>
      <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={needSize || needColor} onClick={() => onAdd({ key: `${item.id}|${color ?? ""}|${size ?? ""}`, item, size, color, quantity: qty })}>{needColor ? "Pick a color" : needSize ? "Pick a size" : "Add it"}</button></div>
    </div>
  );
}
