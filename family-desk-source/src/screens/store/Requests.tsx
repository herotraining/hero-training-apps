// Uniform requests from the Family Hub: what's waiting (counted by shirt, color and size so an order can be
// placed), each family's lines, and the fill step that bills the family the way they already pay.
import { useMemo, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { CartLine, Family, NewSale, StoreItem, UniformRequest } from "../../types";
import { money, siteName } from "../../lib/util";
import { Dialog, ErrorBox, Tag } from "../../ui";
import { href } from "../../router";
import { esaKid, lineWords, whenWords } from "./shared";

type Group = { key: string; family: Family | null; familyId: string; childId: string; childName: string; requests: UniformRequest[] };
type Route = { how: "esa" | "card" | "jackrabbit"; why: string };

export function Requests({ requests, families, items, siteId, onDone, onError, onAddToCart }: {
  requests: UniformRequest[]; families: Family[]; items: StoreItem[]; siteId: string;
  onDone: (msg: string) => void; onError: (msg: string) => void; onAddToCart: (lines: CartLine[], familyId: string) => void;
}) {
  const [filling, setFilling] = useState<Group | null>(null);
  const [canceling, setCanceling] = useState<Group | null>(null);
  const open = requests.filter((r) => r.status === "new");

  // What to order: every open line, counted by shirt, color and size.
  const tally = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of open) { const k = lineWords({ name: r.item_name, color: r.color, size: r.size, quantity: 1 }); m.set(k, (m.get(k) ?? 0) + r.quantity); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const m = new Map<string, Group>();
    for (const r of open) {
      const key = `${r.family_id}|${r.child_id}`;
      const g = m.get(key) ?? { key, family: families.find((f) => f.id === r.family_id) ?? null, familyId: r.family_id, childId: r.child_id, childName: r.child ? `${r.child.first_name} ${r.child.last_name}` : "a child", requests: [] };
      g.requests.push(r); m.set(key, g);
    }
    return [...m.values()].sort((a, b) => a.requests[0].created_at.localeCompare(b.requests[0].created_at));
  }, [open, families]);

  if (!open.length) return null;
  return (
    <div className="section">
      <h2>Uniform requests <span className="hint" style={{ fontFamily: "var(--sans)", fontWeight: 400, fontSize: ".95rem" }}>{open.reduce((n, r) => n + r.quantity, 0)} waiting</span></h2>
      <div className="pane" style={{ marginBottom: 12 }}>
        <p style={{ margin: 0 }}><b>To order or pull from stock:</b></p>
        <p className="hint" style={{ marginTop: 4 }}>{tally.map(([k, n]) => `${n} × ${k}`).join(" · ")}</p>
      </div>
      <ul className="list feed">
        {groups.map((g) => (
          <li key={g.key}><div className="item">
            <span className="n">{g.childName}{g.family ? <> · <a href={href.family(g.familyId)}>{g.family.name}</a></> : null}</span>
            <span className="k">
              {g.requests.map((r) => lineWords({ name: r.item_name, color: r.color, size: r.size, quantity: r.quantity })).join("; ")}
              <span style={{ display: "block" }}>asked {whenWords(g.requests[0].created_at)}{g.requests[0].requested_by_email ? ` by ${g.requests[0].requested_by_email}` : ""}{g.requests.some((r) => r.note) ? ` · "${g.requests.find((r) => r.note)!.note}"` : ""}</span>
            </span>
            <span className="p"><button className="btn small" onClick={() => setFilling(g)}>Fill it</button><button className="linkbtn" onClick={() => setCanceling(g)}>Can't fill</button></span>
          </div></li>
        ))}
      </ul>
      <p className="hint" style={{ marginTop: 10 }}>Filling a request bills the family the way they already pay: the next ESA invoice, the card on file, or their Jackrabbit account. The uniform then shows under To hand out.</p>
      {filling && <FillDialog group={filling} items={items} siteId={siteId} onClose={() => setFilling(null)}
        onDone={(msg) => { setFilling(null); onDone(msg); }} onError={onError}
        onAddToCart={(lines) => { setFilling(null); onAddToCart(lines, filling.familyId); }} />}
      {canceling && <CancelDialog group={canceling} onClose={() => setCanceling(null)} onDone={(msg) => { setCanceling(null); onDone(msg); }} />}
    </div>
  );
}

// How this child's family pays for a uniform, from what Family Desk knows about them.
function routeFor(g: Group, esaOk: boolean): Route {
  const fam = g.family;
  const child = fam?.children?.find((c) => c.id === g.childId);
  if (!fam) return { how: "jackrabbit", why: "The family isn't on file here; post it in Jackrabbit." };
  if (!fam.stripe_customer_id) return { how: "jackrabbit", why: `${fam.name} is billed in Jackrabbit.` };
  if (esaOk && esaKid(child)) return { how: "esa", why: `${child!.first_name} is in an ESA class, so it rides on the next ESA invoice.` };
  return { how: "card", why: `${fam.name} is billed in Family Desk, so the card on file is charged now.` };
}

