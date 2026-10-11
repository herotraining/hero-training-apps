import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ClassWalletDeposit, EsaInvoice } from "../types";
import { arizonaNow, ESA_LABEL, money, monthWords, dateWords, siteName } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";

function daysAgo(n: number): string {
  const d = arizonaNow(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
  const [deposits, setDeposits] = useState<ClassWalletDeposit[]>([]);
  const [confirming, setConfirming] = useState<{ deposit: ClassWalletDeposit; invoice: EsaInvoice } | null>(null);
  const [showAllDeposits, setShowAllDeposits] = useState(false);
  const [toast, show] = useToast();

  const load = () => api().then((a) => Promise.all([a.esaInvoices(), a.classwalletDeposits(daysAgo(45)).catch(() => [] as ClassWalletDeposit[])])).then(([i, d]) => { setInv(i); setDeposits(d); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // ClassWallet pays one bank deposit per order, net of 2%. Line each new deposit up with the open invoices for the same amount.
  const openForMatch = (inv ?? []).filter((i) => (i.status === "sent" || i.status === "submitted") && !deposits.some((d) => d.status === "confirmed" && d.esa_invoice_id === i.id));
  const newDeposits = deposits.filter((d) => d.status === "new");
  // A ClassWallet receipt, when there is one, names the student: keep only that child's invoices.
  const matched = newDeposits.map((d) => {
    const same = openForMatch.filter((i) => i.amount_cents === d.gross_cents);
    const childId = d.order?.child_id;
    const named = childId ? same.filter((i) => i.child_id === childId) : [];
    return { deposit: d, candidates: childId ? named : same };
  }).filter((m) => m.candidates.length > 0);
  const unmatched = newDeposits.filter((d) => !matched.some((m) => m.deposit.id === d.id));
  const byDay = new Map<string, ClassWalletDeposit[]>();
  for (const d of deposits) byDay.set(d.on_date, [...(byDay.get(d.on_date) ?? []), d]);
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  async function confirmDeposit() {
    if (!confirming) return;
    const { deposit, invoice } = confirming;
    setBusy(true); setError(null);
    try {
      const a = await api();
      await a.markEsaPaid(invoice.id, `ClassWallet deposit ${dateWords(deposit.on_date)}: ${money(deposit.net_cents)} in the bank for the ${money(deposit.gross_cents)} invoice`, deposit.id);
      setConfirming(null); show(`${invoice.child?.first_name}'s ${monthWords(invoice.class_month.slice(0, 7))} invoice is paid.`);
      await load();
    } catch (e) { setError((e as Error).message); setConfirming(null); }
    finally { setBusy(false); }
  }
  async function ignoreDeposit(d: ClassWalletDeposit) {
    try { const a = await api(); await a.setDepositStatus(d.id, "ignored", "Not a Family Desk invoice (billed in Jackrabbit)"); show("Set aside."); await load(); }
    catch (e) { setError((e as Error).message); }
  }

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
        {deposits.length > 0 && (
          <div className="section">
            <h2>ClassWallet deposits</h2>
            {matched.length > 0 && (
              <ul className="list">
                {matched.map(({ deposit, candidates }) => (
                  <li key={deposit.id}>
                    <div className="item">
                      <span className="n">{money(deposit.gross_cents)} on {dateWords(deposit.on_date)}{deposit.order ? ` · ${deposit.order.student}` : ""}</span>
                      <span className="k">{money(deposit.net_cents)} landed in the bank after ClassWallet's {money(deposit.fee_cents)} fee. {deposit.order ? `ClassWallet's receipt names ${deposit.order.student} (order of ${dateWords(deposit.order.order_date)}).` : candidates.length === 1 ? "One open invoice matches:" : `${candidates.length} open invoices match; check ClassWallet for the student, then pick:`}</span>
                      <span className="p" style={{ flexDirection: "column", alignItems: "flex-end" }}>
                        {candidates.map((c) => (
                          <button key={c.id} className="btn small" onClick={() => setConfirming({ deposit, invoice: c })}>{candidates.length === 1 ? "Mark paid: " : ""}{c.child?.first_name} {c.child?.last_name}, {monthWords(c.class_month.slice(0, 7))}</button>
                        ))}
                        <button className="linkbtn" onClick={() => ignoreDeposit(deposit)}>Not one of these (set aside)</button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="pane" style={{ marginTop: matched.length ? 12 : 0 }}>
              {matched.length === 0 && <p className="hint" style={{ marginTop: 0 }}>No new deposit matches an open Family Desk invoice right now.</p>}
              <p style={{ margin: "0 0 6px" }}><b>Last 45 days:</b> {deposits.length} deposits, {money(deposits.reduce((n, d) => n + d.gross_cents, 0))} submitted by families, {money(deposits.reduce((n, d) => n + d.fee_cents, 0))} kept by ClassWallet as fees.</p>
              {unmatched.length > 0 && <div className="line"><span className="hint">{unmatched.length} new {unmatched.length === 1 ? "deposit has" : "deposits have"} no open Family Desk invoice at that amount (families still billed in Jackrabbit, or a payment already marked paid).</span></div>}
              {(showAllDeposits ? days : days.slice(0, 5)).map(([day, list]) => (
                <div key={day} className="line">
                  <span>{dateWords(day)}: {list.length} {list.length === 1 ? "deposit" : "deposits"}, {money(list.reduce((n, d) => n + d.gross_cents, 0))}</span>
                  <span className="v hint">{list.filter((d) => d.status === "confirmed").length ? `${list.filter((d) => d.status === "confirmed").length} confirmed` : ""}{list.filter((d) => d.status === "new").length && !matched.some((m) => m.deposit.on_date === day) ? (list.filter((d) => d.status === "confirmed").length ? " · " : "") + `${list.filter((d) => d.status === "new").length} not in Family Desk` : ""}</span>
                </div>
              ))}
              {days.length > 5 && <div className="row" style={{ marginTop: 8 }}><button className="linkbtn" onClick={() => setShowAllDeposits((v) => !v)}>{showAllDeposits ? "Show fewer days" : `Show all ${days.length} days`}</button></div>}
              <p className="hint">Read from the bank feed each morning. ClassWallet pays one deposit per order and keeps 2%. The bank line carries no name; when ClassWallet emailed a receipt for the order, the student's name is shown and only that child's invoices are offered. Otherwise check the order in ClassWallet first.</p>
            </div>
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
      <Dialog open={confirming !== null} onClose={() => setConfirming(null)}>
        {confirming && (
          <>
            <h2>Mark this invoice paid?</h2>
            <p>{confirming.invoice.child?.first_name} {confirming.invoice.child?.last_name} ({confirming.invoice.child?.family?.name}), {monthWords(confirming.invoice.class_month.slice(0, 7))}: {money(confirming.invoice.amount_cents)}.</p>
            <p className="hint">Paid by the ClassWallet deposit of {money(confirming.deposit.net_cents)} on {dateWords(confirming.deposit.on_date)}. Stripe will show it as paid outside Stripe, and the reason is written to the log.</p>
            <div className="row end"><button className="btn quiet" onClick={() => setConfirming(null)}>Cancel</button><button className="btn" disabled={busy} onClick={confirmDeposit}>{busy ? "Saving…" : "Mark paid"}</button></div>
          </>
        )}
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}
