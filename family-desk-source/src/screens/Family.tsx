import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { AGREEMENT_KINDS, type Child, type Enrollment, type EsaInvoice, type Family as Fam, type Guardian, type Program, type Site, type Staff, type StripePicture } from "../types";
import { ageWords, dateWords, ESA_LABEL, money, monthWords, unixWords, WEEKDAYS, timeWords, siteName } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";
import { CareDialog, ChildDialog, EnrollDialog, FamilyDialog, GuardianDialog, STATUS_WORDS } from "./FamilyEdit";

const AGREEMENT: Record<string, string> = { waiver: "Waiver", photo_release: "Photo release", policies: "Policies" };
const PAYWORDS: Record<Fam["pay_method"], string> = { esa: "Arizona ESA", private: "Card or bank", split: "ESA for co-op, card for classes" };

type Open =
  | { kind: "family" } | { kind: "guardian"; guardian: Guardian | null } | { kind: "child"; child: Child | null }
  | { kind: "care"; child: Child } | { kind: "enroll"; child: Child; enrollment: Enrollment | null } | { kind: "sign"; agreement: string } | null;

export function Family({ id, staff }: { id: string; staff: Staff }) {
  const [fam, setFam] = useState<Fam | null | undefined>(undefined);
  const [invoices, setInvoices] = useState<EsaInvoice[]>([]);
  const [stripe, setStripe] = useState<StripePicture | null>(null);
  const [stripeErr, setStripeErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<EsaInvoice | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [houses, setHouses] = useState<string[]>([]);
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
  useEffect(() => {
    if (!canMoney) return;
    api().then(async (a) => {
      const [s, p, fams] = await Promise.all([a.sites(), a.programs(), a.families()]);
      setSites(s); setPrograms(p);
      setHouses([...new Set(fams.flatMap((f) => (f.children ?? []).map((c) => c.house)).filter((h): h is string => !!h))].sort());
    }).catch(() => {});
  }, [canMoney]);

  const canEdit = canMoney && (!staff.site_id || staff.site_id === fam?.site_id);
  const saved = (what: string) => { setOpen(null); show(what); load().catch((e) => setError(e.message)); };

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

  async function onSign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!open || open.kind !== "sign" || !fam) return;
    const by = String(new FormData(e.currentTarget).get("signed_by") ?? "").trim();
    setBusy(true);
    try { const a = await api(); await a.setAgreement(fam.id, open.agreement, by); saved(`${AGREEMENT[open.agreement] ?? open.agreement} marked signed by ${by}.`); }
    catch (err) { setError((err as Error).message); setOpen(null); }
    finally { setBusy(false); }
  }

  if (fam === undefined) return <div className="page"><Loading what="family" /></div>;
  if (fam === null) return <div className="page"><a className="back" href={href.families}>Back to families</a><ErrorBox error={error ?? "This family isn't in your view."} /></div>;

  const primary = (fam.guardians ?? []).find((g) => g.is_primary) ?? fam.guardians?.[0];
  const others = (fam.guardians ?? []).filter((g) => g !== primary);
  const agreements = AGREEMENT_KINDS.map((k) => (fam.agreements ?? []).find((a) => a.kind === k) ?? { id: k, kind: k, signed_at: null, signed_by: null });
  const unsigned = agreements.filter((a) => !a.signed_at);
  const kids = (fam.children ?? []).slice().sort((a, b) => (a.birth_date ?? "9999").localeCompare(b.birth_date ?? "9999"));
  const agreementsRecorded = (fam.agreements ?? []).length > 0;

  return (
    <>
      <Band>
        <a className="back" href={href.families}>Back to families</a>
        <h1>{fam.name}{fam.status !== "active" ? <span className="hint" style={{ color: "inherit", opacity: .8 }}> · {fam.status === "left" ? "left HERO" : fam.status}</span> : null}</h1>
        <p className="contact">
          {primary ? `${primary.name}${primary.mobile ? `, ${primary.mobile}` : ""}${primary.email ? `, ${primary.email}` : ""}` : "No parent or guardian on file"}
          {others.length ? ` · also ${others.map((g) => g.name).join(", ")}` : ""}
        </p>
        <div className="row"><Tag kind={fam.pay_method === "esa" ? "esa" : fam.pay_method === "split" ? "gold" : undefined}>{PAYWORDS[fam.pay_method]}</Tag><span className="contact">{siteName(fam.site_id)}{fam.city && fam.city.toLowerCase() !== siteName(fam.site_id).toLowerCase() ? `, lives in ${fam.city}` : ""}{fam.text_consent ? " · okay to text" : " · no texts"}</span></div>
        {canEdit && <div className="row" style={{ marginTop: 6 }}><button className="btn quiet small" onClick={() => setOpen({ kind: "family" })}>Edit family</button><button className="btn quiet small" onClick={() => setOpen({ kind: "child", child: null })}>Add a child</button></div>}
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {agreementsRecorded && unsigned.length > 0 && <div className="section"><div className="err">Not signed yet: {unsigned.map((a) => AGREEMENT[a.kind] ?? a.kind).join(", ")}.</div></div>}

        <div className="section">
          <h2>Children</h2>
          {kids.length === 0 && <div className="pane"><p className="hint">No children yet.{canEdit ? " Use Add a child above." : ""}</p></div>}
          <div className="kids">
            {kids.map((c) => (
              <div key={c.id} className={"kid" + (c.active ? "" : " off")}>
                <div className="nm">{c.first_name} {c.last_name}{!c.active && <Tag kind="warn">Left</Tag>}</div>
                <div className="meta">{ageWords(c.birth_date)}{c.house ? `, House ${c.house}` : ""}{c.uniform_size ? `, uniform ${c.uniform_size}` : ""}{c.site_id !== fam.site_id ? `, ${siteName(c.site_id)}` : ""}{c.esa ? ", ESA" : ""}</div>
                <ul>
                  {(c.enrollments ?? []).map((e) => (
                    <li key={e.id}>
                      {e.program?.name ?? e.program_id}{e.program?.weekday != null ? ` (${WEEKDAYS[e.program.weekday]}${e.program.start_time ? ` ${timeWords(e.program.start_time)}` : ""})` : ""} · {e.pay === "esa" ? "ESA" : "card"}{e.status !== "active" ? ` · ${STATUS_WORDS[e.status].toLowerCase()}` : ""}
                      {canEdit && <button className="linkbtn" onClick={() => setOpen({ kind: "enroll", child: c, enrollment: e })}>change</button>}
                    </li>
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
                    {!c.care.emergency_contacts?.length && !c.care.authorized_pickups?.length && !c.care.allergies && !c.care.medications && <div>No care notes yet.</div>}
                  </div>
                )}
                {canEdit && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn quiet small" onClick={() => setOpen({ kind: "enroll", child: c, enrollment: null })}>Enroll</button>
                    <button className="btn quiet small" onClick={() => setOpen({ kind: "care", child: c })}>Care notes</button>
                    <button className="btn quiet small" onClick={() => setOpen({ kind: "child", child: c })}>Edit</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="section">
          <h2>Parents and guardians</h2>
          <div className="pane">
            {(fam.guardians ?? []).map((g) => (
              <div key={g.id} className="line" style={{ alignItems: "center" }}>
                <span>{g.name}{g.is_primary ? <Tag>Main contact</Tag> : null}<span className="hint" style={{ display: "block" }}>{[g.mobile, g.email].filter(Boolean).join(" · ") || "No contact details"}</span></span>
                {canEdit && <button className="btn quiet small" onClick={() => setOpen({ kind: "guardian", guardian: g })}>Edit</button>}
              </div>
            ))}
            {(fam.guardians ?? []).length === 0 && <p className="hint">Nobody on file yet.</p>}
            {canEdit && <div className="row" style={{ marginTop: 10 }}><button className="btn quiet small" onClick={() => setOpen({ kind: "guardian", guardian: null })}>Add a parent or guardian</button></div>}
          </div>
        </div>

        <div className="section">
          <h2>Agreements</h2>
          <div className="pane">
            {!agreementsRecorded && <p className="hint" style={{ marginBottom: 8 }}>Not recorded in Family Desk yet; Jackrabbit still holds this family's signed forms. Mark each one here as you confirm it.</p>}
            {agreements.map((a) => (
              <div key={a.kind} className="line" style={{ alignItems: "center" }}>
                <span>{AGREEMENT[a.kind] ?? a.kind}<span className="hint" style={{ display: "block" }}>{a.signed_at ? `Signed ${dateWords(a.signed_at)}${a.signed_by ? ` by ${a.signed_by}` : ""}` : agreementsRecorded ? "Not signed" : "Not recorded"}</span></span>
                {canEdit && (a.signed_at
                  ? <button className="btn quiet small" onClick={async () => { try { const x = await api(); await x.setAgreement(fam.id, a.kind, null); saved(`${AGREEMENT[a.kind]} marked unsigned.`); } catch (err) { setError((err as Error).message); } }}>Undo</button>
                  : <button className="btn quiet small" onClick={() => setOpen({ kind: "sign", agreement: a.kind })}>Mark signed</button>)}
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
              {!fam.stripe_customer_id && <p className="hint">No Stripe customer yet. The family gets one when they sign up through their Stripe link; until then billing stays in Jackrabbit.</p>}
              {stripeErr && <p className="hint">Stripe is not reachable right now: {stripeErr}</p>}
              {stripe?.note && fam.stripe_customer_id && <p className="hint">{stripe.note}</p>}
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

      <Dialog open={open?.kind === "sign"} onClose={() => setOpen(null)}>
        <form onSubmit={onSign}>
          <h2>Mark {open?.kind === "sign" ? (AGREEMENT[open.agreement] ?? open.agreement).toLowerCase() : ""} signed</h2>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="signed_by">Signed by</label><input id="signed_by" name="signed_by" defaultValue={primary?.name ?? ""} required /></div>
          <div className="row end"><button type="button" className="btn quiet" onClick={() => setOpen(null)}>Cancel</button><button className="btn" disabled={busy}>Mark signed</button></div>
        </form>
      </Dialog>

      {canEdit && (
        <>
          <FamilyDialog open={open?.kind === "family"} onClose={() => setOpen(null)} family={fam} sites={sites} lockSite={staff.site_id} onSaved={() => saved("Family saved.")} />
          {open?.kind === "guardian" && <GuardianDialog open onClose={() => setOpen(null)} familyId={fam.id} guardian={open.guardian} onSaved={() => saved("Saved.")} />}
          {open?.kind === "child" && <ChildDialog open onClose={() => setOpen(null)} family={fam} child={open.child} sites={sites} houses={houses} onSaved={() => saved(open.child ? "Saved." : "Child added. Now enroll them in a program.")} />}
          {open?.kind === "care" && <CareDialog open onClose={() => setOpen(null)} child={open.child} onSaved={() => saved("Care notes saved.")} />}
          {open?.kind === "enroll" && <EnrollDialog open onClose={() => setOpen(null)} child={open.child} family={fam} programs={programs} enrollment={open.enrollment} onSaved={() => saved("Enrollment saved. Rosters update right away.")} />}
        </>
      )}
      <Toast msg={toast} />
    </>
  );
}