function FillDialog({ group: g, items, siteId, onClose, onDone, onError, onAddToCart }: {
  group: Group; items: StoreItem[]; siteId: string; onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void; onAddToCart: (lines: CartLine[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = g.requests.map((r) => ({ r, item: items.find((i) => i.id === r.item_id && i.active) ?? null }));
  const missing = lines.filter((l) => !l.item);
  const total = lines.reduce((n, l) => n + (l.item?.price_cents ?? 0) * l.r.quantity, 0);
  const route = routeFor(g, lines.every((l) => l.item?.esa_ok));
  const child = g.family?.children?.find((c) => c.id === g.childId);
  const saleLines = () => lines.map((l) => ({ item_id: l.item!.id, size: l.r.size, color: l.r.color, quantity: l.r.quantity, child_id: g.childId, unit_cents: l.item!.price_cents }));
  const sale = (pay: NewSale["pay"]): NewSale => ({ site_id: g.family?.site_id ?? siteId, family_id: g.familyId, pay, note: "Uniform request from the Family Hub", lines: saleLines() });
  const ids = g.requests.map((r) => r.id);

  async function fill() {
    setBusy(true); setError(null);
    try {
      const a = await api();
      if (route.how === "card") {
        const r = await a.chargeCard(sale("card"));
        await a.closeRequests(ids, "fulfilled", r.sale_id, null);
        onDone(`Charged ${money(r.amount)} to ${g.family?.name ?? "the family"}'s card${r.last4 ? ` ending ${r.last4}` : ""}${r.live ? "" : " (practice)"}. ${child?.first_name ?? "The"} uniform is on the hand-out list.`);
      } else {
        const s = await a.sell(sale(route.how));
        await a.closeRequests(ids, "fulfilled", s.id, null);
        onDone(route.how === "esa" ? `${money(total)} goes on ${child?.first_name ?? "the child"}'s next ESA invoice. The uniform is on the hand-out list.` : `Recorded. Post ${money(total)} on the ${g.family?.name ?? "family"} Jackrabbit account. The uniform is on the hand-out list.`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      onError(msg);
    } finally { setBusy(false); }
  }
  function toCart() {
    onAddToCart(lines.map((l) => ({
      key: `${l.item!.id}|${l.r.color ?? ""}|${l.r.size ?? ""}|${g.childId}`, item_id: l.item!.id, name: l.item!.name, size: l.r.size, color: l.r.color, quantity: l.r.quantity,
      unit_cents: l.item!.price_cents, child_id: g.childId, child_name: child?.first_name ?? g.childName.split(" ")[0], esa_ok: l.item!.esa_ok, image_url: l.item!.image_url, request_id: l.r.id,
    })));
  }

  return (
    <Dialog open onClose={onClose}>
      <h2>Fill {g.childName.split(" ")[0]}'s request</h2>
      <div className="cartlines">
        {lines.map((l) => (
          <div key={l.r.id} className="line" style={{ alignItems: "center" }}>
            <span>{lineWords({ name: l.r.item_name, color: l.r.color, size: l.r.size, quantity: l.r.quantity })}{!l.item && <span className="hint"> · no longer on the price list</span>}</span>
            <span className="v">{l.item ? money(l.item.price_cents * l.r.quantity) : "—"}</span>
          </div>
        ))}
        <div className="line" style={{ fontWeight: 700 }}><span>Total</span><span className="v">{money(total)}</span></div>
      </div>
      {g.family && <p className="hint" style={{ margin: "8px 0 4px" }}>{g.family.name} · {siteName(g.family.site_id)}{g.requests.some((r) => r.note) ? ` · "${g.requests.find((r) => r.note)!.note}"` : ""}</p>}
      {missing.length > 0 ? (
        <p className="err">An item in this request isn't on the price list any more. Ring it up by hand from the shop, then mark the request as can't fill.</p>
      ) : (
        <div className="pane" style={{ marginTop: 10, padding: "12px 14px" }}>
          <b>{route.how === "esa" ? "ESA invoice" : route.how === "card" ? "Card on file" : "Jackrabbit account"}</b>
          <span className="hint" style={{ display: "block" }}>{route.why}</span>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="row end" style={{ marginTop: 14 }}>
        <button className="btn quiet" onClick={onClose}>Not now</button>
        {!missing.length && <button className="btn quiet" disabled={busy} onClick={toCart}>Add to cart instead</button>}
        {!missing.length && <button className="btn" disabled={busy} onClick={fill}>{busy ? (route.how === "card" ? "Charging…" : "Saving…") : route.how === "card" ? `Charge ${money(total)}` : "Fill and bill"}</button>}
      </div>
      {!missing.length && <p className="hint" style={{ marginTop: 8 }}>Add to cart instead takes it through the regular checkout (QR code, Tap to Pay, cash). The request is marked filled when that sale goes through.</p>}
    </Dialog>
  );
}

function CancelDialog({ group: g, onClose, onDone }: { group: Group; onClose: () => void; onDone: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const a = await api(); await a.closeRequests(g.requests.map((r) => r.id), "canceled", null, note.trim()); onDone("Request set aside. Let the family know."); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Can't fill this one?</h2>
        <p>{g.childName}: {g.requests.map((r) => lineWords({ name: r.item_name, color: r.color, size: r.size, quantity: r.quantity })).join("; ")}.</p>
        <p className="hint" style={{ marginTop: 6 }}>Family Desk doesn't email the family; tell them yourself. <Tag kind="warn">Nothing is billed</Tag></p>
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="rq-why">Why (goes in the log)</label><input id="rq-why" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Out of Youth M until November; told the parent" required minLength={3} /></div>
        <ErrorBox error={error} />
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Keep it</button><button className="btn danger quiet" disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : "Set it aside"}</button></div>
      </form>
    </Dialog>
  );
}
