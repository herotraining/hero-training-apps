// Uniform requests: the public uniform-request function a parent uses from the Family Hub (what an email and a
// child's first name unlock, and what a request must contain), and the store function's charge action that bills
// a filled request to the family's card on file. Made-up families, an in-memory database and a pretend Stripe.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fakes/fakeDb";
import { FakeStripe } from "./fakes/fakeStripe";

let requestFn: (req: Request) => Promise<Response>;
let storeFn: (req: Request) => Promise<Response>;
let db: FakeDb;
let stripe: FakeStripe;
const env: Record<string, string> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const handlers: ((req: Request) => Promise<Response>)[] = [];
  (globalThis as any).Deno = { serve: (h: typeof requestFn) => { handlers.push(h); }, env: { get: (k: string) => env[k] } };
  await import("../supabase/functions/uniform-request/index.ts");
  await import("../supabase/functions/store/index.ts");
  [requestFn, storeFn] = handlers;
});
afterAll(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { SUPABASE_URL: "http://supabase.invalid", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", STRIPE_SECRET_KEY: "sk_test_fake" });
  db = new FakeDb();
  (globalThis as any).__fakeDb = db;
  stripe = new FakeStripe();
  globalThis.fetch = stripe.fetch as typeof fetch;
  db.insertRow("sites", { id: "surprise", name: "Surprise" });
});

