import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { EsaInvoice } from "../types";
import { arizonaNow, ESA_LABEL, money, monthWords, dateWords, siteName } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";

function nextMonths(): string[] {
  const d = arizonaNow();
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() + i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function Money() {
  const [inv, setInv] = useState<EsaInvoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [month, setMonth] = useState(nextMonths()[1]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ class_month: string; created: any[]; skipped: any[] } | null>(null);
  const [toast, show] = useToast();

  const load = () => api().then((a) => a.esaInvoices()).then(setInv).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const open = (inv ?? []).filter((i) => i.status === "sent" || i.status === "submitted" || i.status === "rejected");
  const paid = (inv ?? []).filter((i) => i.status === "paid");
  const openTotal = open.reduce((n, i) => n + i.amount_cents, 0);
  const byMonth = new Map<string, EsaInvoice[]>();
  for (const i of inv ?? []) byMonth.set(i.class_month, [...(byMonth.get(i.class_month) ?? []), i]);

  async function create() {
    setBusy(true); setError(null);
    try {
      const a = await api();
      const r = await a.createEsaInvoices(month);
      setResult(r); setCreating(false);
      show(`${r.created.length} ${r.created.length === 1 ? "invoice" : "invoices"} created for ${r.class_month}.`);
      await load();
    } catch (e) { setError((e as Error).message); setCreating(false); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Band>
        <h1>Money</h1>
        <p className="lede">ESA invoices live here. Autopay, refunds and card changes run in Stripe; the books run in SuperBooks.</p>
        <div className="row"><button className="btn" onClick={() => setCreating(true)}>Create a month's ESA invoices</button><a className="btn quiet" href="https://dashboard.stripe.com/" target="_blank" rel="noreferrer">Open Stripe</a></div>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {inv === null && !error && <Loading what="invoices" />}
        {inv && (
          <div className="section grid3">
            <div className="pane"><span className="hint">ESA billed, not yet paid</span><div className="stat">{money(openTotal)}</div><span className="hint">{open.length} {open.length === 1 ? "invoice" : "invoices"}</span></div>
            <div className="pane"><span className="hint">Paid by ClassWallet</span><div className="stat">{money(paid.reduce((n, i) => n + i.amount_cents, 0))}</div><span className="hint">{paid.length} {paid.length === 1 ? "invoice" : "invoices"}</span></div>
            <div className="pane"><span className="hint">Sent back or problems</span><div className="stat">{inv.filter((i) => i.status === "rejected").length}</div><span className="hint">need a fix and a resend</span></div>
          </div>
        )}
        {result && (
          <div className="section pane">
            <h3>{result.class_month}: {result.created.length} created</h3>
            {result.created.map((c, i) => <div key={i} className="line"><span>{c.student}, {c.family}</span><span className="v">{money(c.amount)} <a className="hint" href={c.url} target="_blank" rel="noreferrer">open</a></span></div>)}
            {result.skipped.map((s, i) => <div key={"s" + i} className="line"><span>{s.student}</span><span className="v"><span className="hint">skipped: {s.why}</span></span></div>)}
          </div>
        )}
        {[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([m, list]) => (
          <div key={m} className="section">
            <h2>{monthWords(m.slice(0, 7))}</h2>
            <ul className="list">
              {list.map((i) => (
                <li key={i.id}><a className="item" href={href.family(i.child?.family_id ?? "")}>
                  <span className="n">{i.child?.first_name} {i.child?.last_name}</span>
                  <span className="k">{i.child?.family?.name} · {siteName(i.child?.site_id)} · {ESA_LABEL[i.status]}{i.paid_at ? ` ${dateWords(i.paid_at)}` : ""}</span>
                  <span className="p"><b>{money(i.amount_cents)}</b><Tag kind={i.status === "paid" ? "good" : i.status === "rejected" ? "warn" : "esa"}>{i.status === "paid" ? "Paid" : i.status === "rejected" ? "Problem" : "Open"}</Tag></span>
                </a></li>
              ))}
            </ul>
          </div>
        ))}
        {inv && inv.length === 0 && <div className="section pane"><p className="hint">No ESA invoices yet. Create the next class month's invoices with the button above.</p></div>}
      </div>

      <Dialog open={creating} onClose={() => setCreating(false)}>
        <h2>Create ESA invoices</h2>
        <p className="hint">One invoice per ESA child for the class month you pick. Children who already have one are skipped. Nothing is emailed; families see their invoice in the Family Hub.</p>
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="month">Class month</label>
          <select id="month" value={month} onChange={(e) => setMonth(e.target.value)}>{nextMonths().map((m) => <option key={m} value={m}>{monthWords(m)}</option>)}</select>
        </div>
        <div className="row end"><button className="btn quiet" onClick={() => setCreating(false)}>Cancel</button><button className="btn" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create invoices"}</button></div>
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}
