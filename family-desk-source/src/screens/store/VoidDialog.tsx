// Void (or, for a card sale still waiting, cancel) a sale, with a reason for the log.
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { StoreSale } from "../../types";
import { money } from "../../lib/util";
import { Dialog, ErrorBox } from "../../ui";
import { lineWords } from "./shared";

export function VoidDialog({ sale, onClose, onDone }: { sale: StoreSale; onClose: () => void; onDone: (msg: string) => void }) {
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
