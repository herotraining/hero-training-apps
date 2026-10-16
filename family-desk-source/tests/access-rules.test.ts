// Who sees and changes what, as the live database decides it (security review findings F1 to F7, migration 0021).
// Every migration file is applied in order to PGlite, a Postgres that lives inside the test process, over small
// stand-ins for Supabase's auth and storage schemas and its API roles. Each role is then impersonated the way
// Supabase does it: request.jwt.claims plus "set role". Made-up people and families only; nothing connects to
// the live project.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => ({ name: f, sql: readFileSync(new URL(f, migrationsDir), "utf8") }));

// What a Supabase project has before the first migration: the API roles and their default grants, auth.users
// with the two helpers the policies call, and the storage tables migration 0017 touches.
const scaffold = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb not null default '{}'::jsonb, is_anonymous boolean not null default false);
  create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
`;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(scaffold);
  for (const m of migrations) {
    await pg.exec(m.sql);
    // The sites were loaded by hand on import day; migration 0007 adds programs that point at them.
    if (m.name.startsWith("20261008_0001")) await pg.exec("insert into public.sites (id, name) values ('peoria', 'Peoria'), ('mesa', 'Mesa'), ('prescott', 'Prescott'), ('lab', 'L.A.B.')");
  }
});
afterAll(async () => { await pg?.close(); });

const rows = async <T = any>(sql: string, params?: unknown[]) => (await pg.query<T>(sql, params)).rows;
const one = async <T = any>(sql: string, params?: unknown[]) => (await rows<T>(sql, params))[0];
const count = async (sql: string, params?: unknown[]) => Number((await one<{ n: number }>(sql, params)).n);
const changed = async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).affectedRows ?? 0;
const refused = (sql: string, params?: unknown[]) => expect(pg.query(sql, params)).rejects;
const ids = (list: { id: string }[]) => list.map((r) => r.id).sort();

type Who = "owner" | "lisa" | "mary" | "lead" | "coach" | "owner_aal1" | "anon" | "service";
const UID: Record<string, string> = {};
// Impersonate, the way Supabase's API does: the token's claims, then the API role.
async function as(who: Who) {
  await pg.exec("reset role");
  if (who === "anon") { await pg.query("select set_config('request.jwt.claims', '', false)"); await pg.exec("set role anon"); return; }
  if (who === "service") { await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]); await pg.exec("set role service_role"); return; }
  const sub = UID[who === "owner_aal1" ? "owner" : who];
  await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub, role: "authenticated", aal: who === "owner_aal1" ? "aal1" : "aal2" })]);
  await pg.exec("set role authenticated");
}

// Made-up people: an owner, Lisa (admin, all sites), Mary (admin, Mesa), a site lead at Mesa, a coach on the Mesa
// programs, and a coach pinned to Peoria with no sign-in. The Mesa family and the Peoria family each have one
// guardian, one child with care notes, and classes; the Mesa child's class runs today.
type Seed = { today: string; dow: number; otherDow: number; famM: string; famP: string; childM: string; childP: string; eToday: string; eAny: string; eDropped: string; eP: string;
  invM: string; invP: string; feedM: string; feedP: string; feedNone: string; depM: string; depP: string; depNone: string; attOld: string; sale: string; coachP: string; coach: string };
let s: Seed;
beforeEach(async () => {
  await pg.exec("reset role");
  await pg.exec(`truncate table auth.users, public.staff, public.families, public.programs, public.desk_feed, public.classwallet_orders,
    public.classwallet_deposits, public.store_sales, public.store_sale_lines, public.audit_log, public.attendance, public.coach_assignments, public.esa_invoices cascade`);
  const t = await one<{ today: string; dow: number }>("select app.today_arizona()::text as today, app.today_weekday()::int as dow");
  const otherDow = (t.dow + 3) % 7;
  await pg.query(`insert into public.programs (id, name, kind, site_id, weekday, monthly_price_cents) values
    ('mesa-today', 'Mesa class, today', 'class', 'mesa', $1, 10000), ('mesa-any', 'Mesa open training', 'class', 'mesa', null, 10000),
    ('mesa-other', 'Mesa class, another day', 'class', 'mesa', $2, 10000), ('peoria-today', 'Peoria class, today', 'class', 'peoria', $1, 10000)`, [t.dow, otherDow]);
  const staff = await rows<{ id: string; email: string }>(`insert into public.staff (email, name, role, site_id) values
    ('owner@example.test', 'Owner', 'owner', null), ('lisa@example.test', 'Lisa', 'admin', null), ('mary@example.test', 'Mary', 'admin', 'mesa'),
    ('lead@example.test', 'Lead', 'site_lead', 'mesa'), ('coach@example.test', 'Coach', 'coach', null), ('pcoach@example.test', 'Peoria coach', 'coach', 'peoria') returning id, email`);
  const staffId = (email: string) => staff.find((x) => x.email === email)!.id;
  // Sign-ins made the way staff-signin makes them: app_metadata.family_desk = 'staff' (F1). The trigger links each to its staff row.
  for (const who of ["owner", "lisa", "mary", "lead", "coach"]) {
    const u = await one<{ id: string }>("insert into auth.users (email, email_confirmed_at, raw_app_meta_data) values ($1, now(), '{\"family_desk\":\"staff\"}') returning id", [`${who}@example.test`]);
    UID[who] = u.id;
  }
  const [famM, famP] = ids(await rows(`insert into public.families (name, site_id, pay_method, address_line1, notes, stripe_customer_id) values
    ('Mesa Family', 'mesa', 'esa', '1 Mesa St', 'Owes a uniform', 'cus_m'), ('Peoria Family', 'peoria', 'private', '2 Peoria St', null, 'cus_p') returning id`)).sort((a, b) => a.localeCompare(b));
  const fam = await rows<{ id: string; site_id: string }>("select id, site_id from public.families");
  const M = fam.find((f) => f.site_id === "mesa")!.id, P = fam.find((f) => f.site_id === "peoria")!.id;
  void famM; void famP;
  await pg.query(`insert into public.guardians (family_id, name, email, mobile, is_primary) values ($1, 'Mesa Parent', 'mp@example.test', '(480) 555-0100', true), ($2, 'Peoria Parent', 'pp@example.test', '(623) 555-0100', true)`, [M, P]);
  const childM = (await one("insert into public.children (family_id, first_name, last_name, birth_date, site_id) values ($1, 'Mia', 'Mesa', '2017-01-01', 'mesa') returning id", [M])).id;
  const childP = (await one("insert into public.children (family_id, first_name, last_name, birth_date, site_id) values ($1, 'Pia', 'Peoria', '2017-01-01', 'peoria') returning id", [P])).id;
  await pg.query("insert into public.care_notes (child_id, allergies) values ($1, 'Peanuts'), ($2, 'Bees')", [childM, childP]);
  const eToday = (await one("insert into public.enrollments (child_id, program_id, status, pay) values ($1, 'mesa-today', 'active', 'esa') returning id", [childM])).id;
  const eAny = (await one("insert into public.enrollments (child_id, program_id, status, pay) values ($1, 'mesa-any', 'active', 'card') returning id", [childM])).id;
  const eDropped = (await one("insert into public.enrollments (child_id, program_id, status, pay) values ($1, 'mesa-other', 'dropped', 'card') returning id", [childM])).id;
  const eP = (await one("insert into public.enrollments (child_id, program_id, status, pay) values ($1, 'peoria-today', 'active', 'esa') returning id", [childP])).id;
  await pg.query("insert into public.coach_assignments (staff_id, program_id) values ($1, 'mesa-today'), ($1, 'mesa-any'), ($1, 'mesa-other')", [staffId("coach@example.test")]);
  const invM = (await one("insert into public.esa_invoices (child_id, enrollment_id, class_month, amount_cents, status, stripe_invoice_id, hosted_invoice_url) values ($1, $2, '2026-12-01', 10000, 'sent', 'in_m', 'https://invoice.stripe.com/i/m') returning id", [childM, eToday])).id;
  const invP = (await one("insert into public.esa_invoices (child_id, enrollment_id, class_month, amount_cents, status, stripe_invoice_id) values ($1, $2, '2026-12-01', 10000, 'sent', 'in_p') returning id", [childP, eP])).id;
  const feedM = (await one("insert into public.desk_feed (source_id, title, family_id, link) values ('t-m', 'Mesa asks', $1, 'https://mail.google.com/mail/u/0/#inbox/m') returning id", [M])).id;
  const feedP = (await one("insert into public.desk_feed (source_id, title, family_id, link) values ('t-p', 'Peoria asks', $1, 'https://mail.google.com/mail/u/0/#inbox/p') returning id", [P])).id;
  const feedNone = (await one("insert into public.desk_feed (source_id, title, family_id) values ('t-n', 'Someone asks', null) returning id")).id;
  await pg.query(`insert into public.classwallet_orders (order_no, order_date, student, submitted_cents, fee_cents, settlement_cents, family_id) values
    ('ORD-M', current_date - 5, 'Mia Mesa', 10000, 200, 9800, $1), ('ORD-P', current_date - 5, 'Pia Peoria', 10000, 200, 9800, $2)`, [M, P]);
  const dep = async (txn: string, order: string | null) => (await one("insert into public.classwallet_deposits (bank_txn_id, on_date, net_cents, gross_cents, fee_cents, order_no) values ($1, current_date - 2, 9800, 10000, 200, $2) returning id", [txn, order])).id;
  const depM = await dep("txn-m", "ORD-M"), depP = await dep("txn-p", "ORD-P"), depNone = await dep("txn-n", null);
  const attOld = (await one("insert into public.attendance (enrollment_id, on_date, status) values ($1, app.today_arizona() - 10, 'present') returning id", [eToday])).id;
  const sale = (await one("insert into public.store_sales (site_id, pay, status, total_cents) values ('mesa', 'card', 'waiting', 1000) returning id")).id;
  s = { today: t.today, dow: t.dow, otherDow, famM: M, famP: P, childM, childP, eToday, eAny, eDropped, eP, invM, invP, feedM, feedP, feedNone, depM, depP, depNone, attOld, sale, coachP: staffId("pcoach@example.test"), coach: staffId("coach@example.test") };
});

describe("F1: a new sign-in links to a staff row only when it was made from the Staff screen", () => {
  it("linked the five sign-ins stamped family_desk = staff", async () => {
    expect(await count("select count(*)::int as n from public.staff where user_id is not null")).toBe(5);
    expect((await one("select user_id from public.staff where email = 'lisa@example.test'")).user_id).toBe(UID.lisa);
  });
  it("refuses a user without the stamp, an anonymous one, and one whose email is not on the staff list", async () => {
    await refused("insert into auth.users (email, email_confirmed_at) values ('pcoach@example.test', now())").toThrow(/created from the Staff screen/);
    await refused("insert into auth.users (email, email_confirmed_at, raw_app_meta_data, is_anonymous) values ('pcoach@example.test', now(), '{\"family_desk\":\"staff\"}', true)").toThrow(/Anonymous sign-ins/);
    await refused("insert into auth.users (email, email_confirmed_at, raw_app_meta_data) values ('stranger@example.test', now(), '{\"family_desk\":\"staff\"}')").toThrow(/not on the HERO staff list/);
    expect(await count("select count(*)::int as n from auth.users")).toBe(5);
    expect((await one("select user_id from public.staff where email = 'pcoach@example.test'")).user_id).toBeNull();
  });
});

describe("F2: the inbox feed, ClassWallet receipts and deposits follow the admin's site", () => {
  it("an owner and an all-sites admin see every row", async () => {
    for (const who of ["owner", "lisa"] as const) {
      await as(who);
      expect(await count("select count(*)::int as n from public.desk_feed")).toBe(3);
      expect(await count("select count(*)::int as n from public.classwallet_orders")).toBe(2);
      expect(await count("select count(*)::int as n from public.classwallet_deposits")).toBe(3);
    }
  });
  it("a Mesa admin sees Mesa's rows and the rows tied to no family", async () => {
    await as("mary");
    expect(ids(await rows("select id from public.desk_feed"))).toEqual([s.feedM, s.feedNone].sort());
    expect((await rows("select order_no from public.classwallet_orders")).map((r) => r.order_no)).toEqual(["ORD-M"]);
    expect(ids(await rows("select id from public.classwallet_deposits"))).toEqual([s.depM, s.depNone].sort());
  });
  it("a Mesa admin ticks off Mesa's item and confirms Mesa's deposit, not Peoria's", async () => {
    await as("mary");
    expect(await changed("update public.desk_feed set status = 'done' where id = $1", [s.feedP])).toBe(0);
    expect(await changed("update public.desk_feed set status = 'done' where id = $1", [s.feedM])).toBe(1);
    expect(await changed("update public.classwallet_deposits set status = 'confirmed', esa_invoice_id = $2 where id = $1", [s.depP, s.invM])).toBe(0);
    expect(await changed("update public.classwallet_deposits set status = 'confirmed', esa_invoice_id = $2 where id = $1", [s.depM, s.invM])).toBe(1);
    await as("owner");
    expect((await one("select status, done_by from public.desk_feed where id = $1", [s.feedM])).done_by).not.toBeNull();
    expect((await one("select status from public.desk_feed where id = $1", [s.feedP])).status).toBe("open");
  });
  it("staff may change only the status of an inbox item, and the status, invoice and note of a deposit", async () => {
    await as("lisa");
    await refused("update public.desk_feed set title = 'x' where id = $1", [s.feedM]).toThrow(/permission denied/);
    await refused("update public.desk_feed set family_id = null where id = $1", [s.feedM]).toThrow(/permission denied/);
    await refused("update public.classwallet_deposits set net_cents = 1 where id = $1", [s.depM]).toThrow(/permission denied/);
    await refused("update public.classwallet_deposits set confirmed_by = null where id = $1", [s.depM]).toThrow(/permission denied/);
    expect(await changed("update public.classwallet_deposits set note = 'Looks like Mia' where id = $1", [s.depM])).toBe(1);
  });
  it("every change to a deposit is written to the audit log once, whichever column changed", async () => {
    await as("service");
    await pg.query("update public.classwallet_deposits set order_no = 'ORD-M' where id = $1", [s.depNone]);
    await as("lisa");
    await pg.query("update public.classwallet_deposits set note = 'seen' where id = $1", [s.depM]);
    await as("owner");
    expect(await count("select count(*)::int as n from public.audit_log where entity = 'classwallet_deposits' and entity_id = $1", [s.depNone])).toBe(1);
    expect(await count("select count(*)::int as n from public.audit_log where entity = 'classwallet_deposits' and entity_id = $1 and actor_email = 'lisa@example.test'", [s.depM])).toBe(1);
  });
});

describe("F3: an ESA invoice is paid only with a reason, and links point only where they should", () => {
  it("refuses a plain update to paid, for an admin and for the service key", async () => {
    await as("lisa");
    await refused("update public.esa_invoices set status = 'paid' where id = $1", [s.invM]).toThrow(/with a reason/);
    await as("service");
    await refused("update public.esa_invoices set status = 'paid' where id = $1", [s.invM]).toThrow(/with a reason/);
    await as("owner");
    expect((await one("select status from public.esa_invoices where id = $1", [s.invM])).status).toBe("sent");
  });
  it("Mark paid works and puts the reason in the log", async () => {
    await as("lisa");
    const r = await one("select (public.mark_esa_paid($1, 'ClassWallet deposit seen in the bank')).status as status", [s.invM]);
    expect(r.status).toBe("paid");
    await as("owner");
    const log = await one("select reason from public.audit_log where entity = 'esa_invoices' and entity_id = $1 and action = 'update' order by at desc limit 1", [s.invM]);
    expect(log.reason).toBe("ClassWallet deposit seen in the bank");
  });
  it("an invoice link must be Stripe's invoice page, an inbox link Gmail, a store link Stripe Checkout", async () => {
    await as("lisa");
    await refused("update public.esa_invoices set hosted_invoice_url = 'https://evil.example/pay' where id = $1", [s.invM]).toThrow(/esa_invoices_hosted_url_is_stripe/);
    expect(await changed("update public.esa_invoices set hosted_invoice_url = 'https://invoice.stripe.com/i/acct_1/test_2' where id = $1", [s.invM])).toBe(1);
    await as("service");
    await refused("update public.desk_feed set link = 'https://evil.example/' where id = $1", [s.feedM]).toThrow(/desk_feed_link_is_gmail/);
    expect(await changed("update public.desk_feed set link = 'https://mail.google.com/mail/u/0/#inbox/x' where id = $1", [s.feedM])).toBe(1);
    await refused("update public.store_sales set stripe_url = 'https://evil.example/' where id = $1", [s.sale]).toThrow(/store_sales_stripe_url_is_checkout/);
    expect(await changed("update public.store_sales set stripe_checkout_id = 'cs_test_1', stripe_url = 'https://checkout.stripe.com/c/pay/cs_test_1', stripe_live = false where id = $1", [s.sale])).toBe(1);
  });
});

describe("F4: a coach marks their own programs, recent days only, on the class day", () => {
  it("reads only the active enrollments of the programs they coach", async () => {
    await as("coach");
    expect(ids(await rows("select id from public.enrollments"))).toEqual([s.eToday, s.eAny].sort());
  });
  it("marks today, and up to seven days back on the program's class day", async () => {
    await as("coach");
    const mark = (e: string, offset: number) => pg.query("insert into public.attendance (enrollment_id, on_date, status) values ($1, app.today_arizona() + $2::int, 'present')", [e, offset]);
    await mark(s.eToday, 0);
    await mark(s.eToday, -7);                                                   // same weekday, inside the window
    await expect(mark(s.eToday, -1)).rejects.toThrow(/row-level security/);     // not that program's day
    await expect(mark(s.eToday, -14)).rejects.toThrow(/row-level security/);    // the class day, but too long ago
    await mark(s.eAny, -3);                                                     // no fixed day: any day in the window
    await expect(mark(s.eAny, -8)).rejects.toThrow(/row-level security/);
    await expect(mark(s.eAny, 1)).rejects.toThrow(/row-level security/);
    await expect(mark(s.eDropped, 0)).rejects.toThrow(/row-level security/);
    const marked = await one("select marked_by from public.attendance where enrollment_id = $1 and on_date = app.today_arizona()", [s.eToday]);
    expect(marked.marked_by).toBe(s.coach);
  });
  it("can't change or remove an old mark; an admin for the site can", async () => {
    await as("coach");
    expect(await changed("update public.attendance set status = 'absent' where id = $1", [s.attOld])).toBe(0);
    expect(await changed("delete from public.attendance where id = $1", [s.attOld])).toBe(0);
    await as("mary");
    expect(await changed("update public.attendance set status = 'absent' where id = $1", [s.attOld])).toBe(1);
  });
});

describe("F5: a site-pinned admin can't point a row at another site's records", () => {
  it("a child goes into a family at their site", async () => {
    await as("mary");
    await refused("insert into public.children (family_id, first_name, last_name, site_id) values ($1, 'Zed', 'Peoria', 'mesa')", [s.famP]).toThrow(/row-level security/);
    await pg.query("insert into public.children (family_id, first_name, last_name, site_id) values ($1, 'Zed', 'Mesa', 'mesa')", [s.famM]);
  });
  it("an enrollment goes into a program at their site", async () => {
    await as("mary");
    await refused("insert into public.enrollments (child_id, program_id) values ($1, 'peoria-today')", [s.childM]).toThrow(/row-level security/);
    await pg.query("insert into public.enrollments (child_id, program_id) values ($1, 'mesa-other')", [s.childM]);
  });
  it("an invoice names one of the child's own enrollments", async () => {
    await as("mary");
    await refused("insert into public.esa_invoices (child_id, enrollment_id, class_month, amount_cents) values ($1, $2, '2027-01-01', 10000)", [s.childM, s.eP]).toThrow(/row-level security/);
    await pg.query("insert into public.esa_invoices (child_id, enrollment_id, class_month, amount_cents) values ($1, $2, '2027-01-01', 10000)", [s.childM, s.eToday]);
  });
  it("a coach assignment names a staff member they may see; an all-sites admin may make it", async () => {
    await as("mary");
    await refused("insert into public.coach_assignments (staff_id, program_id) values ($1, 'mesa-today')", [s.coachP]).toThrow(/row-level security/);
    await as("lisa");
    await pg.query("insert into public.coach_assignments (staff_id, program_id) values ($1, 'mesa-today')", [s.coachP]);
  });
});

describe("F6: the anonymous role holds nothing, and new tables grant nothing by default", () => {
  it("anon can't read a table, a roster view, or call the profile function", async () => {
    await as("anon");
    for (const t of ["families", "programs", "children", "esa_invoices", "roster_families"]) {
      await refused(`select * from public.${t}`).toThrow(/permission denied/);
    }
    await refused("select public.my_profile()").toThrow(/permission denied/);
  });
  it("a table made after migration 0021 is closed to anon and authenticated until a grant says otherwise", async () => {
    await pg.exec("reset role");
    await pg.exec("create table public.zz_probe (id int)");
    try {
      await as("anon");
      await refused("select * from public.zz_probe").toThrow(/permission denied/);
      await as("lisa");
      await refused("select * from public.zz_probe").toThrow(/permission denied/);
    } finally {
      await pg.exec("reset role");
      await pg.exec("drop table public.zz_probe");
    }
  });
});

describe("F7: a site lead sees their site's roster, nothing more", () => {
  it("the full family, guardian and agreement tables, and money, are closed to them", async () => {
    await as("lead");
    for (const t of ["families", "guardians", "agreements", "esa_invoices", "desk_feed", "classwallet_deposits", "store_sales", "jackrabbit_history"]) {
      expect(await count(`select count(*)::int as n from public.${t}`), t).toBe(0);
    }
  });
  it("the roster views carry their site's families, and guardians' names and mobiles but no emails", async () => {
    await as("lead");
    const fams = await rows("select * from public.roster_families");
    expect(fams).toEqual([{ id: s.famM, name: "Mesa Family", site_id: "mesa", status: "active" }]);
    const gs = await rows("select * from public.roster_guardians");
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ family_id: s.famM, name: "Mesa Parent", mobile: "(480) 555-0100", is_primary: true });
    expect(Object.keys(gs[0]).sort()).toEqual(["family_id", "id", "is_primary", "mobile", "name"]);
    await refused("select email from public.roster_guardians").toThrow(/does not exist/);
  });
  it("children, active enrollments and attendance at their site", async () => {
    await as("lead");
    expect(ids(await rows("select id from public.children"))).toEqual([s.childM]);
    expect(ids(await rows("select id from public.enrollments"))).toEqual([s.eToday, s.eAny].sort());
    expect(ids(await rows("select id from public.attendance"))).toEqual([s.attOld]);
  });
  it("care notes only for a program at their site on its class day", async () => {
    await as("lead");
    expect(ids(await rows("select child_id as id from public.care_notes"))).toEqual([s.childM]);
    await pg.exec("reset role");
    await pg.query("update public.programs set weekday = $1 where id = 'mesa-today'", [s.otherDow]);
    await as("lead");
    expect(await count("select count(*)::int as n from public.care_notes")).toBe(0);
  });
  it("the roster views follow the same site rule for everyone else", async () => {
    await as("owner"); expect(await count("select count(*)::int as n from public.roster_families")).toBe(2);
    await as("lisa"); expect(await count("select count(*)::int as n from public.roster_families")).toBe(2);
    await as("mary"); expect(ids(await rows("select id from public.roster_families"))).toEqual([s.famM]);
    await as("coach"); expect(await count("select count(*)::int as n from public.roster_families")).toBe(0);
    await as("owner_aal1");
    expect(await count("select count(*)::int as n from public.roster_families")).toBe(0);
    expect(await count("select count(*)::int as n from public.families")).toBe(0);
  });
});
