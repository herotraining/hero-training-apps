// The store's money rules in the database: public.store_create_sale (prices come from the price list, who may
// sell, what each way of paying needs) and the triggers app.stamp_store_sale and app.guard_store_line (a card
// sale is settled only through the store function's service key, a sale on an ESA invoice can't go back, a uniform
// goes only on its own child's new invoice).
//
// The store tables, functions and triggers are read straight from the migration files, every definition in order so
// the latest wins, and run in PGlite, a Postgres that lives inside the test process. The helpers they lean on
// (who is signed in, which site they may act for) are small stand-ins driven by session settings, so a test can
// act as an owner, a site-pinned admin, a coach, the store function's service key, or nobody. Made-up data only;
// nothing connects to the live database.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, migrationsDir), "utf8"));

// Every definition of a function, in migration order.
function definitions(name: string): string[] {
  const re = new RegExp(`create or replace function ${name.replace(".", "\\.")}\\([^)]*\\)[\\s\\S]*?\\$\\$;`, "g");
  return migrations.flatMap((sql) => [...sql.matchAll(re)].map((m) => m[0]));
}
function createTable(name: string): string {
  const m = migrations.map((sql) => new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(sql)).find(Boolean);
  if (!m) throw new Error(`create table for ${name} not found in migrations`);
  return m[0];
}

// The rest of the schema, only as far as the store code reads it, with stand-ins for the sign-in helpers.
const scaffold = `
  create schema app; create schema auth;
  create type public.staff_role as enum ('owner','admin','site_lead','coach');
  create type public.enrollment_status as enum ('active','hold','dropped','waitlist');
  create type public.enroll_pay as enum ('esa','card');
  create type public.esa_status as enum ('draft','sent','submitted','paid','rejected','void');
  create table public.sites (id text primary key, name text not null);
  create table public.staff (id uuid primary key default gen_random_uuid(), user_id uuid unique, email text not null unique, name text not null,
    role public.staff_role not null, site_id text references public.sites(id), active boolean not null default true);
  create table public.families (id uuid primary key default gen_random_uuid(), name text not null, site_id text not null references public.sites(id),
    stripe_customer_id text unique, status text not null default 'active');
  create table public.children (id uuid primary key default gen_random_uuid(), family_id uuid not null references public.families(id),
    first_name text not null, last_name text not null, uniform_size text);
  create table public.programs (id text primary key);
  create table public.enrollments (id uuid primary key default gen_random_uuid(), child_id uuid not null references public.children(id),
    program_id text not null references public.programs(id), status public.enrollment_status not null default 'active', pay public.enroll_pay not null default 'card');
  create table public.esa_invoices (id uuid primary key default gen_random_uuid(), child_id uuid not null references public.children(id),
    class_month date not null, amount_cents integer not null, status public.esa_status not null default 'draft');
  -- Who is signed in: test.uid names the auth user, test.jwt is the token's claims (unset = no session at all).
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('test.jwt', true), '')::jsonb $$;
  create function app.me() returns public.staff language sql stable as $$ select s.* from public.staff s where s.user_id = auth.uid() and s.active limit 1 $$;
`;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(scaffold);
  for (const fn of ["app.aal2", "app.role", "app.site", "app.admin_for", "app.trusted_writer"]) for (const d of definitions(fn)) await pg.exec(d);
  for (const t of ["store_items", "store_sales", "store_sale_lines"]) await pg.exec(createTable(t));
  await pg.exec("alter table public.store_sales add column if not exists settled_by uuid references public.staff(id)");
  for (const fn of ["app.stamp_store_sale", "app.guard_store_line", "public.store_create_sale"]) {
    const defs = definitions(fn);
    expect(defs.length, `${fn} not found in migrations`).toBeGreaterThan(0);
    for (const d of defs) await pg.exec(d);
  }
  await pg.exec(`
    create trigger stamp_store_sale before insert or update on public.store_sales for each row execute function app.stamp_store_sale();
    create trigger guard_store_line before update on public.store_sale_lines for each row execute function app.guard_store_line();
    insert into public.sites (id, name) values ('surprise', 'Surprise'), ('goodyear', 'Goodyear');
    insert into public.programs (id) values ('ninja');
  `);
});
afterAll(async () => { await pg?.close(); });

