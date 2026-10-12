// Store edge function (supabase/functions/store): card payments by QR code through Stripe Checkout. Runs the real
// function against an in-memory database and a pretend Stripe, with made-up sales only. The parent "pays" by the
// test flipping the fake Checkout Session to paid; no card, no money.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fakes/fakeDb";
import { FakeStripe } from "./fakes/fakeStripe";

let handler: (req: Request) => Promise<Response>;
let db: FakeDb;
let stripe: FakeStripe;
const env: Record<string, string> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  (globalThis as any).Deno = {
    serve: (h: typeof handler) => { handler = h; },
    env: { get: (k: string) => env[k] },
  };
  await import("../supabase/functions/store/index.ts");
});
afterAll(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, {
    SUPABASE_URL: "http://supabase.invalid", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test",
    STRIPE_SECRET_KEY: "sk_test_fake",
  });
  db = new FakeDb();
  (globalThis as any).__fakeDb = db;
  db.insertRow("sites", { id: "surprise", name: "Surprise" });
  db.insertRow("store_items", { id: "item-tank", name: "HERO uniform tank top", price_cents: 2500, active: true });
  db.insertRow("store_items", { id: "item-bottle", name: "Water bottle", price_cents: 1000, active: true });
  stripe = new FakeStripe();
  globalThis.fetch = stripe.fetch as typeof fetch;
});

