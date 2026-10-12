import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { CartLine, CheckoutState, Child, Family, NewSale, Site, Staff, StoreConfig, StoreItem, StoreKind, StorePay, StoreSale } from "../types";
import { arizonaToday, dateWords, money, siteName, stripeDashboard } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";

const KIND_WORDS: Record<StoreKind, string> = { uniform: "Required uniform", gear: "Gear", other: "Other" };
const SITE_KEY = "hero.store.site";

const readSite = () => { try { return localStorage.getItem(SITE_KEY); } catch { return null; } };
const saveSite = (id: string) => { try { localStorage.setItem(SITE_KEY, id); } catch { /* per-device convenience only */ } };

// Sizes typed the short way on a child's record (YM, AL) read as the Store's size names.
const SHORT_SIZES: Record<string, string> = { YXS: "Youth XS", YS: "Youth S", YM: "Youth M", YL: "Youth L", YXL: "Youth XL", AS: "Adult S", AM: "Adult M", AL: "Adult L", AXL: "Adult XL", A2XL: "Adult 2XL", AXXL: "Adult 2XL" };
const sizeName = (s: string | null | undefined) => (s ? SHORT_SIZES[s.replace(/\s+/g, "").toUpperCase()] ?? s.trim() : null);

// A child an ESA invoice can carry a uniform for: on ESA, with an active ESA class.
const esaKid = (c: Child | undefined) => !!c && c.esa && (c.enrollments ?? []).some((e) => e.pay === "esa" && e.status === "active");