// Made-up staff, families and price list, fresh for every test.
const UID = { owner: "00000000-0000-0000-0000-000000000001", admin: "00000000-0000-0000-0000-000000000002", coach: "00000000-0000-0000-0000-000000000003" };
type Ids = { testers: string; ava: string; ben: string; samples: string; cal: string; tank: string; hoodie: string; bottle: string; old: string };
let ids: Ids;
beforeEach(async () => {
  await pg.exec("truncate public.store_sale_lines, public.store_sales, public.store_items, public.esa_invoices, public.enrollments, public.children, public.families, public.staff cascade");
  await pg.query(`insert into public.staff (user_id, email, name, role, site_id) values
    ($1, 'owner@example.test', 'Owner', 'owner', null), ($2, 'admin@example.test', 'Goodyear admin', 'admin', 'goodyear'), ($3, 'coach@example.test', 'Coach', 'coach', null)`,
    [UID.owner, UID.admin, UID.coach]);
  const f = await pg.query<{ id: string }>(`insert into public.families (name, site_id, stripe_customer_id) values ('Tester', 'surprise', 'cus_test_tester'), ('Sample', 'surprise', null) returning id`);
  const [testers, samples] = f.rows.map((r) => r.id);
  const c = await pg.query<{ id: string }>(`insert into public.children (family_id, first_name, last_name) values ($1, 'Ava', 'Tester'), ($1, 'Ben', 'Tester'), ($2, 'Cal', 'Sample') returning id`, [testers, samples]);
  const [ava, ben, cal] = c.rows.map((r) => r.id);
  await pg.query("insert into public.enrollments (child_id, program_id, pay, status) values ($1, 'ninja', 'esa', 'active'), ($2, 'ninja', 'card', 'active')", [ava, ben]);
  const i = await pg.query<{ id: string }>(`insert into public.store_items (name, kind, price_cents, sizes, esa_ok, active) values
    ('HERO uniform tank top', 'uniform', 2500, array['Youth S','Youth M'], true, true),
    ('HERO uniform hoodie', 'uniform', 2500, array['Youth S','Youth M'], true, true),
    ('Water bottle', 'gear', 1000, '{}', false, true),
    ('Old shirt', 'gear', 500, '{}', false, false) returning id`);
  const [tank, hoodie, bottle, old] = i.rows.map((r) => r.id);
  ids = { testers, ava, ben, samples, cal, tank, hoodie, bottle, old };
  await as("owner");
});

// Who the next statements run as.
async function as(who: "owner" | "admin" | "coach" | "owner_aal1" | "service" | "nobody") {
  const uid = who.startsWith("owner") ? UID.owner : who === "admin" ? UID.admin : who === "coach" ? UID.coach : "";
  const jwt = who === "service" ? '{"role":"service_role"}' : who === "nobody" ? "" : `{"role":"authenticated","aal":"${who === "owner_aal1" ? "aal1" : "aal2"}"}`;
  await pg.query("select set_config('test.uid', $1, false), set_config('test.jwt', $2, false)", [uid, jwt]);
}

