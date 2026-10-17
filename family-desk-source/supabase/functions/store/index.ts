// Store: card payments for front-desk sales through Stripe Checkout. The parent scans a QR code and pays on
// Stripe's own page, so Family Desk never sees a card. Owners and admins only: the caller's own session (row-level
// security) decides which sales they can touch, and store_create_sale prices every sale from the price list.
// A card sale's Stripe page and its outcome are written with the service key, and only after Stripe has been
// checked; the database refuses those changes from a staff member's own session.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, userClient, stripe, stripeKey } from "./_shared.ts";

const PAID_URL = Deno.env.get("STORE_PAID_URL") || "https://hero.training/paid.html";

// The store has its own Stripe key, so it can take real card payments while the rest of Family Desk stays in the
// sandbox. Without one it borrows the sandbox key and every payment is practice. A live key also needs
// STRIPE_STORE_LIVE_OK=yes, so real money only moves once an owner has said so.
function storeKey(): { key: string; live: boolean } | { off: string } {
  const k = Deno.env.get("STRIPE_STORE_KEY") || Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!k) return { off: "Card by QR code isn't set up yet: there's no Stripe key in Supabase secrets." };
  const live = /^(sk|rk)_live_/.test(k);
  if (live && Deno.env.get("STRIPE_STORE_LIVE_OK") !== "yes") {
    return { off: "A live Stripe key is saved for the store, but STRIPE_STORE_LIVE_OK isn't set to yes yet." };
  }
  return { key: k, live };
}

type Line = { name: string; size: string | null; quantity: number; unit_cents: number };
type Sale = {
  id: string; pay: string; status: string; total_cents: number; site_id: string;
  stripe_checkout_id: string | null; stripe_url: string | null; stripe_live: boolean | null; lines: Line[];
};