async function call(body: unknown) {
  const res = await handler(new Request("http://localhost/store", {
    method: "POST",
    headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

const cart = { site_id: "surprise", lines: [{ item_id: "item-tank", size: "Youth M", quantity: 2 }, { item_id: "item-bottle", quantity: 1 }] };

// A card sale already rung up and waiting, with or without a payment page.
function waitingSale(fields: Record<string, unknown> = {}) {
  const sale = db.insertRow("store_sales", {
    pay: "card", status: "waiting", total_cents: 6000, site_id: "surprise", stripe_checkout_id: null, stripe_url: null, stripe_live: null,
    note: null, settled_by: null, paid_at: null, created_at: new Date().toISOString(), ...fields,
  });
  db.insertRow("store_sale_lines", { sale_id: sale.id, name: "HERO uniform tank top", size: "Youth M", quantity: 2, unit_cents: 2500 });
  db.insertRow("store_sale_lines", { sale_id: sale.id, name: "Water bottle", size: null, quantity: 1, unit_cents: 1000 });
  return sale;
}
// ...and one whose payment page Stripe already has.
function saleWithPage(live = false) {
  const sale = waitingSale();
  const s = stripe.addSession({ amount_total: 6000, client_reference_id: sale.id, livemode: live });
  Object.assign(sale, { stripe_checkout_id: s.id, stripe_url: s.url, stripe_live: live });
  return { sale, session: s };
}
const stripeCalls = (path: RegExp) => stripe.calls.filter((c) => path.test(c.path));

describe("who may use it", () => {
  it("turns away a coach and an owner without two-step sign-in", async () => {
    db.profile = { staff: { role: "coach" }, aal: "aal2" };
    expect((await call({ action: "config" })).status).toBe(403);
    db.profile = { staff: { role: "owner" }, aal: "aal1" };
    expect((await call({ action: "config" })).status).toBe(403);
  });
  it("answers an unknown action with a 400", async () => {
    expect((await call({ action: "refund" })).status).toBe(400);
  });
});

describe("config: which Stripe key the store uses", () => {
  it("borrows the sandbox key when the store has none: practice mode", async () => {
    expect((await call({ action: "config" })).body).toEqual({ card: "practice" });
  });
  it("is off with no key at all, and says so instead of taking a sale", async () => {
    delete env.STRIPE_SECRET_KEY;
    expect((await call({ action: "config" })).body).toMatchObject({ card: "off", why: expect.stringMatching(/no Stripe key/) });
    const r = await call({ action: "checkout", cart });
    expect(r.status).toBe(503);
    expect(db.tables.store_sales).toHaveLength(0);
  });
  it("needs STRIPE_STORE_LIVE_OK=yes before a live store key moves real money", async () => {
    env.STRIPE_STORE_KEY = "sk_live_fake";
    expect((await call({ action: "config" })).body).toMatchObject({ card: "off", why: expect.stringMatching(/STRIPE_STORE_LIVE_OK/) });
    expect((await call({ action: "checkout", cart })).status).toBe(503);
    env.STRIPE_STORE_LIVE_OK = "yes";
    expect((await call({ action: "config" })).body).toEqual({ card: "live" });
  });
  it("prefers the store's own key over the sandbox key", async () => {
    env.STRIPE_STORE_KEY = "rk_test_store";
    await call({ action: "checkout", cart });
    expect(stripe.calls[0]).toBeDefined();
    // The fake reads the key off the request; a restricted test key makes practice sessions.
    expect([...stripe.sessions.values()][0].livemode).toBe(false);
  });
});

describe("checkout: ringing up a cart", () => {
  it("prices the sale from the list, makes a Stripe payment page for it, and saves the page on the sale", async () => {
    const r = await call({ action: "checkout", cart });

    expect(r.status).toBe(200);
    const sale = db.tables.store_sales[0];
    expect(sale).toMatchObject({ pay: "card", status: "waiting", total_cents: 6000, site_id: "surprise" });
    expect(db.rpcCalls.find((c) => c.name === "store_create_sale")!.args).toMatchObject({ p_site: "surprise", p_pay: "card", p_card_tapped: false });

    const [session] = stripe.sessions.values();
    expect(session.amount_total).toBe(6000);
    expect(session.params).toMatchObject({
      mode: "payment",
      "payment_method_types[0]": "card",
      submit_type: "pay",
      success_url: "https://app.hero.training/family-desk/paid.html",
      client_reference_id: sale.id,
      "metadata[family_desk_sale]": sale.id,
      "metadata[site]": "surprise",
      "line_items[0][quantity]": "2",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][product_data][name]": "HERO uniform tank top (Youth M)",
      "line_items[1][quantity]": "1",
      "line_items[1][price_data][unit_amount]": "1000",
      "line_items[1][price_data][product_data][name]": "Water bottle",
    });
    // The page expires in about an hour.
    expect(Number(session.params.expires_at) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);

    expect(sale).toMatchObject({ stripe_checkout_id: session.id, stripe_url: session.url, stripe_live: false });
    expect(r.body).toEqual({ sale_id: sale.id, status: "waiting", url: session.url, live: false, expires_at: session.expires_at });
    // The page was saved with the service key, not the staff session.
    expect(db.calls.find((c) => c.table === "store_sales" && c.op === "update")!.trusted).toBe(true);
  });

  it("passes a refused cart straight back and makes no page", async () => {
    const r = await call({ action: "checkout", cart: { site_id: "surprise", lines: [] } });
    expect(r).toMatchObject({ status: 400, body: { error: "Add at least one item." } });
    expect(stripe.calls).toHaveLength(0);
  });

  it("voids a sale it just made when Stripe refuses the page, so it doesn't sit waiting", async () => {
    stripe.failNext("POST", /^\/v1\/checkout\/sessions$/, "Invalid API key");
    const r = await call({ action: "checkout", cart });
    expect(r).toMatchObject({ status: 502, body: { error: "Stripe refused the payment page: Invalid API key" } });
    expect(db.tables.store_sales[0]).toMatchObject({ status: "void", note: "Stripe refused the payment page: Invalid API key" });
  });

  it("leaves an older sale waiting when Stripe refuses a new page for it", async () => {
    const sale = waitingSale();
    stripe.failNext("POST", /^\/v1\/checkout\/sessions$/, "Invalid API key");
    expect((await call({ action: "checkout", sale_id: sale.id })).status).toBe(502);
    expect(sale.status).toBe("waiting");
  });

  it("closes its page when Family Desk could not save it", async () => {
    db.failNext("store_sales", "update", "permission denied");
    const r = await call({ action: "checkout", cart });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Stripe made the payment page, but Family Desk could not save it/);
    expect([...stripe.sessions.values()][0].status).toBe("expired");
  });

  it("keeps the page someone else made a moment ago, and closes its own", async () => {
    const sale = waitingSale();
    let theirs: string;
    stripe.afterSessionCreated = () => {
      // Another desk made a page for the same sale while Stripe was working.
      const other = stripe.addSession({ amount_total: 6000, client_reference_id: sale.id });
      theirs = other.id; sale.stripe_checkout_id = other.id; sale.stripe_url = other.url; sale.stripe_live = false;
      stripe.afterSessionCreated = null;
    };
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.body).toMatchObject({ sale_id: sale.id, status: "waiting", url: stripe.sessions.get(theirs!)!.url });
    expect(sale.stripe_checkout_id).toBe(theirs!);
    const mine = [...stripe.sessions.values()].find((s) => s.id !== theirs);
    expect(mine!.status).toBe("expired");
  });
});

describe("checkout: coming back to a sale", () => {
  it("hands back the page that is still open rather than making another", async () => {
    const { sale, session } = saleWithPage();
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.body).toEqual({ sale_id: sale.id, status: "waiting", url: session.url, live: false, expires_at: session.expires_at });
    expect(stripeCalls(/^\/v1\/checkout\/sessions$/)).toHaveLength(0);
  });

  it("records the sale as paid once Stripe says so, with who confirmed it", async () => {
    const { sale, session } = saleWithPage();
    stripe.pay(session.id);
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.body).toEqual({ sale_id: sale.id, status: "paid" });
    expect(sale).toMatchObject({ status: "done", settled_by: "staff-owner" });
    expect(sale.paid_at).not.toBeNull();
  });

  it("says processing while the payment is still going through", async () => {
    const { sale, session } = saleWithPage();
    stripe.processing(session.id);
    expect((await call({ action: "checkout", sale_id: sale.id })).body).toEqual({ sale_id: sale.id, status: "processing", live: false });
    expect(sale.status).toBe("waiting");
  });

  it("makes a fresh page when the old one expired", async () => {
    const { sale, session } = saleWithPage();
    stripe.expire(session.id);
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.body.status).toBe("waiting");
    expect(r.body.url).not.toBe(session.url);
    expect(sale.stripe_checkout_id).not.toBe(session.id);
    expect(stripe.sessions.get(sale.stripe_checkout_id)!.status).toBe("open");
  });

  it("won't record a payment that doesn't match the sale", async () => {
    const { sale, session } = saleWithPage();
    session.amount_total = 5999;
    stripe.pay(session.id);
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Stripe's payment doesn't match this sale/);
    expect(sale.status).toBe("waiting");
  });

  it("reports a sale that is already paid or voided without touching Stripe", async () => {
    const done = waitingSale({ status: "done" });
    const voided = waitingSale({ status: "void" });
    expect((await call({ action: "checkout", sale_id: done.id })).body).toEqual({ sale_id: done.id, status: "paid" });
    expect((await call({ action: "checkout", sale_id: voided.id })).body).toEqual({ sale_id: voided.id, status: "void" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("answers 404 for a sale it can't see", async () => {
    expect((await call({ action: "checkout", sale_id: "nope" })).status).toBe(404);
  });

  it("refuses to touch a live-mode page with a practice key", async () => {
    const { sale } = saleWithPage(true);
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/live mode/);
    expect(stripe.calls).toHaveLength(0);
  });
});

describe("status: the morning after", () => {
  it("checks every card sale still waiting on a page from the last two days, and records the paid ones", async () => {
    const a = saleWithPage(); stripe.pay(a.session.id);
    const b = saleWithPage();
    const c = saleWithPage(); stripe.expire(c.session.id);
    waitingSale(); // no page yet: nothing to ask Stripe about
    const old = saleWithPage(); old.sale.created_at = new Date(Date.now() - 3 * 86400000).toISOString();

    const r = await call({ action: "status" });

    const byId = Object.fromEntries(r.body.sales.map((s: any) => [s.id, s]));
    expect(byId[a.sale.id]).toEqual({ id: a.sale.id, status: "paid", live: false });
    expect(byId[b.sale.id]).toEqual({ id: b.sale.id, status: "waiting", url: b.session.url, live: false });
    expect(byId[c.sale.id]).toEqual({ id: c.sale.id, status: "expired", url: null, live: false });
    expect(Object.keys(byId)).toHaveLength(3);
    expect(a.sale.status).toBe("done");
    expect(b.sale.status).toBe("waiting");
  });

  it("flags a page made in the other mode instead of asking Stripe", async () => {
    const { sale } = saleWithPage(true);
    const r = await call({ action: "status" });
    expect(r.body.sales).toEqual([{ id: sale.id, status: "other_mode", live: true }]);
    expect(stripe.calls).toHaveLength(0);
  });

  it("flags a payment that doesn't match its sale, and leaves the sale alone", async () => {
    const { sale, session } = saleWithPage();
    session.client_reference_id = "some-other-sale";
    stripe.pay(session.id);
    const r = await call({ action: "status", sale_id: sale.id });
    expect(r.body.sales[0]).toMatchObject({ id: sale.id, status: "mismatch" });
    expect(sale.status).toBe("waiting");
  });

  it("answers for one sale that isn't waiting on a page", async () => {
    const done = waitingSale({ status: "done" });
    expect((await call({ action: "status", sale_id: done.id })).body.sales).toEqual([{ id: done.id, status: "paid", url: null, live: null }]);
    expect((await call({ action: "status", sale_id: "nope" })).status).toBe(404);
  });

  it("says unknown when Stripe can't be reached for a sale, and keeps going", async () => {
    const a = saleWithPage();
    const b = saleWithPage();
    stripe.failNext("GET", new RegExp(`/${a.session.id}$`), "rate limited");
    const r = await call({ action: "status" });
    const byId = Object.fromEntries(r.body.sales.map((s: any) => [s.id, s]));
    expect(byId[a.sale.id]).toMatchObject({ status: "unknown", error: "rate limited" });
    expect(byId[b.sale.id]).toMatchObject({ status: "waiting" });
  });
});

describe("cancel", () => {
  it("closes the page in Stripe first, then voids the sale with the reason", async () => {
    const { sale, session } = saleWithPage();
    const r = await call({ action: "cancel", sale_id: sale.id, reason: "Parent changed their mind" });
    expect(r.body).toEqual({ sale_id: sale.id, status: "void" });
    expect(session.status).toBe("expired");
    expect(sale).toMatchObject({ status: "void", note: "Parent changed their mind", settled_by: "staff-owner" });
  });

  it("uses a stock reason when none is given, and voids a sale with no page at all", async () => {
    const sale = waitingSale();
    expect((await call({ action: "cancel", sale_id: sale.id })).body.status).toBe("void");
    expect(sale.note).toBe("Canceled at the desk before paying");
    expect(stripe.calls).toHaveLength(0);
  });

  it("records the sale as paid instead when the parent paid just before", async () => {
    const { sale, session } = saleWithPage();
    stripe.pay(session.id);
    const r = await call({ action: "cancel", sale_id: sale.id });
    expect(r.body).toMatchObject({ sale_id: sale.id, status: "paid", note: expect.stringMatching(/already paid/) });
    expect(sale.status).toBe("done");
  });

  it("waits when the payment is still going through", async () => {
    const { sale, session } = saleWithPage();
    stripe.processing(session.id);
    const r = await call({ action: "cancel", sale_id: sale.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/still going through/);
    expect(sale.status).toBe("waiting");
  });

  it("refuses anything but a card sale still waiting", async () => {
    const done = waitingSale({ status: "done" });
    const cash = waitingSale({ pay: "cash", status: "done" });
    for (const s of [done, cash]) {
      const r = await call({ action: "cancel", sale_id: s.id });
      expect(r.status).toBe(409);
      expect(s.status).toBe("done");
    }
  });

  it("won't cancel a live-mode sale with a practice key", async () => {
    const { sale } = saleWithPage(true);
    const r = await call({ action: "cancel", sale_id: sale.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/live mode/);
    expect(sale.status).toBe("waiting");
  });

  it("backs off when Stripe won't close the page", async () => {
    const { sale, session } = saleWithPage();
    stripe.failNext("POST", /\/expire$/, "Stripe is busy");
    const r = await call({ action: "cancel", sale_id: sale.id });
    expect(r.status).toBe(502);
    expect(session.status).toBe("open");
    expect(sale.status).toBe("waiting");
  });
});

describe("a sale voided here that Stripe then shows paid", () => {
  it("is reported as void without asking Stripe", async () => {
    const { sale, session } = saleWithPage();
    sale.status = "void";
    stripe.pay(session.id);
    expect((await call({ action: "checkout", sale_id: sale.id })).body).toEqual({ sale_id: sale.id, status: "void" });
    expect(stripe.calls).toHaveLength(0);
  });

  it("is never quietly recorded as paid when it was voided a moment before: the desk is told to check Stripe", async () => {
    const { sale, session } = saleWithPage();
    stripe.pay(session.id);
    // Stage the race: the sale turns void after the function has read it but before it records the payment.
    const origFetch = stripe.fetch;
    globalThis.fetch = (async (input: any, init?: any) => { const res = await origFetch(input, init); sale.status = "void"; return res; }) as typeof fetch;
    const r = await call({ action: "checkout", sale_id: sale.id });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/canceled here/);
    expect(sale.status).toBe("void");
  });
});
