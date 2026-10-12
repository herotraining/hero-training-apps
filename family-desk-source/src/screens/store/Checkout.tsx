// Checkout: one dialog, two steps. First the receipt (who, where, what), then one way to pay. The rules of what
// each way needs live in the database (store_create_sale); this only hides options that can't apply.
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { CartLine, CheckoutState, Family, NewSale, Site, StoreConfig, StorePay } from "../../types";
import { money, siteName } from "../../lib/util";
import { Dialog, ErrorBox, Tag } from "../../ui";
import { esaKid, lineWords } from "./shared";

type Step = "review" | "choose" | "tap" | "esa" | "jackrabbit" | "cash" | "free";

export function Checkout({ cart, family, sites, siteId, lockSite, config, onSite, onClose, onSold, onQr }: {
  cart: CartLine[]; family: Family | null; sites: Site[]; siteId: string; lockSite: boolean; config: StoreConfig | null;
  onSite: (id: string) => void; onClose: () => void; onSold: (msg: string, saleId: string) => void; onQr: (s: CheckoutState) => void;
}) {
  const [step, setStep] = useState<Step>("review");
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
    lines: cart.map((l) => ({ item_id: l.item_id, size: l.size, color: l.color, quantity: l.quantity, child_id: l.child_id, unit_cents: l.unit_cents })),
  });
  async function sell(pay: StorePay, msg: string, cardTapped = false) {
    setBusy(true); setError(null);
    try { const a = await api(); const made = await a.sell(sale(pay, cardTapped)); onSold(msg, made.id); }
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
  const titles: Record<Step, string> = { review: "Check out", choose: `Take ${money(total)}`, tap: "Tap to Pay in the Stripe app", esa: "Put it on the ESA invoice", jackrabbit: "Add it to their Jackrabbit account", cash: "Cash", free: "No charge" };

  return (
    <Dialog open onClose={onClose}>
      <h2>{titles[step]}</h2>
      {step === "review" && (
        <>
          <div className="cartlines">
            {cart.map((l) => (
              <div key={l.key} className="line" style={{ alignItems: "center" }}>
                <span>{lineWords(l)}{l.child_name ? <span className="hint">, {l.child_name}</span> : null}</span>
                <span className="v">{money(l.unit_cents * l.quantity)}</span>
              </div>
            ))}
            <div className="line" style={{ fontWeight: 700 }}><span>Total</span><span className="v">{money(total)}</span></div>
          </div>
          <p className="hint" style={{ margin: "8px 0 4px" }}>{family ? family.name : "Walk-up sale, no family"}{lockSite ? ` · ${siteName(siteId)}` : ""}</p>
          {!lockSite && sites.length > 1 && (
            <div className="field" style={{ marginTop: 8 }}><label htmlFor="sold-at">Sold at</label>
              <select id="sold-at" value={siteId} onChange={(e) => onSite(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            </div>
          )}
          <div className="field"><label htmlFor="sale-note">Note (optional)</label><input id="sale-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth remembering about this sale" /></div>
          <div className="row end" style={{ marginTop: 10 }}><button className="btn quiet" onClick={onClose}>Keep shopping</button><button className="btn" onClick={() => setStep("choose")}>Choose how to pay</button></div>
        </>
      )}
      {step === "choose" && (
        <>
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
          <div className="row end" style={{ marginTop: 14 }}><button className="btn quiet" onClick={() => setStep("review")}>Back</button></div>
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
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy} onClick={() => sell("cash", `Paid: ${money(total)} in cash.`)}>{busy ? "Saving…" : "Cash received"}</button></div>
        </>
      )}
      {step === "free" && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); sell("free", "Recorded as no charge."); }}>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="free-note">Why there's no charge</label><input id="free-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Replacement for a torn shirt" required minLength={3} /></div>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 14 }}>{back}<button className="btn" disabled={busy || note.trim().length < 3}>{busy ? "Saving…" : "Record it"}</button></div>
        </form>
      )}
    </Dialog>
  );
}
