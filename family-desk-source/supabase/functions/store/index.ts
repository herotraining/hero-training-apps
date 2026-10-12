// Store: card payments for front-desk sales through Stripe Checkout. The parent scans a QR code and pays on
// Stripe's own page, so Family Desk never sees a card. Owners and admins only; row-level security decides which
// sales the caller can touch, and store_create_sale prices every sale from the price list.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, json, userClient, stripe } from "./_shared.ts";

const PAID_URL = "https://app.hero.training/family-desk/paid.html";

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

// What a Checkout Session means for the sale: paid, still open, expired, or paid but not settled yet.
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

  async function loadSale(id: string): Promise<Sale | null> {
    const { data, error } = await db
      .from("store_sales")
      .select("id, pay, status, total_cents, site_id, stripe_checkout_id, stripe_url, stripe_live, lines:store_sale_lines(name, size, quantity, unit_cents)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as Sale | null;
  }
  // Stripe says paid: finish the sale. Only a sale still waiting moves, so repeating this is harmless.
  async function markPaid(id: string) {
    const { error } = await db.from("store_sales").update({ status: "done" }).eq("id", id).eq("status", "waiting");
    if (error) throw new Error(`Stripe shows it paid, but Family Desk did not record it: ${error.message}`);
  }
  // A session made with the other mode's key (practice vs live) can't be looked up with this one.
  const sameMode = (s: Sale) => s.stripe_live === null || s.stripe_live === sk.live;

  try {
    if (body.action === "checkout") {
      let id = String(body.sale_id ?? "");
      if (!id) {
        const c = body.cart ?? {};
        const { data, error } = await db.rpc("store_create_sale", {
          p_site: c.site_id ?? null, p_family: c.family_id ?? null, p_pay: "card", p_card_tapped: false,
          p_note: c.note ?? null, p_lines: c.lines ?? [],
        });
        if (error) return json({ error: error.message }, 400);
        id = data.id;
      }
      const sale = await loadSale(id);
      if (!sale) return json({ error: "Sale not found, or not yours to see" }, 404);
      if (sale.pay !== "card" || sale.status !== "waiting") {
        return json({ sale_id: id, status: sale.status === "done" ? "paid" : sale.status });
      }

      if (sale.stripe_checkout_id && sameMode(sale)) {
        const old = await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`);
        const st = stateOf(old);
        if (st === "paid") { await markPaid(id); return json({ sale_id: id, status: "paid" }); }
        if (st === "open") return json({ sale_id: id, status: "waiting", url: old.url, live: old.livemode, expires_at: old.expires_at });
        if (st === "processing") return json({ sale_id: id, status: "processing", live: old.livemode });
        // Expired: make a fresh payment page below.
      } else if (sale.stripe_checkout_id && sale.stripe_live && !sk.live) {
        return json({ error: "This sale's payment page is in live mode, but the store's Stripe key is in practice mode now." }, 409);
      }

      const session = await stripe(key, "POST", "/v1/checkout/sessions", {
        mode: "payment",
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

      // Save it, unless someone else made a page for this sale a moment ago: then keep theirs and close this one.
      let q = db.from("store_sales")
        .update({ stripe_checkout_id: session.id, stripe_url: session.url, stripe_live: session.livemode })
        .eq("id", id).eq("status", "waiting");
      q = sale.stripe_checkout_id ? q.eq("stripe_checkout_id", sale.stripe_checkout_id) : q.is("stripe_checkout_id", null);
      const { data: rows, error: uerr } = await q.select("id");
      if (uerr || !rows?.length) {
        await stripe(key, "POST", `/v1/checkout/sessions/${session.id}/expire`).catch(() => {});
        if (uerr) return json({ error: `Stripe made the payment page, but Family Desk could not save it: ${uerr.message}` }, 500);
        const now = await loadSale(id);
        return json({ sale_id: id, status: now?.status === "done" ? "paid" : now?.status ?? "waiting", url: now?.stripe_url ?? null, live: now?.stripe_live ?? null });
      }
      return json({ sale_id: id, status: "waiting", url: session.url, live: session.livemode, expires_at: session.expires_at });
    }

    if (body.action === "status") {
      // One sale, or every card sale still waiting from the last two days.
      let q = db.from("store_sales").select("id, stripe_checkout_id, stripe_live")
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
          if (st === "paid") await markPaid(r.id);
          sales.push({ id: r.id, status: st === "open" ? "waiting" : st, url: st === "open" ? s.url : null, live: s.livemode });
        } catch (e) {
          sales.push({ id: r.id, status: "unknown", error: (e as Error).message });
        }
      }
      if (body.sale_id && !sales.length) {
        // Asked about a sale that isn't waiting on a payment page (already paid, voided, or no page yet).
        const s = await loadSale(String(body.sale_id));
        if (!s) return json({ error: "Sale not found, or not yours to see" }, 404);
        sales.push({ id: s.id, status: s.status === "done" ? "paid" : s.status, url: s.stripe_url, live: s.stripe_live });
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
        // Check Stripe first: the parent may have paid a moment ago.
        const s = await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`);
        let st = stateOf(s);
        if (st === "open") {
          try { await stripe(key, "POST", `/v1/checkout/sessions/${sale.stripe_checkout_id}/expire`); }
          catch { st = stateOf(await stripe(key, "GET", `/v1/checkout/sessions/${sale.stripe_checkout_id}`)); }
        }
        if (st === "paid") { await markPaid(id); return json({ sale_id: id, status: "paid", note: "The parent had already paid, so the sale is recorded as paid." }); }
        if (st === "processing") return json({ error: "The payment is still going through in Stripe. Check again in a minute." }, 409);
      } else if (sale.stripe_checkout_id && sale.stripe_live) {
        return json({ error: "This sale's payment page is in live mode; check it in Stripe before canceling." }, 409);
      }
      const { error } = await db.from("store_sales").update({ status: "void", note: reason }).eq("id", id).eq("status", "waiting");
      if (error) return json({ error: error.message }, 400);
      return json({ sale_id: id, status: "void" });
    }

    return json({ error: "action must be config, checkout, status or cancel" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
