// The Store: a shop of uniforms and gear with a cart beside it, one checkout, the hand-out list, recent sales,
// and (for owners) the price list. Cards are paid on Stripe's own pages, never here.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { CartLine, CheckoutState, Family, Site, Staff, StoreConfig, StoreItem, StoreKind, StoreSale, UniformRequest } from "../types";
import { arizonaToday, money, siteName, stripeDashboard } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";
import { AddDialog } from "./store/AddDialog";
import { Cart } from "./store/Cart";
import { Checkout } from "./store/Checkout";
import { ItemDialog } from "./store/ItemDialog";
import { QrDialog } from "./store/QrDialog";
import { Requests } from "./store/Requests";
import { VoidDialog } from "./store/VoidDialog";
import { KIND_WORDS, Photo, arizonaDay, canVoid, colorHex, lineWords, saleTag, sinceDays, whenWords } from "./store/shared";

const SITE_KEY = "hero.store.site";
const readSite = () => { try { return localStorage.getItem(SITE_KEY); } catch { return null; } };
const saveSite = (id: string) => { try { localStorage.setItem(SITE_KEY, id); } catch { /* per-device convenience only */ } };

export function Store({ staff, familyId }: { staff: Staff; familyId?: string }) {
  const isOwner = staff.role === "owner";
  const [items, setItems] = useState<StoreItem[] | null>(null);
  const [fams, setFams] = useState<Family[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [sales, setSales] = useState<StoreSale[] | null>(null);
  const [requests, setRequests] = useState<UniformRequest[]>([]);
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [famId, setFamId] = useState<string | null>(familyId ?? null);
  const [pickingFamily, setPickingFamily] = useState(false);
  const [q, setQ] = useState("");
  const [shopQ, setShopQ] = useState("");
  const [kindFilter, setKindFilter] = useState<StoreKind | "all">("all");
  const [siteId, setSiteId] = useState<string>(staff.site_id ?? "");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
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
  const loadRequests = async () => { const a = await api(); setRequests(await a.uniformRequests()); };

  useEffect(() => {
    api().then(async (a) => {
      const [it, f, s, sl, rq] = await Promise.all([a.storeItems(), a.families(), a.sites(), a.storeSales(sinceDays(45)), a.uniformRequests().catch(() => [] as UniformRequest[])]);
      setItems(it); setFams(f); setSites(s); setSales(sl); setRequests(rq);
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
    setFamId(f?.id ?? null); setQ(""); setPickingFamily(false);
    // Lines named for a child of another family no longer fit: keep the items, drop the names.
    if (cart.some((l) => l.child_id)) {
      setCart((c) => {
        const merged = new Map<string, CartLine>();
        for (const l of c) {
          const key = `${l.item_id}|${l.color ?? ""}|${l.size ?? ""}|`;
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
  const setQty = (key: string, qty: number) => setCart((c) => c.map((x) => (x.key === key ? { ...x, quantity: Math.max(1, Math.min(50, qty)) } : x)));
  const removeLine = (key: string) => setCart((c) => { const next = c.filter((x) => x.key !== key); if (!next.length) { setCartOpen(false); setPaying(false); } return next; });

  async function finished(msg: string, saleId?: string, fromCart: CartLine[] = []) {
    show(msg);
    const reqIds = fromCart.map((l) => l.request_id).filter((x): x is string => !!x);
    if (saleId && reqIds.length) { try { const a = await api(); await a.closeRequests(reqIds, "fulfilled", saleId, null); } catch (e) { setError(`The sale went through, but the uniform request was not marked filled: ${(e as Error).message}`); } }
    await Promise.all([loadSales(), loadRequests()]).catch((e) => setError(e.message));
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
  const forSale = (items ?? []).filter((i) => i.active && (kindFilter === "all" || i.kind === kindFilter) && (!shopQ.trim() || `${i.name} ${i.description ?? ""}`.toLowerCase().includes(shopQ.trim().toLowerCase())));
  const kindsOnSale = [...new Set((items ?? []).filter((i) => i.active).map((i) => i.kind))];
  const live = (sales ?? []).filter((s) => s.status !== "void");
  const toHandOut = live.flatMap((s) => s.lines.filter((l) => !l.handed_out_at).map((l) => ({ sale: s, line: l }))).reverse();
  // Today's takings leave out card sales still waiting on the parent; those are counted on their own.
  const todayAll = live.filter((s) => arizonaDay(s.created_at) === arizonaToday());
  const today = todayAll.filter((s) => s.status !== "waiting");
  const waitingToday = todayAll.length - today.length;
  const sum = (list: StoreSale[]) => list.reduce((n, s) => n + s.total_cents, 0);
  const shownSales = showAllSales ? sales ?? [] : (sales ?? []).slice(0, 12);

  const cartPanel = (
    <Cart cart={cart} family={family} onQty={setQty} onRemove={removeLine} onClear={() => { setCart([]); setCartOpen(false); }}
      onChangeFamily={() => { setCartOpen(false); setPickingFamily(true); }} onCheckout={() => { setCartOpen(false); setPaying(true); }} />
  );

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

        <div className="storewrap">
          <div>
            <div className="section">
              <h2>Shop</h2>
              <div className="shoptools">
                <input className="search" type="search" aria-label="Find an item" placeholder="Find an item" value={shopQ} onChange={(e) => setShopQ(e.target.value)} />
                {kindsOnSale.length > 1 && (
                  <div className="seg" role="group" aria-label="Type">
                    <button aria-pressed={kindFilter === "all"} onClick={() => setKindFilter("all")}>All</button>
                    {kindsOnSale.map((k) => <button key={k} aria-pressed={kindFilter === k} onClick={() => setKindFilter(k)}>{k === "uniform" ? "Uniforms" : k === "gear" ? "Gear" : "Other"}</button>)}
                  </div>
                )}
                {family ? (
                  <span className="hint">For <a href={href.family(family.id)}>{family.name}</a> · <button className="linkbtn" style={{ padding: 0 }} onClick={() => setPickingFamily(true)}>change</button></span>
                ) : (
                  <button className="btn quiet small" onClick={() => setPickingFamily(true)}>Pick a family</button>
                )}
              </div>
              {items === null && !error && <Loading what="the shop" />}
              {items && forSale.length === 0 && <div className="pane"><p className="hint">{(items.some((i) => i.active) ? "Nothing matches." : "Nothing is for sale yet.") + (isOwner ? " Add an item under Price list below." : "")}</p></div>}
              <div className="shop">
                {forSale.map((i) => (
                  <button key={i.id} className="tile" onClick={() => setAdding(i)} aria-label={`${i.name}, ${money(i.price_cents)}`}>
                    <Photo url={i.image_url} alt="" className="ph" />
                    <span className="body">
                      <span className="nm">{i.name}</span>
                      <span className="pr">{money(i.price_cents)}</span>
                      <span className="opts">{[i.sizes.length ? `${i.sizes.length} sizes` : "One size", i.esa_ok ? "ESA can pay" : KIND_WORDS[i.kind]].join(" · ")}</span>
                      {i.colors.length > 0 && <span className="swatches" aria-label={`Colors: ${i.colors.join(", ")}`}>{i.colors.map((c) => <span key={c} className="swatch" title={c} style={{ "--sw": colorHex(c) } as React.CSSProperties} />)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Requests requests={requests} families={fams} items={items ?? []} siteId={siteId}
              onDone={(msg) => finished(msg)} onError={() => {}}
              onAddToCart={(lines, familyId) => { setFamId(familyId); setCart((c) => [...c.filter((x) => !lines.some((l) => l.key === x.key)), ...lines]); show("In the cart. Check out when ready."); }} />

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
                <ul className="list pricelist">
                  {items.map((i) => (
                    <li key={i.id}><div className={"item" + (i.active ? "" : " off")}>
                      <Photo url={i.image_url} alt="" className="th" />
                      <span className="n">{i.name} · {money(i.price_cents)}</span>
                      <span className="k">{KIND_WORDS[i.kind]}{i.esa_ok ? ", ESA can pay" : ""} · {i.sizes.length ? `${i.sizes.length} sizes, ${i.sizes[0]} to ${i.sizes[i.sizes.length - 1]}` : "one size"}{i.colors.length ? ` · ${i.colors.join(", ")}` : ""}</span>
                      <span className="p">{!i.active && <Tag kind="warn">Not for sale</Tag>}<button className="btn quiet small" onClick={() => setEditing(i)}>Edit</button></span>
                    </div></li>
                  ))}
                </ul>
                <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={() => setEditing("new")}>Add an item</button></div>
                <p className="hint" style={{ marginTop: 8 }}>A price change applies to new sales only. Items marked not for sale stay in the history.</p>
              </div>
            )}
          </div>

          <aside aria-label="Cart">{cartPanel}</aside>
        </div>

        {cart.length > 0 && (
          <div className="cartbar" role="region" aria-label="Cart summary">
            <span><b>{cartCount} {cartCount === 1 ? "item" : "items"} · {money(cartTotal)}</b><span className="sub">{cart.map((l) => lineWords(l)).join(", ")}</span></span>
            <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
              <button className="linkbtn light" onClick={() => setCartOpen(true)}>View</button>
              <button className="btn" onClick={() => setPaying(true)}>Check out</button>
            </span>
          </div>
        )}
      </div>

      {pickingFamily && (
        <Dialog open onClose={() => { setPickingFamily(false); setQ(""); }}>
          <h2>Who's it for?</h2>
          <label htmlFor="who" className="hint">Search a parent or child, or leave it as a walk-up sale</label>
          <input id="who" className="search" type="search" placeholder="A parent, a child, an email, or a phone number" autoComplete="off" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
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
          <div className="row end" style={{ marginTop: 14 }}>
            {family && <button className="btn quiet" onClick={() => pickFamily(null)}>Walk-up sale instead</button>}
            <button className="btn quiet" onClick={() => { setPickingFamily(false); setQ(""); }}>Close</button>
          </div>
        </Dialog>
      )}
      {cartOpen && <Dialog open onClose={() => setCartOpen(false)}>{cartPanel}</Dialog>}
      {adding && <AddDialog item={adding} family={family} onClose={() => setAdding(null)} onAdd={addToCart} />}
      {paying && (
        <Checkout
          cart={cart} family={family} sites={sites} siteId={siteId} lockSite={!!staff.site_id} config={config}
          onSite={(id) => { setSiteId(id); saveSite(id); }}
          onClose={() => setPaying(false)}
          onSold={(msg, saleId) => { const snapshot = cart; setPaying(false); setCart([]); finished(msg, saleId, snapshot); }}
          onQr={(state) => { const snapshot = cart; setPaying(false); setCart([]); setQr({ state, total: cartTotal, cart: snapshot }); loadSales().catch(() => {}); }}
        />
      )}
      {qr && (
        <QrDialog
          key={qr.state.sale_id} start={qr.state} total={qr.total}
          onClose={() => { setQr(null); loadSales().catch(() => {}); }}
          onPaid={() => finished(`Paid: ${money(qr.total)} by card.`, qr.state.sale_id, qr.cart)}
          onCanceled={() => { const back = qr.cart; setQr(null); if (back.length) setCart(back); finished(back.length ? "Canceled. The items are back in the cart." : "Canceled."); }}
        />
      )}
      {voiding && <VoidDialog sale={voiding} onClose={() => setVoiding(null)} onDone={(msg) => { setVoiding(null); finished(msg); }} />}
      {editing && <ItemDialog item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); show("Price list saved."); loadItems().catch((e) => setError(e.message)); }} />}
      <Toast msg={toast} />
    </>
  );
}