function arizonaDay(iso: string): string { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Phoenix" }); }
function whenWords(iso: string): string {
  const time = new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Phoenix" }).toLowerCase();
  const day = arizonaDay(iso);
  return `${day === arizonaToday() ? "Today" : dateWords(day)}, ${time}`;
}
function sinceDays(n: number): string { return new Date(Date.now() - n * 86400000).toISOString(); }

function lineWords(l: { name: string; size: string | null; quantity: number }): string {
  return `${l.quantity > 1 ? `${l.quantity} × ` : ""}${l.name}${l.size ? ` (${l.size})` : ""}`;
}

function saleTag(s: StoreSale): { label: string; kind?: "esa" | "warn" | "gold" | "good" } {
  if (s.status === "void") return { label: "Voided", kind: "warn" };
  if (s.status === "waiting") return { label: "Waiting for payment", kind: "gold" };
  if (s.status === "on_esa") return Date.now() - new Date(s.created_at).getTime() > 40 * 86400000
    ? { label: "Still waiting for an ESA invoice", kind: "warn" }
    : { label: "On the next ESA invoice", kind: "esa" };
  if (s.status === "invoiced") return { label: "On an ESA invoice", kind: "esa" };
  if (s.pay === "jackrabbit") return { label: "On their Jackrabbit account" };
  if (s.pay === "free") return { label: "No charge" };
  if (s.pay === "cash") return { label: "Paid in cash", kind: "good" };
  return { label: s.stripe_live === false ? "Paid by card (practice)" : "Paid by card", kind: "good" };
}

// Which sales can be voided here. A paid card sale is refunded in Stripe; a uniform on an ESA invoice stays there.
function canVoid(s: StoreSale): boolean {
  if (s.status === "void" || s.status === "invoiced") return false;
  if (s.pay === "card" && s.status === "done") return false;
  if (s.lines.some((l) => l.esa_invoice_id)) return false;
  return true;
}

export function Store({ staff, familyId }: { staff: Staff; familyId?: string }) {
  const isOwner = staff.role === "owner";
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [fams, setFams] = useState<Family[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [sales, setSales] = useState<StoreSale[] | null>(null);
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [famId, setFamId] = useState<string | null>(familyId ?? null);
  const [q, setQ] = useState("");
  const [siteId, setSiteId] = useState<string>(staff.site_id ?? "");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [adding, setAdding] = useState<StoreItem | null>(null);
  const [paying, setPaying] = useState(false);
  const [qr, setQr] = useState<{ state: CheckoutState; total: number; cart: CartLine[] } | null>(null);
  const [voiding, setVoiding] = useState<StoreSale | null>(null);
  const [editing, setEditing] = useState<StoreItem | "new" | null>(null);
  const [showAllSales, setShowAllSales] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, show] = useToast();

  const loadSales = async () => { const a = await api(); setSales(await a.storeSales(sinceDays(45))); };
  const loadItems = async () => { const a = await api(); setItems(await a.storeItems()); };

  useEffect(() => {
    api().then(async (a) => {
      const [it, f, s, sl] = await Promise.all([a.storeItems(), a.families(), a.sites(), a.storeSales(sinceDays(45))]);
      setItems(it); setFams(f); setSites(s); setSales(sl);
      // Card sales left waiting (a QR code closed before the parent paid): ask Stripe once whether they went through.
      if (sl.some((x) => x.pay === "card" && x.status === "waiting" && x.stripe_checkout_id)) {
        a.storeStatus().then((r) => { if (r.sales.some((x) => x.status === "paid")) loadSales().catch(() => {}); }).catch(() => {});
      }
    }).catch((e) => setError(e.message));
    api().then((a) => a.storeConfig()).then(setConfig).catch((e) => setConfig({ card: "off", why: `The store can't reach Stripe right now: ${e.message}` }));
  }, []);

  const family = useMemo(() => fams.find((f) => f.id === famId) ?? null, [fams, famId]);
  // Where the sale happens: the staff member's own site, else the family's, else the last one used on this device,
  // else the site with the most families.
  useEffect(() => {
    if (staff.site_id || !sites.length) return;
    if (family) { setSiteId(family.site_id); return; }
    if (siteId) return;
    const remembered = readSite();
    if (remembered && sites.some((s) => s.id === remembered)) { setSiteId(remembered); return; }
    const counts = new Map<string, number>();
    for (const f of fams) if (f.status === "active") counts.set(f.site_id, (counts.get(f.site_id) ?? 0) + 1);
    setSiteId([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sites[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, family, fams]);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, "");
    return fams.filter((f) => {
      const hay = [f.name, ...(f.guardians ?? []).flatMap((g) => [g.name, g.email ?? ""]), ...(f.children ?? []).map((c) => `${c.first_name} ${c.last_name}`)].join(" ").toLowerCase();
      return hay.includes(s) || (digits.length >= 4 && (f.guardians ?? []).some((g) => (g.mobile ?? "").replace(/\D/g, "").includes(digits)));
    }).sort((a, b) => Number(b.status === "active") - Number(a.status === "active")).slice(0, 6);
  }, [fams, q]);

  function pickFamily(f: Family | null) {
    setFamId(f?.id ?? null); setQ("");
    // Lines named for a child of another family no longer fit: keep the items, drop the names.
    if (cart.some((l) => l.child_id)) {
      setCart((c) => {
        const merged = new Map<string, CartLine>();
        for (const l of c) {
          const key = `${l.item_id}|${l.size ?? ""}|`;
          const had = merged.get(key);
          merged.set(key, had ? { ...had, quantity: Math.min(50, had.quantity + l.quantity) } : { ...l, key, child_id: null, child_name: null });
        }
        return [...merged.values()];
      });
    }
  }

  function addToCart(l: CartLine) {
    setCart((c) => {
      const same = c.find((x) => x.key === l.key);
      return same ? c.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(50, x.quantity + l.quantity) } : x)) : [...c, l];
    });
    setAdding(null);
    show(`Added ${lineWords(l)}${l.child_name ? ` for ${l.child_name}` : ""}.`);
  }

  async function finished(msg: string) {
    show(msg);
    await loadSales().catch((e) => setError(e.message));
    if (family) api().then((a) => a.families()).then(setFams).catch(() => {}); // a first uniform records the child's size
  }

  async function handedOut(lineId: string, handed: boolean) {
    try { const a = await api(); await a.setHandedOut(lineId, handed); await loadSales(); }
    catch (e) { setError((e as Error).message); }
  }

  async function reopenQr(s: StoreSale) {
    setError(null);
    try { const a = await api(); const r = await a.storeCheckout({ sale_id: s.id }); setQr({ state: r, total: s.total_cents, cart: [] }); }
    catch (e) { setError((e as Error).message); }
  }

  const cartTotal = cart.reduce((n, l) => n + l.unit_cents * l.quantity, 0);
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const forSale = (items ?? []).filter((i) => i.active);
  const live = (sales ?? []).filter((s) => s.status !== "void");
  const toHandOut = live.flatMap((s) => s.lines.filter((l) => !l.handed_out_at).map((l) => ({ sale: s, line: l }))).reverse();
  // Today's takings leave out card sales still waiting on the parent; those are counted on their own.
  const todayAll = live.filter((s) => arizonaDay(s.created_at) === arizonaToday());
  const today = todayAll.filter((s) => s.status !== "waiting");
  const waitingToday = todayAll.length - today.length;
  const sum = (list: StoreSale[]) => list.reduce((n, s) => n + s.total_cents, 0);
  const shownSales = showAllSales ? sales ?? [] : (sales ?? []).slice(0, 12);

  return (
    <>
      <Band>
        <h1>Store</h1>
        <p className="lede">Uniforms and gear. Cards are paid on Stripe's own page or with Tap to Pay in the Stripe app, so no card details touch Family Desk.</p>
        <div className="row"><a className="btn quiet" href={stripeDashboard("payments")} target="_blank" rel="noreferrer">Open Stripe payments</a></div>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {config?.card === "practice" && <div className="section"><div className="pane notice">Card by QR code is in <b>practice mode</b>: no real money moves, and Stripe's test card 4242 4242 4242 4242 works. It switches to real payments once the store's own Stripe key is added.</div></div>}
        {config?.card === "off" && <div className="section"><div className="pane notice">{config.why ?? "Card by QR code isn't set up yet."} Tap to Pay in the Stripe app, cash and account sales still work.</div></div>}

        <div className="section">
          <h2>Who's it for?</h2>
          {family ? (
            <div className="pane">
              <div className="line" style={{ alignItems: "center", borderTop: 0 }}>
                <span><a href={href.family(family.id)}><b>{family.name}</b></a>{family.status !== "active" ? <> <Tag kind="warn">Inactive</Tag></> : null}
                  <span className="hint" style={{ display: "block" }}>{siteName(family.site_id)} · {family.stripe_customer_id ? "billed in Family Desk" : "billed in Jackrabbit"} · {(family.children ?? []).filter((c) => c.active).map((c) => c.first_name).join(", ") || "no children yet"}</span>
                </span>
                <button className="btn quiet small" onClick={() => pickFamily(null)}>Change</button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="who" className="hint">Search a parent or child, or skip this for a walk-up sale</label>
              <input id="who" className="search" type="search" placeholder="A parent, a child, an email, or a phone number" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
              {matches.length > 0 && (
                <ul className="list" style={{ marginTop: 10 }}>
                  {matches.map((f) => (
                    <li key={f.id}><button className="item pick" onClick={() => pickFamily(f)}>
                      <span className="n">{f.name}</span>
                      <span className="k">{(f.children ?? []).filter((c) => c.active || f.status !== "active").map((c) => c.first_name).join(" and ") || "No children yet"} · {siteName(f.site_id)}</span>
                      <span className="p">{f.status !== "active" ? <Tag kind="warn">Inactive</Tag> : f.stripe_customer_id ? <Tag kind="esa">Family Desk billing</Tag> : <Tag>Jackrabbit billing</Tag>}</span>
                    </button></li>
                  ))}
                </ul>
              )}
              {q.trim().length >= 2 && matches.length === 0 && <p className="hint" style={{ marginTop: 8 }}>No family or child matches "{q}".</p>}
            </>
          )}
        </div>

        <div className="section">
          <h2>Items</h2>
          {items === null && !error && <Loading what="the price list" />}
          {items && forSale.length === 0 && <div className="pane"><p className="hint">Nothing is for sale yet.{isOwner ? " Add an item under Price list below." : " An owner adds items to the price list."}</p></div>}
          <div className="shop">
            {forSale.map((i) => (
              <button key={i.id} className="tile" onClick={() => setAdding(i)}>
                <span className="nm">{i.name}</span>
                <span className="pr">{money(i.price_cents)}</span>
                <span className="hint">{KIND_WORDS[i.kind]}{i.esa_ok ? " · ESA can pay" : ""}</span>
              </button>
            ))}
          </div>
          {cart.length > 0 && (
            <div className="cartbar" role="region" aria-label="Cart">
              <span><b>{cartCount} {cartCount === 1 ? "item" : "items"} · {money(cartTotal)}</b><span className="sub">{cart.map((l) => lineWords(l)).join(", ")}</span></span>
              <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                <button className="linkbtn light" onClick={() => setCart([])}>Clear</button>
                <button className="btn" onClick={() => setPaying(true)}>Take payment</button>
              </span>
            </div>
          )}
        </div>

        {toHandOut.length > 0 && (
          <div className="section">
            <h2>To hand out</h2>
            <ul className="list feed">
              {toHandOut.map(({ sale, line }) => (
                <li key={line.id}><div className="item">
                  <span className="n">{lineWords(line)}</span>
                  <span className="k">{line.child ? `For ${line.child.first_name} ${line.child.last_name}` : sale.family?.name ?? "Walk-up sale"}{line.child && sale.family ? ` · ${sale.family.name}` : ""} · sold {whenWords(sale.created_at)}{sale.status === "waiting" ? " · not paid yet" : ""}</span>
                  <span className="p"><button className="btn quiet small" onClick={() => handedOut(line.id, true)}>Handed out</button></span>
                </div></li>
              ))}
            </ul>
          </div>
        )}

        <div className="section">
          <h2>Recent sales</h2>
          {sales === null && !error && <Loading what="sales" />}
          {sales && (
            <div className="pane" style={{ marginBottom: 12 }}>
              <p style={{ margin: 0 }}><b>Today:</b> {today.length === 0 ? "no sales yet." : `${today.length} ${today.length === 1 ? "sale" : "sales"}, ${money(sum(today))}.`}</p>
              {(today.length > 0 || waitingToday > 0) && (
                <p className="hint" style={{ marginTop: 4 }}>
                  {[
                    ...[
                      ["card", sum(today.filter((s) => s.pay === "card"))],
                      ["cash", sum(today.filter((s) => s.pay === "cash"))],
                      ["on accounts or ESA", sum(today.filter((s) => s.pay === "jackrabbit" || s.pay === "esa"))],
                    ].filter(([, v]) => (v as number) > 0).map(([k, v]) => `${money(v as number)} ${k}`),
                    waitingToday ? `${waitingToday} waiting for a card payment` : "",
                  ].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          )}
          {sales && sales.length === 0 && <div className="pane"><p className="hint">No sales in the last 45 days.</p></div>}
          {sales && sales.length > 0 && (
            <ul className="list feed">
              {shownSales.map((s) => {
                const tag = saleTag(s);
                return (
                  <li key={s.id}><div className={"item" + (s.status === "void" ? " off" : "")}>
                    <span className="n">{s.family ? <a href={href.family(s.family_id ?? "")}>{s.family.name}</a> : "Walk-up sale"} · {money(s.total_cents)}</span>
                    <span className="k">
                      {s.lines.map((l) => `${lineWords(l)}${l.child ? `, ${l.child.first_name}` : ""}${l.handed_out_at ? " ✓" : ""}`).join("; ")}
                      <span style={{ display: "block" }}>{whenWords(s.created_at)} · {siteName(s.site_id)}{s.seller ? ` · ${s.seller.name}` : ""}{s.pay === "card" && s.status === "done" && !s.stripe_checkout_id ? " · Tap to Pay" : ""}{s.note ? ` · ${s.note}` : ""}</span>
                      {s.lines.some((l) => l.handed_out_at) && s.status !== "void" && <span style={{ display: "block" }}>✓ handed out{s.lines.filter((l) => l.handed_out_at).map((l) => <button key={l.id} className="linkbtn" onClick={() => handedOut(l.id, false)}>undo{s.lines.length > 1 ? ` (${l.name})` : ""}</button>)}</span>}
                    </span>
                    <span className="p" style={{ flexDirection: "column", alignItems: "flex-end" }}>
                      <Tag kind={tag.kind}>{tag.label}</Tag>
                      {s.status === "waiting" && s.stripe_checkout_id && <button className="btn quiet small" onClick={() => reopenQr(s)}>Show the QR code</button>}
                      {canVoid(s) && <button className="linkbtn" onClick={() => setVoiding(s)}>{s.status === "waiting" ? "Cancel" : "Void"}</button>}
                    </span>
                  </div></li>
                );
              })}
            </ul>
          )}
          {sales && sales.length > 12 && <div className="row" style={{ marginTop: 8 }}><button className="linkbtn" onClick={() => setShowAllSales((v) => !v)}>{showAllSales ? "Show fewer" : `Show all ${sales.length} sales`}</button></div>}
          <p className="hint" style={{ marginTop: 10 }}>Card refunds happen in Stripe. A Jackrabbit sale is only a reminder here: post it on the family's Jackrabbit account too.</p>
        </div>

        {isOwner && items && (
          <div className="section">
            <h2>Price list</h2>
            <ul className="list">
              {items.map((i) => (
                <li key={i.id}><div className={"item" + (i.active ? "" : " off")}>
                  <span className="n">{i.name} · {money(i.price_cents)}</span>
                  <span className="k">{KIND_WORDS[i.kind]}{i.esa_ok ? ", ESA can pay" : ""} · {i.sizes.length ? `${i.sizes.length} sizes, ${i.sizes[0]} to ${i.sizes[i.sizes.length - 1]}` : "one size"}</span>
                  <span className="p">{!i.active && <Tag kind="warn">Not for sale</Tag>}<button className="btn quiet small" onClick={() => setEditing(i)}>Edit</button></span>
                </div></li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 10 }}><button className="btn quiet" onClick={() => setEditing("new")}>Add an item</button></div>
            <p className="hint" style={{ marginTop: 8 }}>The starting prices are what Jackrabbit charged in 2025-26. A price change applies to new sales only.</p>
          </div>
        )}
      </div>

      {adding && <AddDialog item={adding} family={family} onClose={() => setAdding(null)} onAdd={addToCart} />}
      {paying && (
        <PayDialog
          cart={cart} family={family} sites={sites} siteId={siteId} lockSite={!!staff.site_id} config={config}
          onSite={(id) => { setSiteId(id); saveSite(id); }}
          onRemove={(key) => { const next = cart.filter((l) => l.key !== key); setCart(next); if (!next.length) setPaying(false); }}
          onClose={() => setPaying(false)}
          onSold={(msg) => { setPaying(false); setCart([]); finished(msg); }}
          onQr={(state) => { const snapshot = cart; setPaying(false); setCart([]); setQr({ state, total: cartTotal, cart: snapshot }); loadSales().catch(() => {}); }}
        />
      )}
      {qr && (
        <QrDialog
          key={qr.state.sale_id} start={qr.state} total={qr.total}
          onClose={() => { setQr(null); loadSales().catch(() => {}); }}
          onPaid={() => finished(`Paid: ${money(qr.total)} by card.`)}
          onCanceled={() => { const back = qr.cart; setQr(null); if (back.length) setCart(back); finished(back.length ? "Canceled. The items are back in the cart." : "Canceled."); }}
        />
      )}
      {voiding && <VoidDialog sale={voiding} onClose={() => setVoiding(null)} onDone={(msg) => { setVoiding(null); finished(msg); }} />}
      {editing && <ItemDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); show("Price list saved."); loadItems().catch((e) => setError(e.message)); }} />}
      <Toast msg={toast} />
    </>
  );
}

