// ESA invoices edge function (supabase/functions/esa-invoices): creating a class month's invoices and marking one
// paid. Runs the real function against an in-memory database and a pretend Stripe, with made-up families only.
//
// Tests written with it.fails describe what the code should do but currently doesn't: each one is a bug the tests
// found. They pass while the bug is there; once it is fixed, switch them to plain it().
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
  await import("../supabase/functions/esa-invoices/index.ts");
});
afterAll(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { SUPABASE_URL: "http://supabase.invalid", SUPABASE_ANON_KEY: "anon-test", STRIPE_SECRET_KEY: "sk_test_fake" });
  db = new FakeDb();
  (globalThis as any).__fakeDb = db;
  stripe = new FakeStripe();
  globalThis.fetch = stripe.fetch as typeof fetch;
});

async function call(body: unknown) {
  const res = await handler(new Request("http://localhost/esa-invoices", {
    method: "POST",
    headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

// Made-up data: the Testers (two kids on ESA), the Samples (one kid, no Stripe customer yet).
function seed() {
  const testers = db.insertRow("families", { name: "Tester", stripe_customer_id: "cus_test_tester", pay_method: "esa" });
  const samples = db.insertRow("families", { name: "Sample", stripe_customer_id: null, pay_method: "esa" });
  const ava = db.insertRow("children", { first_name: "Ava", last_name: "Tester", family_id: testers.id });
  const ben = db.insertRow("children", { first_name: "Ben", last_name: "Tester", family_id: testers.id });
  const cal = db.insertRow("children", { first_name: "Cal", last_name: "Sample", family_id: samples.id });
  const ninja = db.insertRow("programs", { id: "ninja", name: "Ninja", monthly_price_cents: 18000, stripe_product_id: null, site_id: "surprise" });
  const parkour = db.insertRow("programs", { id: "parkour", name: "Parkour", monthly_price_cents: 15000, stripe_product_id: null, site_id: "surprise" });
  const enroll = (child: any, program: any, extra: object = {}) =>
    db.insertRow("enrollments", { child_id: child.id, program_id: program.id, pay: "esa", status: "active", ...extra });
  return { testers, samples, ava, ben, cal, ninja, parkour, enroll };
}

function uniformSale(lines: { child: any; name: string; size?: string; quantity: number; unit_cents: number }[], status = "on_esa") {
  const sale = db.insertRow("store_sales", { pay: "esa", status });
  const rows = lines.map((l) => db.insertRow("store_sale_lines", {
    sale_id: sale.id, child_id: l.child.id, name: l.name, size: l.size ?? null, quantity: l.quantity, unit_cents: l.unit_cents, esa_invoice_id: null,
  }));
  return { sale, rows };
}

const noonArizona = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 19) / 1000;

describe("who may call it", () => {
  it("turns away a coach", async () => {
    db.profile = { staff: { role: "coach" }, aal: "aal2" };
    expect(await call({ action: "create", class_month: "2026-12" })).toMatchObject({ status: 403 });
  });

  it("turns away an owner who has not finished two-step sign-in", async () => {
    db.profile = { staff: { role: "owner" }, aal: "aal1" };
    expect(await call({ action: "create", class_month: "2026-12" })).toMatchObject({ status: 403 });
  });

  it("refuses a live Stripe key unless STRIPE_LIVE_OK=yes", async () => {
    env.STRIPE_SECRET_KEY = "sk_live_fake";
    expect((await call({ action: "create", class_month: "2026-12" })).status).toBe(503);
    expect(stripe.calls).toHaveLength(0);
  });

  it("answers anything but create or mark_paid with a 400", async () => {
    expect((await call({ action: "refund" })).status).toBe(400);
  });
});

describe("create", () => {
  it.each(["2026-13", "2026-00", "Dec 2026", "2026-1", ""])("rejects class_month %j", async (class_month) => {
    const r = await call({ action: "create", class_month });
    expect(r.status).toBe(400);
    expect(stripe.calls).toHaveLength(0);
  });

  it("makes one invoice per child with a tuition line per ESA class, due noon Arizona on the 1st", async () => {
    const s = seed();
    s.enroll(s.ava, s.parkour);
    s.enroll(s.ava, s.ninja);

    const r = await call({ action: "create", class_month: "2026-12" });

    expect(r.status).toBe(200);
    expect(r.body.class_month).toBe("December 2026");
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0]).toMatchObject({ student: "Ava T", family: "Tester", amount: 33000, classes: 2, uniforms: 0 });

    const [inv] = stripe.invoices.values();
    expect(inv.status).toBe("open");
    expect(inv.params).toMatchObject({
      customer: "cus_test_tester",
      collection_method: "send_invoice",
      due_date: String(noonArizona(2026, 12, 1)),
      auto_advance: "false",
      pending_invoice_items_behavior: "exclude",
      "metadata[esa]": "true",
      "metadata[class_month]": "2026-12",
      "metadata[child_id]": s.ava.id,
    });
    // Lines in program-name order, each for the whole month.
    expect(inv.items.map((i) => [i.description, i.amount])).toEqual([
      ["Ninja: Ava T, December 2026 tuition", "18000"],
      ["Parkour: Ava T, December 2026 tuition", "15000"],
    ]);
    expect(inv.items[0]).toMatchObject({ "period[start]": String(noonArizona(2026, 12, 1)), "period[end]": String(noonArizona(2026, 12, 31)) });

    expect(db.tables.esa_invoices).toHaveLength(1);
    expect(db.tables.esa_invoices[0]).toMatchObject({
      child_id: s.ava.id, class_month: "2026-12-01", amount_cents: 33000, status: "sent", stripe_invoice_id: inv.id, hosted_invoice_url: inv.hosted_invoice_url,
    });
  });

  it("gets the last day of February right in the billing period, leap year or not", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    await call({ action: "create", class_month: "2028-02" });
    const [inv] = stripe.invoices.values();
    expect(inv.items[0]["period[end]"]).toBe(String(noonArizona(2028, 2, 29)));
  });

  it("gives each sibling their own invoice", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    s.enroll(s.ben, s.parkour);
    const r = await call({ action: "create", class_month: "2026-12" });
    expect(r.body.created.map((c: any) => [c.student, c.amount]).sort()).toEqual([["Ava T", 18000], ["Ben T", 15000]]);
    expect(stripe.invoices.size).toBe(2);
  });

  it("bills only active ESA enrollments", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    s.enroll(s.ava, s.parkour, { pay: "private" });
    s.enroll(s.ben, s.ninja, { status: "dropped" });
    const r = await call({ action: "create", class_month: "2026-12" });
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0]).toMatchObject({ student: "Ava T", amount: 18000, classes: 1 });
  });

  it("can be limited to one family", async () => {
    const s = seed();
    const other = db.insertRow("families", { name: "Other", stripe_customer_id: "cus_test_other" });
    const dee = db.insertRow("children", { first_name: "Dee", last_name: "Other", family_id: other.id });
    s.enroll(s.ava, s.ninja);
    s.enroll(dee, s.ninja);
    const r = await call({ action: "create", class_month: "2026-12", family_id: other.id });
    expect(r.body.created.map((c: any) => c.student)).toEqual(["Dee O"]);
  });

  it("skips a family with no Stripe customer and writes nothing for them", async () => {
    const s = seed();
    s.enroll(s.cal, s.ninja);
    const r = await call({ action: "create", class_month: "2026-12" });
    expect(r.body.created).toHaveLength(0);
    expect(r.body.skipped).toEqual([{ student: "Cal S", why: "family has no Stripe customer" }]);
    expect(db.tables.esa_invoices).toHaveLength(0);
    expect(stripe.calls).toHaveLength(0);
  });

  it("never bills a child twice for the same month, even when run again", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    await call({ action: "create", class_month: "2026-12" });
    const again = await call({ action: "create", class_month: "2026-12" });
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped).toEqual([{ student: "Ava T", why: "already has an invoice for this month" }]);
    expect(stripe.invoices.size).toBe(1);
    expect(db.tables.esa_invoices).toHaveLength(1);
  });

  it("treats losing the race for the month's slot as already invoiced, without touching Stripe", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    db.failNext("esa_invoices", "insert", 'duplicate key value violates unique constraint "esa_invoices_child_id_class_month_key"');
    const r = await call({ action: "create", class_month: "2026-12" });
    expect(r.body.skipped).toEqual([{ student: "Ava T", why: "already has an invoice for this month" }]);
    expect(stripe.calls).toHaveLength(0);
  });

  it("bills a different month separately", async () => {
    const s = seed();
    s.enroll(s.ava, s.ninja);
    await call({ action: "create", class_month: "2026-12" });
    const jan = await call({ action: "create", class_month: "2027-01" });
    expect(jan.body.created).toHaveLength(1);
    expect(db.tables.esa_invoices.map((i) => i.class_month).sort()).toEqual(["2026-12-01", "2027-01-01"]);
  });

  it.fails("BUG: a child whose invoice for the month was voided can be invoiced again", async () => {
    // The function only counts invoices that aren't void as "already invoiced", but the table keeps
    // unique (child_id, class_month), so the new row is refused and the child is skipped for good.
    const s = seed();
    s.enroll(s.ava, s.ninja);
    db.insertRow("esa_invoices", { child_id: s.ava.id, class_month: "2026-12-01", amount_cents: 18000, status: "void", stripe_invoice_id: "in_old" });
    const r = await call({ action: "create", class_month: "2026-12" });
    expect(r.body.created).toHaveLength(1);
  });

  describe("uniforms bought on ESA", () => {
    it("ride on the child's invoice, are claimed for it, and the sale is marked invoiced", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      const { sale, rows } = uniformSale([{ child: s.ava, name: "HERO shirt", size: "YM", quantity: 2, unit_cents: 2500 }]);

      const r = await call({ action: "create", class_month: "2026-12" });

      expect(r.body.created[0]).toMatchObject({ amount: 23000, uniforms: 2 });
      const [inv] = stripe.invoices.values();
      expect(inv.items.map((i) => [i.description, i.amount])).toEqual([
        ["Ninja: Ava T, December 2026 tuition", "18000"],
        ["HERO shirt (YM) × 2: Ava T, required HERO uniform", "5000"],
      ]);
      const row = db.tables.esa_invoices[0];
      expect(row.amount_cents).toBe(23000);
      expect(db.find("store_sale_lines", rows[0].id)!.esa_invoice_id).toBe(row.id);
      expect(db.find("store_sales", sale.id)!.status).toBe("invoiced");
    });

    it("stay with their own child, and a shared sale is invoiced once both siblings' lines are", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      s.enroll(s.ben, s.ninja);
      const { sale, rows } = uniformSale([
        { child: s.ava, name: "HERO shirt", quantity: 1, unit_cents: 2500 },
        { child: s.ben, name: "HERO shorts", quantity: 1, unit_cents: 2000 },
      ]);
      const r = await call({ action: "create", class_month: "2026-12" });
      const byStudent = Object.fromEntries(r.body.created.map((c: any) => [c.student, c.amount]));
      expect(byStudent).toEqual({ "Ava T": 20500, "Ben T": 20000 });
      const invOf = (childId: string) => db.tables.esa_invoices.find((i) => i.child_id === childId)!.id;
      expect(db.find("store_sale_lines", rows[0].id)!.esa_invoice_id).toBe(invOf(s.ava.id));
      expect(db.find("store_sale_lines", rows[1].id)!.esa_invoice_id).toBe(invOf(s.ben.id));
      expect(db.find("store_sales", sale.id)!.status).toBe("invoiced");
    });

    it("are left alone when the sale isn't waiting for an ESA invoice, or is already on one", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      uniformSale([{ child: s.ava, name: "Voided shirt", quantity: 1, unit_cents: 2500 }], "void");
      const earlier = uniformSale([{ child: s.ava, name: "Old shirt", quantity: 1, unit_cents: 2500 }]);
      earlier.rows[0].esa_invoice_id = "esa-earlier";
      const r = await call({ action: "create", class_month: "2026-12" });
      expect(r.body.created[0]).toMatchObject({ amount: 18000, uniforms: 0 });
      expect(earlier.rows[0].esa_invoice_id).toBe("esa-earlier");
    });

    it("go on only the first month's invoice", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      uniformSale([{ child: s.ava, name: "HERO shirt", quantity: 1, unit_cents: 2500 }]);
      const dec = await call({ action: "create", class_month: "2026-12" });
      const jan = await call({ action: "create", class_month: "2027-01" });
      expect(dec.body.created[0].amount).toBe(20500);
      expect(jan.body.created[0].amount).toBe(18000);
    });
  });

  describe("when Stripe fails part way", () => {
    it("throws the row away and lets the uniforms go, so the next run can bill them", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      const { sale, rows } = uniformSale([{ child: s.ava, name: "HERO shirt", quantity: 1, unit_cents: 2500 }]);
      stripe.failNext("POST", /^\/v1\/invoiceitems$/, "Your card was declined");

      const r = await call({ action: "create", class_month: "2026-12" });

      expect(r.body.created).toHaveLength(0);
      expect(r.body.skipped).toEqual([{ student: "Ava T", why: "Stripe refused: Your card was declined" }]);
      expect(db.tables.esa_invoices).toHaveLength(0);
      expect(db.find("store_sale_lines", rows[0].id)!.esa_invoice_id).toBeNull();
      expect(db.find("store_sales", sale.id)!.status).toBe("on_esa");
      // The half-built Stripe invoice is still a draft: never sent, never payable.
      expect([...stripe.invoices.values()].map((i) => i.status)).toEqual(["draft"]);

      const retry = await call({ action: "create", class_month: "2026-12" });
      expect(retry.body.created[0]).toMatchObject({ amount: 20500, uniforms: 1 });
    });

    it("voids an invoice Stripe finalized even though the reply was lost", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      stripe.failNext("POST", /\/finalize$/, "connection reset", true);
      const r = await call({ action: "create", class_month: "2026-12" });
      expect(r.body.skipped[0].why).toBe("Stripe refused: connection reset");
      expect([...stripe.invoices.values()].map((i) => i.status)).toEqual(["void"]);
      expect(db.tables.esa_invoices).toHaveLength(0);
    });

    it("reports a Stripe invoice that was made but could not be recorded", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      db.failNext("esa_invoices", "update", "permission denied");
      const r = await call({ action: "create", class_month: "2026-12" });
      const [inv] = stripe.invoices.values();
      expect(r.body.skipped).toEqual([{ student: "Ava T", why: `Stripe invoice ${inv.id} made but not recorded: permission denied` }]);
    });

    it("keeps going with the other children", async () => {
      const s = seed();
      s.enroll(s.ava, s.ninja);
      s.enroll(s.ben, s.ninja);
      stripe.failNext("POST", /^\/v1\/invoices$/, "rate limited");
      const r = await call({ action: "create", class_month: "2026-12" });
      expect(r.body.created).toHaveLength(1);
      expect(r.body.skipped).toHaveLength(1);
    });
  });
});