async function call(fn: typeof requestFn, body: unknown) {
  const res = await fn(new Request("http://localhost/fn", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const ask = (body: unknown) => call(requestFn, body);

// The Testers: Ava (ESA class) and Ben (card class), parent email on file. The Samples: Cal, no class any more.
function seed() {
  const testers = db.insertRow("families", { name: "Tester", status: "active", site_id: "surprise", stripe_customer_id: "cus_test_tester" });
  db.insertRow("guardians", { family_id: testers.id, name: "Pat Tester", email: "Pat.Tester@Example.test" });
  const ava = db.insertRow("children", { family_id: testers.id, first_name: "Ava", last_name: "Tester", uniform_size: "YM", esa: true, active: true });
  const ben = db.insertRow("children", { family_id: testers.id, first_name: "Ben", last_name: "Tester", uniform_size: null, esa: false, active: true });
  db.insertRow("enrollments", { child_id: ava.id, program_id: "ninja", status: "active", pay: "esa" });
  db.insertRow("enrollments", { child_id: ben.id, program_id: "ninja", status: "active", pay: "card" });
  const samples = db.insertRow("families", { name: "Sample", status: "active", site_id: "surprise", stripe_customer_id: null });
  db.insertRow("guardians", { family_id: samples.id, name: "Sam Sample", email: "sam@example.test" });
  const cal = db.insertRow("children", { family_id: samples.id, first_name: "Cal", last_name: "Sample", uniform_size: null, esa: false, active: true });
  db.insertRow("enrollments", { child_id: cal.id, program_id: "ninja", status: "dropped", pay: "card" });
  const tank = db.insertRow("store_items", { name: "HERO uniform tank top", kind: "uniform", price_cents: 2500, sizes: ["Youth S", "Youth M"], colors: ["Navy", "Red"], esa_ok: true, active: true, image_url: null, description: null, sort: 10 });
  const hoodie = db.insertRow("store_items", { name: "HERO uniform hoodie", kind: "uniform", price_cents: 2500, sizes: ["Youth M"], colors: [], esa_ok: true, active: true, image_url: null, description: null, sort: 20 });
  db.insertRow("store_items", { name: "Water bottle", kind: "gear", price_cents: 1000, sizes: [], colors: [], esa_ok: false, active: true, image_url: null, description: null, sort: 30 });
  db.insertRow("store_items", { name: "Old tank", kind: "uniform", price_cents: 2000, sizes: [], colors: [], esa_ok: true, active: false, image_url: null, description: null, sort: 40 });
  return { testers, ava, ben, samples, cal, tank, hoodie };
}

describe("lookup: what an email and a first name unlock", () => {
  it("finds the child, how the family pays, and the uniforms for sale", async () => {
    const s = seed();
    const r = await ask({ action: "lookup", email: "pat.tester@example.test", child_first_name: "ava" });
    expect(r.status).toBe(200);
    expect(r.body.children).toEqual([{ id: s.ava.id, first_name: "Ava", last_name: "Tester", uniform_size: "YM", family_id: s.testers.id, family_name: "Tester", pay: "esa", esa_ok: true }]);
    // Uniforms only, for sale only; no gear, no retired items.
    expect(r.body.items.map((i: any) => i.name)).toEqual(["HERO uniform tank top", "HERO uniform hoodie"]);
    expect(r.body.items[0]).toMatchObject({ price_cents: 2500, sizes: ["Youth S", "Youth M"], colors: ["Navy", "Red"] });
  });

  it("says a card-paying child is billed to the card on file", async () => {
    seed();
    const r = await ask({ action: "lookup", email: "PAT.TESTER@example.test", child_first_name: "Ben" });
    expect(r.body.children[0]).toMatchObject({ first_name: "Ben", pay: "card", esa_ok: false });
  });

  it("says a Jackrabbit family is billed there", async () => {
    const s = seed();
    db.insertRow("enrollments", { child_id: s.cal.id, program_id: "ninja", status: "active", pay: "card" });
    const r = await ask({ action: "lookup", email: "sam@example.test", child_first_name: "Cal" });
    expect(r.body.children[0]).toMatchObject({ first_name: "Cal", pay: "jackrabbit" });
  });

  it("unlocks nothing for the wrong email, the wrong name, a child with no active class, or an inactive family", async () => {
    const s = seed();
    expect((await ask({ action: "lookup", email: "stranger@example.test", child_first_name: "Ava" })).status).toBe(404);
    expect((await ask({ action: "lookup", email: "pat.tester@example.test", child_first_name: "Zed" })).status).toBe(404);
    expect((await ask({ action: "lookup", email: "sam@example.test", child_first_name: "Cal" })).status).toBe(404);
    s.testers.status = "inactive";
    expect((await ask({ action: "lookup", email: "pat.tester@example.test", child_first_name: "Ava" })).status).toBe(404);
  });

  it("refuses a bad email or an empty name without looking anything up", async () => {
    seed();
    expect((await ask({ action: "lookup", email: "not-an-email", child_first_name: "Ava" })).status).toBe(400);
    expect((await ask({ action: "lookup", email: "pat.tester@example.test", child_first_name: "  " })).status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});

describe("submit: sending a request", () => {
  it("records one row per line, for the child the email unlocks", async () => {
    const s = seed();
    const r = await ask({ action: "submit", email: "pat.tester@example.test", child_first_name: "Ava", child_id: s.ava.id, note: "  Before the meet ", lines: [
      { item_id: s.tank.id, size: "Youth M", color: "Red", quantity: 2 }, { item_id: s.hoodie.id, size: "Youth M", color: "Purple", quantity: 1 },
    ] });
    expect(r).toMatchObject({ status: 200, body: { ok: true, child: "Ava", pay: "esa", lines: 2 } });
    expect(db.tables.uniform_requests).toHaveLength(2);
    expect(db.tables.uniform_requests[0]).toMatchObject({ family_id: s.testers.id, child_id: s.ava.id, item_id: s.tank.id, item_name: "HERO uniform tank top", size: "Youth M", color: "Red", quantity: 2, note: "Before the meet", requested_by_email: "pat.tester@example.test", status: "new" });
    // The hoodie comes in one color: a color sent for it is dropped, not stored.
    expect(db.tables.uniform_requests[1]).toMatchObject({ item_name: "HERO uniform hoodie", size: "Youth M", color: null, quantity: 1 });
  });

  it("needs a size and a color where the uniform has them, and a sane quantity", async () => {
    const s = seed();
    const base = { action: "submit", email: "pat.tester@example.test", child_first_name: "Ava", child_id: s.ava.id };
    expect((await ask({ ...base, lines: [{ item_id: s.tank.id, color: "Red" }] })).body.error).toMatch(/Pick a size/);
    expect((await ask({ ...base, lines: [{ item_id: s.tank.id, size: "Youth M" }] })).body.error).toMatch(/Pick a color/);
    expect((await ask({ ...base, lines: [{ item_id: s.tank.id, size: "Adult 5XL", color: "Red" }] })).body.error).toMatch(/Pick a size/);
    expect((await ask({ ...base, lines: [{ item_id: s.tank.id, size: "Youth M", color: "Red", quantity: 0 }] })).body.error).toMatch(/Quantity/);
    expect((await ask({ ...base, lines: [{ item_id: s.tank.id, size: "Youth M", color: "Red", quantity: 11 }] })).body.error).toMatch(/Quantity/);
    expect((await ask({ ...base, lines: [] })).status).toBe(400);
    expect(db.tables.uniform_requests).toHaveLength(0);
  });

  it("refuses gear, retired items, and a child the email doesn't unlock", async () => {
    const s = seed();
    const bottle = db.tables.store_items.find((i) => i.name === "Water bottle")!;
    const old = db.tables.store_items.find((i) => i.name === "Old tank")!;
    const base = { action: "submit", email: "pat.tester@example.test", child_first_name: "Ava", child_id: s.ava.id };
    expect((await ask({ ...base, lines: [{ item_id: bottle.id }] })).status).toBe(400);
    expect((await ask({ ...base, lines: [{ item_id: old.id }] })).status).toBe(400);
    // Pat's email unlocks Ava, not Cal.
    expect((await ask({ ...base, child_id: s.cal.id, lines: [{ item_id: s.hoodie.id, size: "Youth M" }] })).status).toBe(404);
    expect(db.tables.uniform_requests).toHaveLength(0);
  });

  it("stops a runaway: too many open requests for one child", async () => {
    const s = seed();
    for (let i = 0; i < 12; i++) db.insertRow("uniform_requests", { child_id: s.ava.id, status: "new" });
    const r = await ask({ action: "submit", email: "pat.tester@example.test", child_first_name: "Ava", child_id: s.ava.id, lines: [{ item_id: s.hoodie.id, size: "Youth M" }] });
    expect(r.status).toBe(429);
  });
});

describe("charge: billing a filled request to the card on file", () => {
  const charge = (body: unknown) => call(storeFn, { action: "charge", ...(body as object) });
  const cart = (s: ReturnType<typeof seed>) => ({ site_id: "surprise", family_id: s.testers.id, note: "Uniform request from the Family Hub", lines: [{ item_id: s.tank.id, size: "Youth M", color: "Red", quantity: 2, child_id: s.ben.id, unit_cents: 2500 }] });

  it("rings up the sale from the price list and charges the customer's default card, once", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", [{ last4: "4242" }, { last4: "1111", brand: "mastercard" }]);
    const r = await charge({ cart: cart(s) });
    expect(r.status).toBe(200);
    const sale = db.tables.store_sales[0];
    expect(r.body).toEqual({ sale_id: sale.id, status: "paid", amount: 5000, live: false, last4: "4242", brand: "visa" });
    expect(sale).toMatchObject({ pay: "card", status: "done", total_cents: 5000, settled_by: "staff-owner", stripe_live: false });
    const [pi] = stripe.intents.values();
    expect(pi).toMatchObject({ amount: 5000, currency: "usd", customer: "cus_test_tester", payment_method: "pm_test_cus_test_tester_1", idempotency_key: sale.id });
    expect(pi.params).toMatchObject({ off_session: "true", confirm: "true", "metadata[family_desk_sale]": sale.id });
    expect(sale.stripe_payment_intent_id).toBe(pi.id);
    // The sale was settled with the service key, through the trusted client.
    expect(db.calls.filter((c) => c.table === "store_sales" && c.op === "update").every((c) => c.trusted)).toBe(true);
  });

  it("falls back to the first saved card when there is no default", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", [{ last4: "9999" }], false);
    const r = await charge({ cart: cart(s) });
    expect(r.body).toMatchObject({ status: "paid", last4: "9999" });
  });

  it("voids the sale with the reason when the card is declined, and charges nothing", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", [{ last4: "0002" }]);
    stripe.nextCharge = { declined: "Your card was declined." };
    const r = await charge({ cart: cart(s) });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/declined/);
    expect(db.tables.store_sales[0]).toMatchObject({ status: "void", note: "Card on file declined: Your card was declined." });
    expect(stripe.intents.size).toBe(0);
  });

  it("voids the sale when the payment needs the parent (authentication required)", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", [{ last4: "3155" }]);
    stripe.nextCharge = { status: "requires_action" };
    const r = await charge({ cart: cart(s) });
    expect(r.status).toBe(402);
    expect(db.tables.store_sales[0].status).toBe("void");
  });

  it("refuses before ringing anything up when there is no card, no customer, or no Stripe key", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", []);
    expect((await charge({ cart: cart(s) })).status).toBe(409);
    s.testers.stripe_customer_id = null;
    expect((await charge({ cart: cart(s) })).status).toBe(409);
    s.testers.stripe_customer_id = "cus_test_tester";
    delete env.STRIPE_SECRET_KEY;
    expect((await charge({ cart: cart(s) })).status).toBe(503);
    expect(db.tables.store_sales).toHaveLength(0);
  });

  it("uses the main Stripe key for the family's customer, not the store's QR-code key", async () => {
    const s = seed();
    env.STRIPE_STORE_KEY = "sk_live_store";
    env.STRIPE_STORE_LIVE_OK = "yes";
    stripe.addCustomer("cus_test_tester", [{ last4: "4242" }]);
    const r = await charge({ cart: cart(s) });
    expect(r.status).toBe(200);
    // The practice (sk_test) main key made a practice charge even though the store's own key is live.
    expect(r.body.live).toBe(false);
  });

  it("passes a refused cart straight back", async () => {
    const s = seed();
    stripe.addCustomer("cus_test_tester", [{ last4: "4242" }]);
    const r = await charge({ cart: { ...cart(s), lines: [] } });
    expect(r).toMatchObject({ status: 400, body: { error: "Add at least one item." } });
    expect(stripe.intents.size).toBe(0);
  });
});