function AddDialog({ item, family, onClose, onAdd }: { item: StoreItem; family: Family | null; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const kids = (family?.children ?? []).filter((c) => c.active).sort((a, b) => (a.birth_date ?? "9999").localeCompare(b.birth_date ?? "9999"));
  const sizeFor = (c: Child | undefined) => { const s = sizeName(c?.uniform_size); return s && item.sizes.includes(s) ? s : null; };
  const [childId, setChildId] = useState<string | null>(kids.length === 1 ? kids[0].id : null);
  const [size, setSize] = useState<string | null>(item.sizes.length ? sizeFor(kids.length === 1 ? kids[0] : undefined) : null);
  const [qty, setQty] = useState(1);
  const child = kids.find((c) => c.id === childId);
  const needSize = item.sizes.length > 0 && !size;

  function pickChild(id: string | null) {
    setChildId(id);
    const s = sizeFor(kids.find((c) => c.id === id));
    if (s) setSize(s);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (needSize) return;
    onAdd({ key: `${item.id}|${size ?? ""}|${childId ?? ""}`, item_id: item.id, name: item.name, size, quantity: qty, unit_cents: item.price_cents, child_id: childId, child_name: child ? child.first_name : null, esa_ok: item.esa_ok });
  }

  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{item.name}</h2>
        <p className="hint">{money(item.price_cents)} each · {KIND_WORDS[item.kind]}{item.esa_ok ? ", ESA can pay" : ""}</p>
        {kids.length > 0 && (
          <div className="field" style={{ marginTop: 12 }}>
            <span className="label">For</span>
            <div className="chips" style={{ marginTop: 0 }} role="group" aria-label="For">
              {kids.map((c) => <button type="button" key={c.id} className="chipbtn" aria-pressed={childId === c.id} onClick={() => pickChild(c.id)}>{c.first_name}</button>)}
              <button type="button" className="chipbtn" aria-pressed={childId === null} onClick={() => pickChild(null)}>{kids.length ? "Someone else" : "No one in particular"}</button>
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
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button className="btn" disabled={needSize}>{needSize ? "Pick a size" : `Add ${money(item.price_cents * qty)}`}</button></div>
      </form>
    </Dialog>
  );
}

type Step = "choose" | "tap" | "esa" | "jackrabbit" | "cash" | "free";

function PayDialog({ cart, family, sites, siteId, lockSite, config, onSite, onRemove, onClose, onSold, onQr }: {
  cart: CartLine[]; family: Family | null; sites: Site[]; siteId: string; lockSite: boolean; config: StoreConfig | null;
  onSite: (id: string) => void; onRemove: (key: string) => void; onClose: () => void; onSold: (msg: string) => void; onQr: (s: CheckoutState) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = cart.reduce((n, l) => n + l.unit_cents * l.quantity, 0);
  const kids = new Map((family?.children ?? []).map((c) => [c.id, c]));
  const billedHere = !!family?.stripe_customer_id;
  const esaReady = billedHere && cart.every((l) => l.esa_ok && l.child_id && esaKid(kids.get(l.child_id)));
  const esaNames = [...new Set(cart.map((l) => l.child_name).filter(Boolean))].join(" and ");
  const qrOff = !config || config.card === "off" || total < 50;

  const sale = (pay: StorePay, cardTapped = false): NewSale => ({
    site_id: siteId, family_id: family?.id ?? null, pay, card_tapped: cardTapped, note: note.trim() || null,
    lines: cart.map((l) => ({ item_id: l.item_id, size: l.size, quantity: l.quantity, child_id: l.child_id, unit_cents: l.unit_cents })),
  });
  async function sell(pay: StorePay, msg: string, cardTapped = false) {
    setBusy(true); setError(null);
    try { const a = await api(); await a.sell(sale(pay, cardTapped)); onSold(msg); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function showQr() {
    setBusy(true); setError(null);
    try { const a = await api(); onQr(await a.storeCheckout(sale("card"))); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const back = <button type="button" className="btn quiet" onClick={() => { setStep("choose"); setError(null); }}>Back</button>;

  return (
    <Dialog open onClose={onClose}>
      <h2>{step === "choose" ? `Take ${money(total)}` : step === "tap" ? "Tap to Pay in the Stripe app" : step === "esa" ? "Put it on the ESA invoice" : step === "jackrabbit" ? "Add it to their Jackrabbit account" : step === "cash" ? "Cash" : "No charge"}</h2>
      {step === "choose" && (
        <>
          <div className="cartlines">
            {cart.map((l) => (
              <div key={l.key} className="line" style={{ alignItems: "center" }}>
                <span>{lineWords(l)}{l.child_name ? <span className="hint">, {l.child_name}</span> : null}</span>
                <span className="v">{money(l.unit_cents * l.quantity)} <button className="linkbtn" onClick={() => onRemove(l.key)} aria-label={`Remove ${l.name}`}>remove</button></span>
              </div>
            ))}
          </div>
          <p className="hint" style={{ margin: "4px 0 12px" }}>{family ? family.name : "Walk-up sale"}{lockSite ? ` · ${siteName(siteId)}` : ""}</p>
          {!lockSite && sites.length > 1 && (
            <div className="field"><label htmlFor="sold-at">Sold at</label>
              <select id="sold-at" value={siteId} onChange={(e) => onSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
          )}
          <div className="paylist">
            <button className="payopt" disabled={busy || qrOff} onClick={showQr}>
              <b>Card: show a QR code{config?.card === "practice" ? <Tag kind="gold">Practice</Tag> : null}</b>
              <span>{qrOff ? (total < 50 ? "Stripe can't take a card payment under $0.50." : config?.why ?? "Not set up yet.") : "The parent scans it and pays on Stripe's page with Apple Pay, Google Pay or a card."}</span>
            </button>
            <button className="payopt" disabled={busy} onClick={() => setStep("tap")}>
              <b>Card: Tap to Pay in the Stripe app</b>
              <span>Charge {money(total)} on your phone in the Stripe app, then record it here.</span>
            </button>
            {billedHere && (
              <button className="payopt" disabled={busy || !esaReady} onClick={() => setStep("esa")}>
                <b>ESA invoice</b>
                <span>{esaReady ? `Goes on ${esaNames}'s next Family Desk ESA invoice.` : "Only required uniforms for a child in an ESA class, with the child picked for each one."}</span>
              </button>
            )}
            {family && !billedHere && (
              <button className="payopt" disabled={busy} onClick={() => setStep("jackrabbit")}>
                <b>Their Jackrabbit account</b>
                <span>For families still billed in Jackrabbit, including ESA families. You post it there.</span>
              </button>
            )}
            <button className="payopt" disabled={busy} onClick={() => setStep("cash")}><b>Cash</b><span>Paid at the desk in cash.</span></button>
            <button className="payopt" disabled={busy} onClick={() => setStep("free")}><b>No charge</b><span>A replacement, a trainer's shirt, a giveaway. Needs a reason.</span></button>
          </div>
          {busy && <p className="hint" style={{ marginTop: 10 }}>Making the payment page…</p>}
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}><button className="btn quiet" onClick={onClose}>Keep shopping</button></div>
        </>
      )}
      {step === "tap" && (
        <>
          <ol className="steps">
            <li>Open the <b>Stripe</b> app on your phone (signed in to Hero.Training).</li>
            <li>Tap <b>+</b> and charge <b>{money(total)}</b>, choosing <b>Tap to Pay</b>.</li>
            <li>Have the parent hold their card or phone to yours.</li>
            <li>When Stripe shows it paid, come back here.</li>
          </ol>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy} onClick={() => sell("card", `Paid: ${money(total)} with Tap to Pay.`, true)}>{busy ? "Saving…" : "Payment went through"}</button></div>
        </>
      )}
      {step === "esa" && (
        <>
          <p>{money(total)} goes on {esaNames}'s next ESA invoice when an owner or admin creates that class month's invoices on the Money screen. The family pays it through ClassWallet with their tuition.</p>
          <p className="hint" style={{ marginTop: 8 }}>If that month's invoice was already made, it waits for the month after.</p>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy} onClick={() => sell("esa", `On ${esaNames}'s next ESA invoice: ${money(total)}.`)}>{busy ? "Saving…" : "Put it on the invoice"}</button></div>
        </>
      )}
      {step === "jackrabbit" && family && (
        <>
          <p>Post this on the {family.name} account in Jackrabbit now, so it lands on their next statement:</p>
          <ul className="steps">
            {cart.map((l) => <li key={l.key}>{l.esa_ok ? "Uniform: (Required)" : "Merchandise"}, {money(l.unit_cents * l.quantity)}: {lineWords(l)}{l.child_name ? ` for ${l.child_name}` : ""}</li>)}
          </ul>
          <p className="hint" style={{ marginTop: 8 }}>Family Desk keeps the record and the hand-out list; Jackrabbit bills it until this family moves over.</p>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy} onClick={() => sell("jackrabbit", `Recorded. Post ${money(total)} on the ${family.name} Jackrabbit account.`)}>{busy ? "Saving…" : "I'll post it in Jackrabbit"}</button></div>
        </>
      )}
      {step === "cash" && (
        <>
          <p>Took <b>{money(total)}</b> in cash?</p>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="cash-note">Note (optional)</label><input id="cash-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change given, who paid" /></div>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy} onClick={() => sell("cash", `Paid: ${money(total)} in cash.`)}>{busy ? "Saving…" : "Cash received"}</button></div>
        </>
      )}
      {step === "free" && (
        <form onSubmit={(e) => { e.preventDefault(); sell("free", "Recorded as no charge."); }}>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="free-note">Why there's no charge</label><input id="free-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Replacement for a torn shirt" required minLength={3} /></div>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : "Record it"}</button></div>
        </form>
      )}
    </Dialog>
  );
}

function QrDialog({ start, total, onClose, onPaid, onCanceled }: { start: CheckoutState; total: number; onClose: () => void; onPaid: () => void; onCanceled: () => void }) {
  const [st, setSt] = useState<CheckoutState>(start);
  const [svg, setSvg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!st.url) { setSvg(""); return; }
    let on = true;
    import("uqr").then((m) => { if (on) setSvg(m.renderSVG(st.url!, { ecc: "M", border: 2 })); }).catch(() => setError("The QR code didn't draw. Use Open the payment page instead."));
    return () => { on = false; };
  }, [st.url]);

  // Ask Stripe (through the store function) every 3 seconds whether the parent has paid.
  useEffect(() => {
    if (st.status !== "waiting" && st.status !== "processing") return;
    const t = window.setInterval(async () => {
      try {
        const a = await api();
        const r = await a.storeStatus(st.sale_id);
        const s = r.sales.find((x) => x.id === st.sale_id);
        if (!s || s.status === "unknown" || s.status === st.status) return; // a missed check; the next runs in 3 seconds
        if (s.status === "mismatch") setError(s.error ?? "Stripe's payment doesn't match this sale. Check it in Stripe.");
        setSt((p) => ({ ...p, status: s.status, url: s.url ?? p.url }));
      } catch { /* a missed check is fine; the next one runs in 3 seconds */ }
    }, 3000);
    return () => window.clearInterval(t);
  }, [st.sale_id, st.status]);

  useEffect(() => { if (st.status === "paid") onPaid(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [st.status]);

  async function fresh() {
    setBusy(true); setError(null);
    try { const a = await api(); setSt(await a.storeCheckout({ sale_id: st.sale_id })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setError(null);
    try {
      const a = await api();
      const r = await a.storeCancel(st.sale_id, "Canceled at the desk before paying");
      if (r.status === "paid") setSt((p) => ({ ...p, status: "paid", note: r.note }));
      else onCanceled();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setAsking(false); }
  }

  const practice = st.live === false;
  return (
    <Dialog open onClose={onClose}>
      <h2>{st.status === "paid" ? "Paid" : `Scan to pay ${money(total)}`}</h2>
      {st.status === "paid" && (
        <div className="paid">
          <svg width="64" height="64" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" /><path d="m7 12.5 3.2 3.2L17.5 8.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <p><b>{money(total)}</b> paid by card{practice ? " (practice, no real money)" : ""}.</p>
          {st.note && <p className="hint">{st.note}</p>}
        </div>
      )}
      {(st.status === "waiting" || st.status === "processing") && (
        <>
          {practice && <p className="notice small">Practice mode: no real money. Test card 4242 4242 4242 4242, any future date, any CVC.</p>}
          {svg ? <div className="qrbox" role="img" aria-label="QR code for Stripe's payment page" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="hint">Drawing the QR code…</p>}
          <p className="hint" style={{ textAlign: "center" }}>{st.status === "processing" ? "The payment is going through…" : "The parent points their phone camera at the code and pays on Stripe's page. This updates by itself."}</p>
          {st.url && <p style={{ textAlign: "center", marginTop: 6 }}><a href={st.url} target="_blank" rel="noreferrer">Open the payment page</a></p>}
        </>
      )}
      {st.status === "expired" && <p>This payment page expired before anyone paid. Make a new QR code, or cancel the sale.</p>}
      {(st.status === "void" || st.status === "other_mode" || st.status === "unknown" || st.status === "mismatch") && <p className="hint">{st.status === "void" ? "This sale was canceled." : "Stripe can't be checked for this sale right now. Look it up in Stripe before doing anything else."}</p>}
      <ErrorBox error={error} />
      {asking ? (
        <div className="row end" style={{ marginTop: 14 }}>
          <span className="hint" style={{ marginRight: "auto" }}>Cancel this sale? Stripe is checked first in case they just paid.</span>
          <button className="btn quiet" onClick={() => setAsking(false)}>No</button><button className="btn danger quiet" disabled={busy} onClick={cancel}>{busy ? "Checking…" : "Cancel the sale"}</button>
        </div>
      ) : (
        <div className="row end" style={{ marginTop: 14 }}>
          {(st.status === "waiting" || st.status === "expired") && <button className="btn quiet danger" onClick={() => setAsking(true)}>Cancel the sale</button>}
          {st.status === "expired" && <button className="btn" disabled={busy} onClick={fresh}>{busy ? "Making it…" : "New QR code"}</button>}
          <button className="btn" onClick={onClose}>{st.status === "paid" ? "Done" : "Close"}</button>
        </div>
      )}
      {st.status === "waiting" && <p className="hint" style={{ marginTop: 8 }}>Closing keeps the sale waiting; it stays under Recent sales with its QR code.</p>}
    </Dialog>
  );
}

function VoidDialog({ sale, onClose, onDone }: { sale: StoreSale; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = sale.pay === "card" && sale.status === "waiting";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const a = await api();
      if (card) {
        const r = await a.storeCancel(sale.id, reason.trim());
        if (r.status === "paid") { onDone(r.note ?? "The parent had already paid, so the sale is recorded as paid."); return; }
      } else {
        await a.voidSale(sale.id, `Voided: ${reason.trim()}`);
      }
      onDone(sale.pay === "jackrabbit" ? "Voided. Take it off their Jackrabbit account too." : "Voided.");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{card ? "Cancel this sale?" : "Void this sale?"}</h2>
        <p>{sale.family?.name ?? "Walk-up sale"}, {money(sale.total_cents)}: {sale.lines.map((l) => lineWords(l)).join(", ")}.</p>
        <p className="hint" style={{ marginTop: 6 }}>{card ? "Stripe is checked first; if the parent already paid, the sale is kept as paid." : sale.pay === "cash" ? "Give the cash back if it was taken." : sale.pay === "jackrabbit" ? "Take the charge off their Jackrabbit account too." : sale.pay === "esa" ? "It comes off the list for the next ESA invoice." : "The record stays, marked voided."}</p>
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="void-reason">Why (goes in the log)</label><input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rang up the wrong size" required minLength={3} /></div>
        <ErrorBox error={error} />
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Keep it</button><button className="btn danger quiet" disabled={busy || reason.trim().length < 3}>{busy ? "Saving…" : card ? "Cancel the sale" : "Void it"}</button></div>
      </form>
    </Dialog>
  );
}

const DEFAULT_SIZES = "Youth XS, Youth S, Youth M, Youth L, Youth XL, Adult S, Adult M, Adult L, Adult XL, Adult 2XL";

function ItemDialog({ item, onClose, onSaved }: { item: StoreItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState<StoreKind>(item?.kind ?? "gear");
  const [price, setPrice] = useState(item ? (item.price_cents / 100).toFixed(2) : "");
  const [sizes, setSizes] = useState(item ? item.sizes.join(", ") : DEFAULT_SIZES);
  const [esaOk, setEsaOk] = useState(item?.esa_ok ?? false);
  const [active, setActive] = useState(item?.active ?? true);
  const [sort, setSort] = useState(String(item?.sort ?? 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    if (!name.trim()) { setError("Give it a name."); return; }
    if (!Number.isFinite(cents) || cents < 0 || cents > 100000) { setError("Price must be between $0 and $1,000."); return; }
    setBusy(true); setError(null);
    try {
      const a = await api();
      await a.saveStoreItem({ id: item?.id, name: name.trim(), kind, price_cents: cents, sizes: sizes.split(",").map((s) => s.trim()).filter(Boolean), esa_ok: kind === "uniform" && esaOk, active, sort: Number(sort) || 100 });
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{item ? "Edit item" : "Add an item"}</h2>
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="it-name">Name</label><input id="it-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="HERO uniform T-shirt, red" required /></div>
        <div className="two">
          <div className="field"><label htmlFor="it-kind">Type</label>
            <select id="it-kind" value={kind} onChange={(e) => setKind(e.target.value as StoreKind)}><option value="uniform">Required uniform</option><option value="gear">Gear</option><option value="other">Other</option></select>
          </div>
          <div className="field"><label htmlFor="it-price">Price ($)</label><input id="it-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="25.00" required /></div>
        </div>
        <div className="field"><label htmlFor="it-sizes">Sizes, separated by commas (leave empty for one size)</label><input id="it-sizes" value={sizes} onChange={(e) => setSizes(e.target.value)} /></div>
        <label className="chk"><input type="checkbox" checked={kind === "uniform" && esaOk} disabled={kind !== "uniform"} onChange={(e) => setEsaOk(e.target.checked)} />ESA can pay for it (a uniform the program requires)</label>
        <label className="chk"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />For sale</label>
        <div className="field" style={{ maxWidth: 160 }}><label htmlFor="it-sort">Order on the screen</label><input id="it-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} /></div>
        <ErrorBox error={error} />
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Dialog>
  );
}
