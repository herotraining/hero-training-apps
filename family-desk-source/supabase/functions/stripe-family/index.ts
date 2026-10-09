// Read a family's Stripe picture: subscriptions, invoices, recent payments.
// The caller must be signed-in staff who can see the family (row-level security decides).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, json, userClient, stripe, stripeKey } from "./_shared.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let familyId = "";
  try {
    const body = await req.json();
    familyId = String(body?.family_id ?? "");
  } catch {
    return json({ error: "Send JSON with family_id" }, 400);
  }
  if (!familyId) return json({ error: "family_id is required" }, 400);

  const db = userClient(req);
  const { data: ok, error: perr } = await db.rpc("can_see_money", { p_family: familyId });
  if (perr) return json({ error: perr.message }, 400);
  if (!ok) return json({ error: "Owners and admins only" }, 403);
  const { data: fam, error } = await db
    .from("families")
    .select("id, name, stripe_customer_id")
    .eq("id", familyId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!fam) return json({ error: "Family not found, or not yours to see" }, 404);
  if (!fam.stripe_customer_id) return json({ family: fam.name, stripe: null, note: "No Stripe customer yet" });

  const key = stripeKey();
  if (!key) return json({ family: fam.name, stripe: null, note: "Stripe key not set in Supabase secrets" }, 503);

  try {
    const cust = fam.stripe_customer_id;
    const [subs, invs, charges, pms] = await Promise.all([
      stripe(key, "GET", "/v1/subscriptions", { customer: cust, status: "all", limit: 10, expand: ["data.items.data.price.product"] }),
      stripe(key, "GET", "/v1/invoices", { customer: cust, limit: 24 }),
      stripe(key, "GET", "/v1/charges", { customer: cust, limit: 10 }),
      stripe(key, "GET", "/v1/payment_methods", { customer: cust, limit: 5 }),
    ]);

    const subscriptions = subs.data.map((s: any) => ({
      id: s.id,
      status: s.status,
      description: s.description,
      items: s.items.data.map((it: any) => ({
        product: it.price?.product?.name ?? it.price?.product,
        amount: it.price?.unit_amount,
        quantity: it.quantity,
        interval: it.price?.recurring?.interval,
      })),
      next_charge: s.status === "active" || s.status === "trialing" ? (s.items.data[0]?.current_period_end ?? null) : null,
      canceled_at: s.canceled_at,
      metadata: s.metadata,
    }));

    const invoices = invs.data.map((i: any) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      total: i.total,
      amount_paid: i.amount_paid,
      due_date: i.due_date,
      created: i.created,
      collection_method: i.collection_method,
      esa: i.metadata?.esa === "true",
      class_month: i.metadata?.class_month ?? null,
      student: i.metadata?.student ?? null,
      hosted_invoice_url: i.hosted_invoice_url,
      invoice_pdf: i.invoice_pdf,
      paid_out_of_band: i.status === "paid" && i.amount_paid === 0,
    }));

    const payments = charges.data.map((c: any) => ({
      id: c.id,
      amount: c.amount,
      status: c.status,
      created: c.created,
      description: c.description,
      refunded: c.amount_refunded,
      method: c.payment_method_details?.type ?? null,
      last4: c.payment_method_details?.card?.last4 ?? c.payment_method_details?.us_bank_account?.last4 ?? null,
    }));

    const payment_methods = pms.data.map((p: any) => ({
      id: p.id,
      type: p.type,
      last4: p.card?.last4 ?? p.us_bank_account?.last4 ?? null,
      brand: p.card?.brand ?? p.us_bank_account?.bank_name ?? null,
    }));

    return json({ family: fam.name, customer: cust, subscriptions, invoices, payments, payment_methods });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
