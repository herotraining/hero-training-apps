// The QR code for a card sale, kept up to date by asking the store function every few seconds.
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { CheckoutState } from "../../types";
import { money } from "../../lib/util";
import { Dialog, ErrorBox } from "../../ui";

export function QrDialog({ start, total, onClose, onPaid, onCanceled }: { start: CheckoutState; total: number; onClose: () => void; onPaid: () => void; onCanceled: () => void }) {
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
