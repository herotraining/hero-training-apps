import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { EsaInvoice, Family as Fam, Staff, StripePicture } from "../types";
import { ageOn, dateWords, ESA_LABEL, money, monthWords, unixWords, WEEKDAYS, timeWords, siteName } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";

const AGREEMENT: Record<string, string> = { waiver: "Waiver", photo_release: "Photo release", policies: "Policies" };
const PAYWORDS: Record<Fam["pay_method"], string> = { esa: "Arizona ESA", private: "Card or bank", split: "ESA for co-op, card for classes" };

export function Family({ id, staff }: { id: string; staff: Staff }) {
  const [fam, setFam] = useState<Fam | null | undefined>(undefined);
  const [invoices, setInvoices] = useState<EsaInvoice[]>([]);
  const [stripe, setStripe] = useState<StripePicture | null>(null);
  const [stripeErr, setStripeErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<EsaInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();
  const canMoney = staff.role === "owner" || staff.role === "admin";

  async function load() {
    const a = await api();
    const f = await a.family(id);
    setFam(f);
    if (f && canMoney) {
      const inv = await a.esaInvoices();
      setInvoices(inv.filter((i) => i.child?.family_id === f.id));
      a.stripeFamily(f.id).then(setStripe).catch((e) => setStripeErr(e.message));
    }
  }
  useEffect(() => { load().catch((e) => setError(e.message)); /* eslint-disable-next-line */ }, [id]);

  async function onMark(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!marking) return;
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
    setBusy(true);
    try {
      const a = await api();
      await a.markEsaPaid(marking.id, reason);
      setMarking(null);
      show(`Marked paid: ${marking.child?.first_name}'s ${monthWords(marking.class_month.slice(0, 7))} invoice.`);
      await load();
    } catch (err) { setError((err as Error).message); setMarking(null); }
    finally { setBusy(false); }
  }

  if (fam === undefined) return <div className="page"><Loading what="family" /></div>;
  if (fam === null) return <div className="page"><a className="back" href={href.families}>Back to families</a><ErrorBox error={error ?? "This family isn't in your view."} /></div>;

  const primary = (fam.guardians ?? []).find((g) => g.is_primary) ?? fam.guardians?.[0];
  const others = (fam.guardians ?? []).filter((g) => g !== primary);
  const unsigned = (fam.agreements ?? []).filter((a) => !a.signed_at);

  return (
    <>
      <Band>
        <a className="back" href={href.families}>Back to families</a>
        <h1>{fam.name}</h1>
        <p className="contact">
          {primary ? `${primary.name}${primary.mobile ? `, ${primary.mobile}` : ""}${primary.email ? `, ${primary.email}` : ""}` : "No guardian on file"}
          {others.length ? ` · also ${others.map((g) => g.name).join(", ")}` : ""}
        </p>
        <div className="row"><Tag kind={fam.pay_method === "esa" ? "esa" : fam.pay_method === "split" ? "gold" : undefined}>{PAYWORDS[fam.pay_method]}</Tag><span className="contact">{siteName(fam.site_id)}{fam.city ? `, ${fam.city}` : ""}{fam.text_consent ? " · okay to text" : " · no texts"}</span></div>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {unsigned.length > 0 && <div className="section"><div className="err">Not signed yet: {unsigned.map((a) => AGREEMENT[a.kind] ?? a.kind).join(", ")}.</div></div>}

        <div className="section">
          <h2>Children</h2>
          <div className="kids">
            {(fam.children ?? []).map((c) => (
              <div key={c.id} className="kid">
                <div className="nm">{c.first_name} {c.last_name}</div>
                <div className="meta">{ageOn(c.birth_date)} years old{c.house ? `, House ${c.house}` : ""}{c.uniform_size ? `, uniform ${c.uniform_size}` : ""}</div>
                <ul>
                  {(c.enrollments ?? []).map((e) => (
                    <li key={e.id}>{e.program?.name ?? e.program_id}{e.program?.weekday != null ? ` (${WEEKDAYS[e.program.weekday]}${e.program.start_time ? ` ${timeWords(e.program.start_time)}` : ""})` : ""} · {e.pay === "esa" ? "ESA" : "card"}{e.status !== "active" ? ` · ${e.status}` : ""}</li>
                  ))}
                  {(c.enrollments ?? []).length === 0 && <li>Not enrolled in anything</li>}
                </ul>
                {c.care && (c.care.allergies || c.care.medications || c.care.notes) && (
                  <div className="note">{[c.care.allergies && `Allergy: ${c.care.allergies}`, c.care.medications && `Medication: ${c.care.medications}`, c.care.notes].filter(Boolean).join(" · ")}</div>
                )}
                {c.care && (
                  <div className="care">
                    {c.care.emergency_contacts?.length ? <div><b>Emergency:</b> {c.care.emergency_contacts.map((x) => `${x.name} ${x.phone}`).join("; ")}</div> : null}
                    {c.care.authorized_pickups?.length ? <div><b>Pickup:</b> {c.care.authorized_pickups.join(", ")}</div> : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {canMoney && (
          <div className="section">
            <h2>ESA invoices</h2>
            {invoices.length === 0 ? <div className="pane"><p className="hint">{fam.pay_method === "private" ? "This family pays by card or bank, so there are no ESA invoices." : "No ESA invoices yet. Create the month's invoices from the Money screen."}</p></div> : (
              <div className="pane">
                {invoices.map((i) => (
                  <div key={i.id} className="line" style={{ alignItems: "center" }}>
                    <span>
                      <b>{i.child?.first_name}, {monthWords(i.class_month.slice(0, 7))}</b>
                      <span className="hint" style={{ display: "block" }}>{ESA_LABEL[i.status]}{i.sent_at ? ` · sent ${dateWords(i.sent_at)}` : ""}{i.paid_at ? ` · paid ${dateWords(i.paid_at)}` : ""}</span>
                      {i.hosted_invoice_url && <a className="hint" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">Open the invoice</a>}
                    </span>
                    <span className="v" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      {money(i.amount_cents)}
                      {i.status === "paid" ? <Tag kind="good">Paid</Tag> : (i.status === "sent" || i.status === "submitted" || i.status === "rejected") ? <button className="btn quiet small" onClick={() => setMarking(i)}>Mark paid</button> : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {canMoney && (
          <div className="section">
            <h2>Money</h2>
            <div className="pane">
              {!stripe && !stripeErr && fam.stripe_customer_id && <p className="hint">Checking Stripe…</p>}
              {!fam.stripe_customer_id && <p className="hint">No Stripe customer yet. The family gets one when they sign up through their Stripe link.</p>}
              {stripeErr && <p className="hint">Stripe is not reachable right now: {stripeErr}</p>}
              {stripe?.note && <p className="hint">{stripe.note}</p>}
              {stripe?.subscriptions?.map((s) => (
                <div key={s.id} className="line">
                  <span>{s.description ?? "Monthly tuition"}<span className="hint" style={{ display: "block" }}>{s.items.map((it) => `${it.product}${it.quantity > 1 ? ` × ${it.quantity}` : ""}`).join(", ")}</span></span>
                  <span className="v">{money(s.items.reduce((n, it) => n + (it.amount ?? 0) * it.quantity, 0))}/{s.items[0]?.interval ?? "month"}<span className="hint" style={{ display: "block" }}>{s.status === "active" || s.status === "trialing" ? `next charge ${unixWords(s.next_charge)}` : s.status}</span></span>
                </div>
              ))}
              {stripe?.payment_methods?.map((p) => <div key={p.id} className="line"><span>Pays with</span><span className="v">{p.brand ? p.brand[0].toUpperCase() + p.brand.slice(1) : p.type} ending {p.last4}</span></div>)}
              {stripe && stripe.subscriptions?.length === 0 && stripe.payment_methods?.length === 0 && !stripe.note && <p className="hint">No autopay set up yet.</p>}
            </div>
            {stripe?.payments?.length ? (
              <div className="pane"><h3>Recent payments</h3>
                {stripe.payments.map((p) => <div key={p.id} className="line"><span>{unixWords(p.created)}, {p.description ?? "Payment"}</span><span className="v">{money(p.amount)} <span className="hint">{p.status}{p.last4 ? ` · ${p.method === "card" ? "card" : "bank"} ${p.last4}` : ""}{p.refunded ? ` · ${money(p.refunded)} refunded` : ""}</span></span></div>)}
              </div>
            ) : null}
            {stripe?.invoices?.filter((i) => !i.esa).length ? (
              <div className="pane"><h3>Stripe invoices</h3>
                {stripe.invoices.filter((i) => !i.esa).map((i) => <div key={i.id} className="line"><span>{i.number ?? i.id}, {unixWords(i.created)}</span><span className="v">{money(i.total)} <span className="hint">{i.status}</span></span></div>)}
              </div>
            ) : null}
            <p className="hint" style={{ marginTop: 10 }}>Refunds and card changes happen in Stripe's own dashboard, which logs who did them.</p>
          </div>
        )}

        {fam.notes && <div className="section"><h2>Notes</h2><div className="pane">{fam.notes}</div></div>}
      </div>

      <Dialog open={!!marking} onClose={() => setMarking(null)}>
        <form onSubmit={onMark}>
          <h2>Mark this invoice paid</h2>
          <p className="hint">{marking?.child?.first_name}, {marking ? monthWords(marking.class_month.slice(0, 7)) : ""}, {marking ? money(marking.amount_cents) : ""}. Only do this once the ClassWallet deposit is in the bank.</p>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="reason">Why (goes in the log)</label><input id="reason" name="reason" placeholder="ClassWallet deposit of $250 seen in the bank on Nov 28" required minLength={6} /></div>
          <div className="row end"><button type="button" className="btn quiet" onClick={() => setMarking(null)}>Cancel</button><button className="btn" disabled={busy}>Mark paid</button></div>
        </form>
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}