// What a Checkout Session means for the sale: paid, still open, expired, or complete but not settled yet.
function stateOf(s: any): "paid" | "open" | "expired" | "processing" {
  if (s.status === "complete") return s.payment_status === "paid" ? "paid" : "processing";
  return s.status === "open" ? "open" : "expired";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Send JSON" }, 400); }

  const db = userClient(req);
  const { data: prof, error: perr } = await db.rpc("my_profile");
  if (perr) return json({ error: perr.message }, 400);
  const staff = prof?.staff;
  if (!staff || !["owner", "admin"].includes(staff.role)) return json({ error: "Owners and admins only" }, 403);
  if (prof?.aal !== "aal2") return json({ error: "Finish two-step sign-in first" }, 403);

  const sk = storeKey();
  if (body.action === "config") return json("off" in sk ? { card: "off", why: sk.off } : { card: sk.live ? "live" : "practice" });
  if ("off" in sk) return json({ error: sk.off }, 503);
  const key = sk.key;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Read through the caller's own session: a sale they can't see is not theirs to act on.
  async function loadSale(id: string): Promise<Sale | null> {
    const { data, error } = await db
      .from("store_sales")
      .select("id, pay, status, total_cents, site_id, stripe_checkout_id, stripe_url, stripe_live, lines:store_sale_lines(name, size, quantity, unit_cents)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as Sale | null;
  }

  // Stripe says paid: finish the sale, once the payment is checked against it. Returns the sale's status after.
  async function markPaid(sale: { id: string; total_cents: number; stripe_checkout_id: string | null }, s: any): Promise<string> {
    if (s.id !== sale.stripe_checkout_id || s.client_reference_id !== sale.id || s.amount_total !== sale.total_cents || s.currency !== "usd") {
      throw new Error("Stripe's payment doesn't match this sale. Check it in Stripe before doing anything else.");
    }
    const { data, error } = await admin.from("store_sales")
      .update({ status: "done", settled_by: staff.id })
      .eq("id", sale.id).eq("status", "waiting").eq("stripe_checkout_id", s.id)
      .select("id");
    if (error) throw new Error(`Stripe shows it paid, but Family Desk did not record it: ${error.message}`);
    if (data?.length) return "done";
    const now = await loadSale(sale.id);
    if (now?.status === "void") throw new Error("Stripe shows this sale paid, but it was canceled here. Check it in Stripe and refund it or ring it up again.");
    return now?.status ?? "unknown";
  }
  // Void a card sale, but only while it still has the payment page that was checked.
  async function voidCard(sale: Sale, reason: string): Promise<boolean> {
    let q = admin.from("store_sales").update({ status: "void", note: reason, settled_by: staff.id }).eq("id", sale.id).eq("status", "waiting");
    q = sale.stripe_checkout_id ? q.eq("stripe_checkout_id", sale.stripe_checkout_id) : q.is("stripe_checkout_id", null);
    const { data, error } = await q.select("id");
    if (error) throw new Error(error.message);
    return !!data?.length;
  }
  // A session made with the other mode's key (practice vs live) can't be looked up with this one.
  const sameMode = (s: Sale) => s.stripe_live === null || s.stripe_live === sk.live;

  try {
    if (body.action === "checkout") {
      let id = String(body.sale_id ?? "");
      let madeHere = false;
      if (!id) {
        const c = body.cart ?? {};
        const { data, error } = await db.rpc("store_create_sale", {
          p_site: c.site_id ?? null, p_family: c.family_id ?? null, p_pay: "card", p_card_tapped: false,
          p_note: c.note ?? null, p_lines: c.lines ?? [],
        });
        if (error) return json({ error: error.message }, 400);
        id = data.id;
        madeHere = true;
      }
      const sale = await loadSale(id);
      if (!sale) return json({ error: "Sale not found, or not yours to see" }, 404);
      if (sale.pay !== "card" || sale.status !== "waiting") {
        return json({ sale_id: id, status: sale.status === "done" ? "paid" : sale.status });
      }

      if (sale.stripe_checkout_id && sameMode(sale)) {
        const old = await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`);
        const st = stateOf(old);
        if (st === "paid") { const now = await markPaid(sale, old); return json({ sale_id: id, status: now === "done" ? "paid" : now }); }
        if (st === "open") return json({ sale_id: id, status: "waiting", url: old.url, live: old.livemode, expires_at: old.expires_at });
        if (st === "processing") return json({ sale_id: id, status: "processing", live: old.livemode });
        // Expired: make a fresh payment page below.
      } else if (sale.stripe_checkout_id && sale.stripe_live && !sk.live) {
        return json({ error: "This sale's payment page is in live mode, but the store's Stripe key is in practice mode now." }, 409);
      }

      let session: any;
      try {
        session = await stripe(key, "POST", "/v1/checkout/sessions", {
          mode: "payment",
          payment_method_types: ["card"], // cards, Apple Pay and Google Pay; nothing that takes days to clear
          line_items: sale.lines.map((l) => ({
            quantity: l.quantity,
            price_data: { currency: "usd", unit_amount: l.unit_cents, product_data: { name: l.size ? `${l.name} (${l.size})` : l.name } },
          })),
          submit_type: "pay",
          success_url: PAID_URL,
          expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
          client_reference_id: id,
          metadata: { family_desk_sale: id, site: sale.site_id },
          payment_intent_data: { description: "HERO front desk sale", metadata: { family_desk_sale: id, site: sale.site_id } },
        });
      } catch (serr) {
        // No page exists, so a sale made in this call is simply voided rather than left waiting.
        if (madeHere) await voidCard(sale, `Stripe refused the payment page: ${(serr as Error).message}`).catch(() => {});
        return json({ error: `Stripe refused the payment page: ${(serr as Error).message}` }, 502);
      }

      // Save it, unless someone else made a page for this sale a moment ago: then keep theirs and close this one.
      let q = admin.from("store_sales")
        .update({ stripe_checkout_id: session.id, stripe_url: session.url, stripe_live: session.livemode })
        .eq("id", id).eq("status", "waiting");
      q = sale.stripe_checkout_id ? q.eq("stripe_checkout_id", sale.stripe_checkout_id) : q.is("stripe_checkout_id", null);
      const { data: rows, error: uerr } = await q.select("id");
      if (uerr || !rows?.length) {
        await stripe(key, "POST", `/v1/checkout/sessions/${session.id}/expire`).catch(() => {});
        if (uerr) return json({ error: `Stripe made the payment page, but Family Desk could not save it: ${uerr.message}` }, 500);
        const now = await loadSale(id);
        return json({ sale_id: id, status: now?.status === "done" ? "paid" : now?.status ?? "waiting", url: now?.status === "waiting" ? now?.stripe_url ?? null : null, live: now?.stripe_live ?? null });
      }
      return json({ sale_id: id, status: "waiting", url: session.url, live: session.livemode, expires_at: session.expires_at });
    }

    if (body.action === "status") {
      // One sale, or every card sale still waiting from the last two days.
      let q = db.from("store_sales").select("id, total_cents, stripe_checkout_id, stripe_live")
        .eq("pay", "card").eq("status", "waiting").not("stripe_checkout_id", "is", null);
      q = body.sale_id ? q.eq("id", String(body.sale_id)) : q.gte("created_at", new Date(Date.now() - 2 * 86400000).toISOString()).limit(20);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 400);
      const sales: { id: string; status: string; url?: string | null; live?: boolean | null; error?: string }[] = [];
      for (const r of data ?? []) {
        if (r.stripe_live !== null && r.stripe_live !== sk.live) { sales.push({ id: r.id, status: "other_mode", live: r.stripe_live }); continue; }
        try {
          const s = await stripe(key, "GET", `/v1/checkout/sessions/${r.stripe_checkout_id}`);
          const st = stateOf(s);
          if (st === "paid") {
            const now = await markPaid(r, s);
            sales.push({ id: r.id, status: now === "done" ? "paid" : now, live: s.livemode });
          } else {
            sales.push({ id: r.id, status: st === "open" ? "waiting" : st, url: st === "open" ? s.url : null, live: s.livemode });
          }
        } catch (e) {
          const msg = (e as Error).message;
          sales.push({ id: r.id, status: /doesn't match|canceled here/.test(msg) ? "mismatch" : "unknown", error: msg });
        }
      }
      if (body.sale_id && !sales.length) {
        // Asked about a sale that isn't waiting on a payment page (already paid, voided, or no page yet).
        const s = await loadSale(String(body.sale_id));
        if (!s) return json({ error: "Sale not found, or not yours to see" }, 404);
        sales.push({ id: s.id, status: s.status === "done" ? "paid" : s.status, url: s.status === "waiting" ? s.stripe_url : null, live: s.stripe_live });
      }
      return json({ sales });
    }

    if (body.action === "cancel") {
      const id = String(body.sale_id ?? "");
      const reason = String(body.reason ?? "").trim() || "Canceled at the desk before paying";
      const sale = await loadSale(id);
      if (!sale) return json({ error: "Sale not found, or not yours to see" }, 404);
      if (sale.pay !== "card" || sale.status !== "waiting") return json({ error: "Only a card sale still waiting for payment is canceled here." }, 409);
      if (sale.stripe_checkout_id && sameMode(sale)) {
        // Check Stripe first: the parent may have paid a moment ago. Void only once Stripe has closed the page.
        let s = await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`);
        if (stateOf(s) === "open") {
          try { s = await stripe(key, "POST", `/v1/checkout/sessions/${sale.stripe_checkout_id}/expire`); }
          catch { s = await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`); }
        }
        const st = stateOf(s);
        if (st === "paid") {
          const now = await markPaid(sale, s);
          return json({ sale_id: id, status: now === "done" ? "paid" : now, note: "The parent had already paid, so the sale is recorded as paid." });
        }
        if (st === "processing") return json({ error: "The payment is still going through in Stripe. Check again in a minute." }, 409);
        if (st !== "expired") return json({ error: "Stripe didn't close the payment page. Try Cancel again in a moment." }, 502);
      } else if (sale.stripe_checkout_id && sale.stripe_live) {
        return json({ error: "This sale's payment page is in live mode; check it in Stripe before canceling." }, 409);
      }
      if (!(await voidCard(sale, reason))) {
        const now = await loadSale(id);
        if (now?.status === "waiting") return json({ error: "A new payment page was made for this sale a moment ago. Check it, then cancel again." }, 409);
        return json({ sale_id: id, status: now?.status === "done" ? "paid" : now?.status ?? "unknown" });
      }
      return json({ sale_id: id, status: "void" });
    }

    if (body.action === "charge") {
      // Charge the family's card on file for a cart (a uniform request being filled). The family's Stripe customer
      // lives on the main account, so this uses the main key, not the store's QR-code key. The sale is rung up
      // through the caller's own session (prices from the list, their site rights), then charged with the
      // service key; a charge that fails leaves the sale voided with the reason, never waiting.
      const mainKey = stripeKey();
      if (!mainKey) return json({ error: "Stripe key not set in Supabase secrets, so the card on file can't be charged." }, 503);
      const c = body.cart ?? {};
      const { data: fam, error: ferr } = await db.from("families").select("id, name, stripe_customer_id").eq("id", String(c.family_id ?? "")).maybeSingle();
      if (ferr) return json({ error: ferr.message }, 400);
      if (!fam) return json({ error: "Family not found, or not yours to see" }, 404);
      if (!fam.stripe_customer_id) return json({ error: `${fam.name} has no Stripe customer, so there is no card on file.` }, 409);

      // The card: the customer's default, else their first saved card.
      const cust = await stripe(mainKey, "GET", `/v1/customers/${fam.stripe_customer_id}`);
      let pm: string | null = cust.invoice_settings?.default_payment_method ?? null;
      if (!pm) { const pms = await stripe(mainKey, "GET", "/v1/payment_methods", { customer: fam.stripe_customer_id, type: "card", limit: 1 }); pm = pms.data?.[0]?.id ?? null; }
      if (!pm) return json({ error: `${fam.name} has no card saved in Stripe. Take payment another way.` }, 409);

      const { data: made, error: serr } = await db.rpc("store_create_sale", {
        p_site: c.site_id ?? null, p_family: fam.id, p_pay: "card", p_card_tapped: false, p_note: c.note ?? null, p_lines: c.lines ?? [],
      });
      if (serr) return json({ error: serr.message }, 400);
      const saleId = made.id as string, amount = made.total_cents as number;

      let intent: any;
      try {
        intent = await stripe(mainKey, "POST", "/v1/payment_intents", {
          amount, currency: "usd", customer: fam.stripe_customer_id, payment_method: pm, off_session: true, confirm: true,
          description: "HERO uniform, card on file", metadata: { family_desk_sale: saleId, site: made.site_id, family: fam.name },
        }, saleId);
      } catch (perr) {
        const why = (perr as Error).message;
        await admin.from("store_sales").update({ status: "void", note: `Card on file declined: ${why}`, settled_by: staff.id }).eq("id", saleId).eq("status", "waiting");
        return json({ error: `The card on file was declined: ${why}`, sale_id: saleId, status: "void" }, 402);
      }
      if (intent.status !== "succeeded") {
        await admin.from("store_sales").update({ status: "void", note: `Card on file: payment ${intent.status}`, settled_by: staff.id }).eq("id", saleId).eq("status", "waiting");
        return json({ error: `The card on file didn't go through (${intent.status}). Take payment another way.`, sale_id: saleId, status: "void" }, 402);
      }
      const { error: uerr } = await admin.from("store_sales").update({ status: "done", settled_by: staff.id, stripe_payment_intent_id: intent.id, stripe_live: !!intent.livemode }).eq("id", saleId).eq("status", "waiting");
      if (uerr) return json({ error: `Stripe charged ${fam.name}'s card (${intent.id}), but Family Desk did not record it: ${uerr.message}`, sale_id: saleId }, 500);
      const card = intent.payment_method_details?.card ?? intent.charges?.data?.[0]?.payment_method_details?.card ?? null;
      return json({ sale_id: saleId, status: "paid", amount, live: !!intent.livemode, last4: card?.last4 ?? null, brand: card?.brand ?? null });
    }

    return json({ error: "action must be config, checkout, status, cancel or charge" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