describe("mark_paid", () => {
  // An open $180 invoice for Ava, sent through Stripe, and a ClassWallet deposit of $176.40 (net of the 2% fee).
  function openInvoice(status = "sent") {
    const s = seed();
    const inv = stripe.addInvoice("open");
    const row = db.insertRow("esa_invoices", { child_id: s.ava.id, class_month: "2026-12-01", amount_cents: 18000, status, stripe_invoice_id: inv.id });
    const deposit = db.insertRow("classwallet_deposits", { bank_txn_id: "txn-1", on_date: "2026-11-20", net_cents: 17640, gross_cents: 18000, fee_cents: 360, status: "new", esa_invoice_id: null });
    return { s, inv, row, deposit };
  }

  it("needs an invoice id and a reason", async () => {
    const { row } = openInvoice();
    expect((await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "   " })).status).toBe(400);
    expect((await call({ action: "mark_paid", reason: "Deposit seen" })).status).toBe(400);
    expect(row.status).toBe("sent");
  });

  it("answers 404 for an invoice it can't find", async () => {
    openInvoice();
    expect((await call({ action: "mark_paid", esa_invoice_id: "nope", reason: "Deposit seen" })).status).toBe(404);
  });

  it.each(["sent", "submitted", "rejected"])("marks a %s invoice paid in Stripe (outside Stripe) and in Family Desk", async (status) => {
    const { inv, row } = openInvoice(status);
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "ClassWallet deposit seen in the bank" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, invoice: { id: row.id, status: "paid" } } });
    expect(stripe.invoices.get(inv.id)).toMatchObject({ status: "paid", paid_out_of_band: true });
    expect(db.rpcCalls.find((c) => c.name === "mark_esa_paid")!.args).toEqual({ p_id: row.id, p_reason: "ClassWallet deposit seen in the bank" });
  });

  it("ties the ClassWallet deposit to the invoice when one is given", async () => {
    const { row, deposit } = openInvoice();
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen", classwallet_deposit_id: deposit.id });
    expect(r.body).toMatchObject({ ok: true });
    expect(r.body.note).toBeUndefined();
    expect(db.find("classwallet_deposits", deposit.id)).toMatchObject({ status: "confirmed", esa_invoice_id: row.id });
  });

  it("records an invoice someone already marked paid in Stripe without paying it again", async () => {
    const { inv, row } = openInvoice();
    inv.status = "paid";
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Paid in Stripe" });
    expect(r.body.ok).toBe(true);
    expect(row.status).toBe("paid");
    expect(stripe.calls.filter((c) => c.path.endsWith("/pay"))).toHaveLength(0);
  });

  it("refuses when the Stripe invoice is void, and changes nothing", async () => {
    const { inv, row, deposit } = openInvoice();
    inv.status = "void";
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen", classwallet_deposit_id: deposit.id });
    expect(r.status).toBe(409);
    expect(row.status).toBe("sent");
    expect(db.find("classwallet_deposits", deposit.id)!.status).toBe("new");
  });

  it("is a no-op on an invoice already paid", async () => {
    const { row } = openInvoice("paid");
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen" });
    expect(r.body).toEqual({ ok: true, note: "Already paid" });
    expect(stripe.calls).toHaveLength(0);
    expect(db.rpcCalls.some((c) => c.name === "mark_esa_paid")).toBe(false);
  });

  it("says so when Stripe was marked paid but Family Desk could not record it", async () => {
    const { inv, row } = openInvoice();
    db.failNext("mark_esa_paid", "rpc", "permission denied");
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen" });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Stripe shows paid but Family Desk did not record it/);
    expect(stripe.invoices.get(inv.id)!.status).toBe("paid");
  });

  it.fails("BUG: tells the caller when the deposit was already confirmed against another invoice", async () => {
    // The deposit update only touches rows still "new". When none match, Supabase returns no error, so the
    // function replies plain ok and the screen reports success while the deposit stays tied to the other invoice.
    const { row, deposit } = openInvoice();
    deposit.status = "confirmed";
    deposit.esa_invoice_id = "some-other-invoice";
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen", classwallet_deposit_id: deposit.id });
    expect(r.body.note).toBeDefined();
  });

  it.fails("BUG: confirms the deposit when the invoice was already marked paid", async () => {
    // "Already paid" returns before the deposit step, so a deposit confirmed from the Money screen for an invoice
    // someone marked paid by hand stays "new" (and the screen shows the "Already paid" note as an error).
    const { row, deposit } = openInvoice("paid");
    await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen", classwallet_deposit_id: deposit.id });
    expect(db.find("classwallet_deposits", deposit.id)).toMatchObject({ status: "confirmed", esa_invoice_id: row.id });
  });

  it.fails("BUG: refuses a draft invoice with a clear 409 instead of claiming Stripe shows it paid", async () => {
    // A draft row has no Stripe invoice yet, so the Stripe check is skipped; mark_esa_paid then refuses it and the
    // reply is a 500 saying "Stripe shows paid but Family Desk did not record it", which isn't true.
    const s = seed();
    const row = db.insertRow("esa_invoices", { child_id: s.ava.id, class_month: "2026-12-01", amount_cents: 18000, status: "draft", stripe_invoice_id: null });
    const r = await call({ action: "mark_paid", esa_invoice_id: row.id, reason: "Deposit seen" });
    expect(r.status).toBe(409);
    expect(r.body.error).not.toMatch(/Stripe shows paid/);
  });
});