type Line = { item_id: string; quantity?: number; size?: string; child_id?: string; unit_cents?: number };
async function sell(pay: string, lines: Line[], opts: { site?: string; family?: string | null; tapped?: boolean; note?: string | null } = {}) {
  const r = await pg.query<any>("select to_jsonb(public.store_create_sale($1, $2, $3, $4, $5, $6)) as s", [
    opts.site ?? "surprise", opts.family === undefined ? ids.testers : opts.family, pay, opts.tapped ?? false, opts.note ?? null, JSON.stringify(lines),
  ]);
  return r.rows[0].s;
}
const selling = (...a: Parameters<typeof sell>) => expect(sell(...a)).rejects;
async function linesOf(saleId: string) {
  return (await pg.query<any>("select name, size, quantity, unit_cents, child_id, esa_invoice_id from public.store_sale_lines where sale_id = $1 order by name", [saleId])).rows;
}
async function sale(id: string) {
  return (await pg.query<any>("select * from public.store_sales where id = $1", [id])).rows[0];
}
async function setSale(id: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  await pg.query(`update public.store_sales set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...keys.map((k) => patch[k])]);
}
const settingSale = (id: string, patch: Record<string, unknown>) => expect(setSale(id, patch)).rejects;
async function invoice(childId: string, status = "draft") {
  return (await pg.query<{ id: string }>("insert into public.esa_invoices (child_id, class_month, amount_cents, status) values ($1, '2026-12-01', 18000, $2) returning id", [childId, status])).rows[0].id;
}

describe("who may sell", () => {
  it("an owner sells at any site", async () => {
    expect((await sell("cash", [{ item_id: ids.bottle }], { site: "goodyear", family: null })).status).toBe("done");
  });
  it("an admin pinned to a site sells there only", async () => {
    await as("admin");
    expect((await sell("cash", [{ item_id: ids.bottle }], { site: "goodyear", family: null })).site_id).toBe("goodyear");
    await selling("cash", [{ item_id: ids.bottle }], { site: "surprise", family: null }).toThrow(/Only owners and admins of this site can sell/);
    // Nor sell for a family they can't see.
    await selling("cash", [{ item_id: ids.bottle }], { site: "goodyear" }).toThrow(/Family not found, or not yours to see/);
  });
  it("a coach, an owner without two-step sign-in, and nobody can't sell", async () => {
    for (const who of ["coach", "owner_aal1", "nobody"] as const) {
      await as(who);
      await selling("cash", [{ item_id: ids.bottle }], { family: null }).toThrow(/Only owners and admins of this site can sell/);
    }
  });
  it("stamps who sold it from the session", async () => {
    const s = await sell("cash", [{ item_id: ids.bottle }], { family: null });
    const staff = await pg.query<any>("select name from public.staff where id = $1", [s.sold_by]);
    expect(staff.rows[0].name).toBe("Owner");
  });
});

describe("what goes on the receipt", () => {
  it("prices every line from the price list and adds them up", async () => {
    const s = await sell("cash", [{ item_id: ids.tank, size: "Youth M", quantity: 2 }, { item_id: ids.bottle, quantity: 3 }], { family: null });
    expect(s.total_cents).toBe(2 * 2500 + 3 * 1000);
    expect(await linesOf(s.id)).toEqual([
      { name: "HERO uniform tank top", size: "Youth M", quantity: 2, unit_cents: 2500, child_id: null, esa_invoice_id: null },
      { name: "Water bottle", size: null, quantity: 3, unit_cents: 1000, child_id: null, esa_invoice_id: null },
    ]);
  });
  it("ignores a price the cart sends, unless it disagrees with the list", async () => {
    const s = await sell("cash", [{ item_id: ids.bottle, unit_cents: 1000 }], { family: null });
    expect(s.total_cents).toBe(1000);
    await selling("cash", [{ item_id: ids.bottle, unit_cents: 1 }], { family: null }).toThrow(/price of the Water bottle changed to \$10\.00/);
  });
  it("needs a size when the item comes in sizes, and only one on the list", async () => {
    await selling("cash", [{ item_id: ids.tank }], { family: null }).toThrow(/Pick a size for the HERO uniform tank top/);
    await selling("cash", [{ item_id: ids.tank, size: "Adult 5XL" }], { family: null }).toThrow(/Pick a size/);
    // A size on a one-size item is dropped, not stored.
    const s = await sell("cash", [{ item_id: ids.bottle, size: "Youth M" }], { family: null });
    expect((await linesOf(s.id))[0].size).toBeNull();
  });
  it("refuses an empty cart, a retired item, and bad quantities", async () => {
    await selling("cash", [], { family: null }).toThrow(/Add at least one item/);
    await selling("cash", [{ item_id: ids.old }], { family: null }).toThrow(/no longer for sale/);
    await selling("cash", [{ item_id: ids.bottle, quantity: 0 }], { family: null }).toThrow(/Quantity must be 1 to 50/);
    await selling("cash", [{ item_id: ids.bottle, quantity: 51 }], { family: null }).toThrow(/Quantity must be 1 to 50/);
    await selling("cash", Array(31).fill({ item_id: ids.bottle }), { family: null }).toThrow(/Too many lines/);
  });
  it("writes nothing when any line is refused", async () => {
    await selling("cash", [{ item_id: ids.bottle }, { item_id: ids.old }], { family: null }).toThrow();
    expect((await pg.query("select count(*)::int as n from public.store_sales")).rows[0]).toEqual({ n: 0 });
  });
  it("names a child only from the family on the sale", async () => {
    await selling("cash", [{ item_id: ids.bottle, child_id: ids.ava }], { family: null }).toThrow(/Pick the family before naming a child/);
    await selling("cash", [{ item_id: ids.bottle, child_id: ids.cal }]).toThrow(/That child is not in this family/);
    const s = await sell("cash", [{ item_id: ids.bottle, child_id: ids.ava }]);
    expect((await linesOf(s.id))[0].child_id).toBe(ids.ava);
  });
  it("remembers a child's uniform size from their first uniform, and keeps it after", async () => {
    await sell("cash", [{ item_id: ids.tank, size: "Youth S", child_id: ids.ava }]);
    await sell("cash", [{ item_id: ids.hoodie, size: "Youth M", child_id: ids.ava }]);
    const c = await pg.query<any>("select uniform_size from public.children where id = $1", [ids.ava]);
    expect(c.rows[0].uniform_size).toBe("Youth S");
  });
});

describe("ways of paying", () => {
  it("card by QR code waits for Stripe; Tap to Pay is done and paid now", async () => {
    const qr = await sell("card", [{ item_id: ids.bottle }], { family: null });
    expect(qr).toMatchObject({ status: "waiting", paid_at: null, stripe_checkout_id: null });
    const tapped = await sell("card", [{ item_id: ids.bottle }], { family: null, tapped: true });
    expect(tapped.status).toBe("done");
    expect(tapped.paid_at).not.toBeNull();
  });
  it("won't make a QR code for under $0.50, but Tap to Pay may take it", async () => {
    await pg.query("update public.store_items set price_cents = 40 where id = $1", [ids.bottle]);
    await selling("card", [{ item_id: ids.bottle }], { family: null }).toThrow(/under \$0\.50/);
    expect((await sell("card", [{ item_id: ids.bottle }], { family: null, tapped: true })).total_cents).toBe(40);
  });
  it("cash is done and paid; a Jackrabbit posting is done but not paid here", async () => {
    const cash = await sell("cash", [{ item_id: ids.bottle }], { family: null });
    expect(cash.status).toBe("done"); expect(cash.paid_at).not.toBeNull();
    const jr = await sell("jackrabbit", [{ item_id: ids.bottle }], { family: ids.samples });
    expect(jr.status).toBe("done"); expect(jr.paid_at).toBeNull();
  });
  it("free needs a reason and charges nothing on every line", async () => {
    await selling("free", [{ item_id: ids.bottle }], { family: null }).toThrow(/Say why there is no charge/);
    await selling("free", [{ item_id: ids.bottle }], { family: null, note: "   " }).toThrow(/Say why there is no charge/);
    const s = await sell("free", [{ item_id: ids.tank, size: "Youth M", quantity: 2 }], { family: null, note: "Replacement for a torn one" });
    expect(s).toMatchObject({ status: "done", total_cents: 0, note: "Replacement for a torn one" });
    expect((await linesOf(s.id))[0].unit_cents).toBe(0);
  });
  it("Jackrabbit is for families not yet billed in Family Desk, and needs a family", async () => {
    await selling("jackrabbit", [{ item_id: ids.bottle }], { family: null }).toThrow(/Pick the family first/);
    await selling("jackrabbit", [{ item_id: ids.bottle }]).toThrow(/billed in Family Desk now, not Jackrabbit/);
  });

  describe("ESA", () => {
    it("puts a required uniform for an ESA child on their next invoice", async () => {
      const s = await sell("esa", [{ item_id: ids.tank, size: "Youth M", child_id: ids.ava }]);
      expect(s).toMatchObject({ status: "on_esa", total_cents: 2500, paid_at: null });
    });
    it("needs a family billed in Family Desk", async () => {
      await selling("esa", [{ item_id: ids.tank, size: "Youth M" }], { family: null }).toThrow(/Pick the family first/);
      await selling("esa", [{ item_id: ids.tank, size: "Youth M", child_id: ids.cal }], { family: ids.samples }).toThrow(/still billed in Jackrabbit/);
    });
    it("takes only required uniforms, each named for a child with an active ESA class", async () => {
      await selling("esa", [{ item_id: ids.bottle, child_id: ids.ava }]).toThrow(/not a required uniform, so ESA can't pay for it/);
      await selling("esa", [{ item_id: ids.tank, size: "Youth M" }]).toThrow(/Pick which child each uniform is for/);
      await selling("esa", [{ item_id: ids.tank, size: "Youth M", child_id: ids.ben }]).toThrow(/Ben has no active ESA class/);
      await pg.query("update public.enrollments set status = 'dropped' where child_id = $1", [ids.ava]);
      await selling("esa", [{ item_id: ids.tank, size: "Youth M", child_id: ids.ava }]).toThrow(/Ava has no active ESA class/);
    });
  });
});

describe("after the sale: what a staff session may change", () => {
  it("never changes what was sold", async () => {
    // (The live database also limits a staff session to a few columns by grant; grants aren't modelled here, so
    // this checks the trigger's own protection of the sale's substance.)
    const s = await sell("cash", [{ item_id: ids.bottle }]);
    await setSale(s.id, { total_cents: 1, pay: "free", site_id: "goodyear", family_id: ids.samples, note: "A note is fine" });
    expect(await sale(s.id)).toMatchObject({ total_cents: 1000, pay: "cash", site_id: "surprise", family_id: ids.testers, note: "A note is fine" });
    await pg.query("update public.store_sale_lines set name = 'Gold bar', quantity = 50, unit_cents = 1, handed_out_at = now() where sale_id = $1", [s.id]);
    expect((await linesOf(s.id))[0]).toMatchObject({ name: "Water bottle", quantity: 1, unit_cents: 1000 });
  });
  it("may void a cash sale, but a voided sale stays void", async () => {
    const s = await sell("cash", [{ item_id: ids.bottle }], { family: null });
    await setSale(s.id, { status: "void" });
    await settingSale(s.id, { status: "done" }).toThrow(/A voided sale stays void/);
  });
  it("may void a card sale only before it has a payment page", async () => {
    const s = await sell("card", [{ item_id: ids.bottle }], { family: null });
    await settingSale(s.id, { stripe_checkout_id: "cs_test_1", stripe_url: "https://checkout.stripe.test/1" }).toThrow(/Only the Store's payment step sets the Stripe payment page/);
    await settingSale(s.id, { status: "done" }).toThrow(/settled through Stripe from the Store screen/);
    await setSale(s.id, { status: "void" });
    expect((await sale(s.id)).status).toBe("void");
  });
  it("can't void a card sale once it has a payment page, or once it is paid", async () => {
    const s = await sell("card", [{ item_id: ids.bottle }], { family: null });
    await as("service"); await setSale(s.id, { stripe_checkout_id: "cs_test_1", stripe_url: "https://checkout.stripe.test/1", stripe_live: false }); await as("owner");
    await settingSale(s.id, { status: "void" }).toThrow(/settled through Stripe from the Store screen/);
    const paid = await sell("card", [{ item_id: ids.bottle }], { family: null, tapped: true });
    await settingSale(paid.id, { status: "void" }).toThrow(/settled through Stripe from the Store screen/);
    expect((await sale(paid.id)).status).toBe("done");
  });
  it("a finished sale can only be voided", async () => {
    const s = await sell("cash", [{ item_id: ids.bottle }], { family: null });
    await settingSale(s.id, { status: "waiting" }).toThrow();
  });
});

describe("after the sale: the store function's service key", () => {
  it("sets the payment page and settles the sale, which stamps paid_at", async () => {
    const s = await sell("card", [{ item_id: ids.bottle }], { family: null });
    await as("service");
    await setSale(s.id, { stripe_checkout_id: "cs_test_1", stripe_url: "https://checkout.stripe.test/1", stripe_live: false });
    await setSale(s.id, { status: "done" });
    const now = await sale(s.id);
    expect(now).toMatchObject({ status: "done", stripe_checkout_id: "cs_test_1" });
    expect(now.paid_at).not.toBeNull();
  });
  it("still can't bring back a void sale or void a paid card sale", async () => {
    const paid = await sell("card", [{ item_id: ids.bottle }], { family: null, tapped: true });
    await as("service");
    await settingSale(paid.id, { status: "void" }).toThrow(/Refund it in Stripe instead/);
  });
});

describe("uniforms and ESA invoices", () => {
  async function esaSale(children = [ids.ava]) {
    const s = await sell("esa", children.map((child_id) => ({ item_id: ids.tank, size: "Youth M", child_id })));
    const lines = (await pg.query<any>("select id, child_id from public.store_sale_lines where sale_id = $1", [s.id])).rows;
    return { sale: s, lines };
  }
  const claim = (lineId: string, invoiceId: string | null) => pg.query("update public.store_sale_lines set esa_invoice_id = $2 where id = $1", [lineId, invoiceId]);

  it("a uniform goes on its own child's draft invoice, and only once", async () => {
    const { lines } = await esaSale();
    const inv = await invoice(ids.ava);
    await claim(lines[0].id, inv);
    expect((await linesOf(lines[0].id ? (await sale((await pg.query<any>("select sale_id from public.store_sale_lines where id = $1", [lines[0].id])).rows[0].sale_id)).id : ""))[0].esa_invoice_id).toBe(inv);
    await expect(claim(lines[0].id, await invoice(ids.ava, "draft"))).rejects.toThrow(/already on an ESA invoice/);
  });
  it("not on another child's invoice, nor on one already sent", async () => {
    const { lines } = await esaSale();
    await expect(claim(lines[0].id, await invoice(ids.ben))).rejects.toThrow(/only on its own child's new ESA invoice/);
    await expect(claim(lines[0].id, await invoice(ids.ava, "sent"))).rejects.toThrow(/only on its own child's new ESA invoice/);
  });
  it("not when the sale isn't waiting for an invoice", async () => {
    const { sale: s, lines } = await esaSale();
    await setSale(s.id, { status: "void" });
    await expect(claim(lines[0].id, await invoice(ids.ava))).rejects.toThrow(/not waiting for an ESA invoice/);
  });
  it("stays on its invoice for a staff session, but is let go when that invoice is thrown away", async () => {
    const { lines } = await esaSale();
    const inv = await invoice(ids.ava);
    await claim(lines[0].id, inv);
    await expect(claim(lines[0].id, null)).rejects.toThrow(/A uniform on an ESA invoice stays on it/);
    await pg.query("delete from public.esa_invoices where id = $1", [inv]);
    const line = await pg.query<any>("select esa_invoice_id from public.store_sale_lines where id = $1", [lines[0].id]);
    expect(line.rows[0].esa_invoice_id).toBeNull();
  });
  it("a sale is invoiced only once every uniform in it is on an invoice, and then can't go back or be voided", async () => {
    const { sale: s, lines } = await esaSale([ids.ava, ids.ava]);
    await settingSale(s.id, { status: "invoiced" }).toThrow(/Every uniform in the sale has to be on an ESA invoice first/);
    const inv = await invoice(ids.ava);
    await claim(lines[0].id, inv);
    await settingSale(s.id, { status: "void" }).toThrow(/already on an ESA invoice/);
    await settingSale(s.id, { status: "invoiced" }).toThrow(/Every uniform in the sale has to be on an ESA invoice first/);
    await claim(lines[1].id, inv);
    await setSale(s.id, { status: "invoiced" });
    expect((await sale(s.id)).status).toBe("invoiced");
    await settingSale(s.id, { status: "on_esa" }).toThrow(/on an ESA invoice already/);
    await settingSale(s.id, { status: "void" }).toThrow(/already on an ESA invoice/);
  });
  it("an ESA sale with nothing invoiced yet can be voided", async () => {
    const { sale: s } = await esaSale();
    await setSale(s.id, { status: "void" });
    expect((await sale(s.id)).status).toBe("void");
  });
});
