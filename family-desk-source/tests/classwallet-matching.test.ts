// ClassWallet receipts to bank deposits (app.link_classwallet_orders, migration 0012). The function's SQL is read
// straight from the migration file and run in PGlite, a Postgres that lives inside the test process, over a few
// tables shaped like the real ones and filled with made-up families. Nothing connects to the live database.
//
// The rule under test: a receipt names the deposit with the same settled amount that lands 0 to 10 days after the
// order, nearest first, one deposit per receipt. The receipt is also tied to a family and child where it can be.
//
// Tests written with it.fails describe what the code should do but currently doesn't: each one is a bug the tests
// found. They pass while the bug is there; once it is fixed, switch them to plain it().
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20261011_0012_link_classwallet_orders.sql", import.meta.url), "utf8");
const linkFunction = /create or replace function app\.link_classwallet_orders\(\)[\s\S]*?\nend \$\$;/.exec(migration)?.[0];

// Only the columns the function reads or writes, with the same names and types as the migrations.
const schema = `
  create schema app;
  create table families (id uuid primary key default gen_random_uuid(), name text not null, status text not null default 'active');
  create table guardians (id uuid primary key default gen_random_uuid(), family_id uuid not null references families(id), email text);
  create table children (id uuid primary key default gen_random_uuid(), family_id uuid not null references families(id), first_name text not null, last_name text not null);
  create table classwallet_orders (
    order_no text primary key, order_date date not null, student text not null, parent_email text,
    submitted_cents integer not null, fee_cents integer not null, settlement_cents integer not null,
    family_id uuid references families(id) on delete set null, child_id uuid references children(id) on delete set null);
  create table classwallet_deposits (
    id uuid primary key default gen_random_uuid(), bank_txn_id text not null unique, on_date date not null,
    net_cents integer not null, gross_cents integer not null, fee_cents integer not null,
    status text not null default 'new', order_no text references classwallet_orders(order_no) on delete set null);
`;

let pg: PGlite;
beforeAll(async () => {
  expect(linkFunction, "could not find app.link_classwallet_orders in migration 0012").toBeTruthy();
  pg = new PGlite();
  await pg.exec(schema);
  await pg.exec(linkFunction!);
});
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec("truncate classwallet_deposits, classwallet_orders, children, guardians, families cascade");
});

// Dates are given as days from today, because the function only looks at receipts from the last 45 days.
const day = (offset: number) => `current_date + ${offset}`;

// A receipt for an ESA order: $submitted less ClassWallet's 2% settles to the bank.
async function receipt(orderNo: string, daysAgo: number, settlementCents: number, extra: { student?: string; parent_email?: string } = {}) {
  const fee = Math.round(settlementCents / 0.98) - settlementCents;
  await pg.query(
    `insert into classwallet_orders (order_no, order_date, student, parent_email, submitted_cents, fee_cents, settlement_cents)
     values ($1, ${day(-daysAgo)}, $2, $3, $4, $5, $6)`,
    [orderNo, extra.student ?? "Ava Tester", extra.parent_email ?? null, settlementCents + fee, fee, settlementCents],
  );
}

async function deposit(txn: string, daysAgo: number, netCents: number) {
  const gross = Math.round(netCents / 0.98);
  await pg.query(
    `insert into classwallet_deposits (bank_txn_id, on_date, net_cents, gross_cents, fee_cents) values ($1, ${day(-daysAgo)}, $2, $3, $4)`,
    [txn, netCents, gross, gross - netCents],
  );
}

async function link() {
  const r = await pg.query<{ r: { families_linked: number; children_linked: number; deposits_named: number } }>("select app.link_classwallet_orders() as r");
  return r.rows[0].r;
}

// bank_txn_id -> order_no it was named for (or null).
async function named(): Promise<Record<string, string | null>> {
  const r = await pg.query<{ bank_txn_id: string; order_no: string | null }>("select bank_txn_id, order_no from classwallet_deposits order by bank_txn_id");
  return Object.fromEntries(r.rows.map((x) => [x.bank_txn_id, x.order_no]));
}

describe("receipt to deposit", () => {
  it("names the deposit with the same settled amount a few days after the order", async () => {
    await receipt("CW-1", 20, 24500);
    await deposit("txn-a", 17, 24500);
    expect((await link()).deposits_named).toBe(1);
    expect(await named()).toEqual({ "txn-a": "CW-1" });
  });

  it("needs the amount to match to the cent", async () => {
    await receipt("CW-1", 20, 24500);
    await deposit("txn-a", 17, 24499);
    await deposit("txn-b", 17, 24501);
    expect((await link()).deposits_named).toBe(0);
    expect(await named()).toEqual({ "txn-a": null, "txn-b": null });
  });

  it("compares the settled amount, not what the family submitted", async () => {
    await receipt("CW-1", 20, 24500); // submitted $250.00
    await deposit("txn-a", 17, 25000);
    expect((await link()).deposits_named).toBe(0);
  });

  it.each([
    [0, true], [1, true], [10, true], [11, false], [-1, false],
  ])("a deposit %i days after the order: named = %s", async (after, expected) => {
    await receipt("CW-1", 30, 24500);
    await deposit("txn-a", 30 - after, 24500);
    await link();
    expect((await named())["txn-a"]).toBe(expected ? "CW-1" : null);
  });

  it("takes the nearest deposit when more than one fits", async () => {
    await receipt("CW-1", 20, 24500);
    await deposit("txn-far", 12, 24500); // 8 days after
    await deposit("txn-near", 18, 24500); // 2 days after
    await link();
    expect(await named()).toEqual({ "txn-far": null, "txn-near": "CW-1" });
  });

  it("breaks a same-day tie by bank transaction id, so reruns agree", async () => {
    await receipt("CW-1", 20, 24500);
    await deposit("txn-b", 17, 24500);
    await deposit("txn-a", 17, 24500);
    await link();
    expect(await named()).toEqual({ "txn-a": "CW-1", "txn-b": null });
  });

  it("gives one deposit to one receipt, even when two receipts fit it", async () => {
    await receipt("CW-1", 20, 24500, { student: "Ava Tester" });
    await receipt("CW-2", 19, 24500, { student: "Ben Tester" });
    await deposit("txn-a", 17, 24500);
    expect((await link()).deposits_named).toBe(1);
    expect(await named()).toEqual({ "txn-a": "CW-1" }); // the earlier order goes first
  });

  it("pairs two same-amount orders with two deposits, earlier order first", async () => {
    await receipt("CW-1", 20, 24500, { student: "Ava Tester" });
    await receipt("CW-2", 15, 24500, { student: "Ben Tester" });
    await deposit("txn-a", 18, 24500);
    await deposit("txn-b", 13, 24500);
    expect((await link()).deposits_named).toBe(2);
    expect(await named()).toEqual({ "txn-a": "CW-1", "txn-b": "CW-2" });
  });

  it("keeps going to the next nearest when the nearest is taken", async () => {
    await receipt("CW-1", 20, 24500);
    await receipt("CW-2", 20, 24500);
    await deposit("txn-a", 19, 24500);
    await deposit("txn-b", 14, 24500);
    await link();
    expect(await named()).toEqual({ "txn-a": "CW-1", "txn-b": "CW-2" });
  });

  it("matches each amount separately", async () => {
    await receipt("CW-1", 20, 24500);
    await receipt("CW-2", 20, 17640);
    await deposit("txn-a", 18, 17640);
    await deposit("txn-b", 18, 24500);
    await link();
    expect(await named()).toEqual({ "txn-a": "CW-2", "txn-b": "CW-1" });
  });

  it("never renames a deposit already named, or names a second deposit for a receipt", async () => {
    await receipt("CW-1", 20, 24500);
    await receipt("CW-2", 20, 24500);
    await deposit("txn-a", 19, 24500);
    await pg.query("update classwallet_deposits set order_no = 'CW-2' where bank_txn_id = 'txn-a'");
    await deposit("txn-b", 18, 24500);
    await link();
    expect(await named()).toEqual({ "txn-a": "CW-2", "txn-b": "CW-1" });
  });

  it("is safe to run every morning: a second run changes nothing", async () => {
    await receipt("CW-1", 20, 24500);
    await deposit("txn-a", 17, 24500);
    await deposit("txn-b", 16, 24500);
    expect((await link()).deposits_named).toBe(1);
    const first = await named();
    expect((await link()).deposits_named).toBe(0);
    expect(await named()).toEqual(first);
  });

  it("names a deposit that arrives on a later morning", async () => {
    await receipt("CW-1", 5, 24500);
    expect((await link()).deposits_named).toBe(0);
    await deposit("txn-a", 2, 24500);
    expect((await link()).deposits_named).toBe(1);
  });

  it("leaves receipts older than 45 days alone", async () => {
    await receipt("CW-old", 46, 24500);
    await deposit("txn-a", 44, 24500);
    await receipt("CW-edge", 45, 17640);
    await deposit("txn-b", 44, 17640);
    await link();
    expect(await named()).toEqual({ "txn-a": null, "txn-b": "CW-edge" });
  });
});

describe("receipt to family and child", () => {
  async function family(name: string, status = "active") {
    return (await pg.query<{ id: string }>("insert into families (name, status) values ($1, $2) returning id", [name, status])).rows[0].id;
  }
  async function guardian(familyId: string, email: string) {
    await pg.query("insert into guardians (family_id, email) values ($1, $2)", [familyId, email]);
  }
  async function child(familyId: string, first: string, last: string) {
    return (await pg.query<{ id: string }>("insert into children (family_id, first_name, last_name) values ($1, $2, $3) returning id", [familyId, first, last])).rows[0].id;
  }
  async function order(orderNo: string) {
    return (await pg.query<{ family_id: string | null; child_id: string | null }>("select family_id, child_id from classwallet_orders where order_no = $1", [orderNo])).rows[0];
  }

  it("finds the family by the parent's email and the child by first name", async () => {
    const fam = await family("Tester");
    await guardian(fam, "parent@example.test");
    const ava = await child(fam, "Ava", "Tester");
    await child(fam, "Ben", "Tester");
    await receipt("CW-1", 10, 24500, { student: "Ava T.", parent_email: "parent@example.test" });
    const r = await link();
    expect(r).toMatchObject({ families_linked: 1, children_linked: 1 });
    expect(await order("CW-1")).toEqual({ family_id: fam, child_id: ava });
  });

  it("prefers the active family when an email is on more than one", async () => {
    const old = await family("Tester (old)", "inactive");
    const cur = await family("Tester", "active");
    await guardian(old, "parent@example.test");
    await guardian(cur, "parent@example.test");
    await receipt("CW-1", 10, 24500, { parent_email: "parent@example.test" });
    await link();
    expect((await order("CW-1")).family_id).toBe(cur);
  });

  it("matches a guardian email typed with capitals", async () => {
    const fam = await family("Tester");
    await guardian(fam, "Parent@Example.test");
    await receipt("CW-1", 10, 24500, { parent_email: "parent@example.test" });
    await link();
    expect((await order("CW-1")).family_id).toBe(fam);
  });

  it.fails("BUG: matches a receipt whose parent email has capitals", async () => {
    // Guardian emails are lowercased before comparing, but the receipt's parent_email is not, so a receipt for
    // "Parent@Example.test" never finds its family.
    const fam = await family("Tester");
    await guardian(fam, "parent@example.test");
    await receipt("CW-1", 10, 24500, { parent_email: "Parent@Example.test" });
    await link();
    expect((await order("CW-1")).family_id).toBe(fam);
  });

  it("leaves the child blank when two children in the family share the first name", async () => {
    const fam = await family("Tester");
    await guardian(fam, "parent@example.test");
    await child(fam, "Sam", "Tester");
    await child(fam, "Sam", "Tester-Jones");
    await receipt("CW-1", 10, 24500, { student: "Sam", parent_email: "parent@example.test" });
    await link();
    expect(await order("CW-1")).toEqual({ family_id: fam, child_id: null });
  });

  it("falls back to a full name that only one child has, and fills in the family", async () => {
    const fam = await family("Tester");
    const ava = await child(fam, "Ava", "Tester");
    await receipt("CW-1", 10, 24500, { student: "ava tester" });
    await link();
    expect(await order("CW-1")).toEqual({ family_id: fam, child_id: ava });
  });

  it("does not guess when two children anywhere share the full name", async () => {
    await child(await family("Tester"), "Ava", "Tester");
    await child(await family("Tester two"), "Ava", "Tester");
    await receipt("CW-1", 10, 24500, { student: "Ava Tester" });
    await link();
    expect(await order("CW-1")).toEqual({ family_id: null, child_id: null });
  });

  it("does not take a full-name match from a different family than the email found", async () => {
    const byEmail = await family("Tester");
    await guardian(byEmail, "parent@example.test");
    await child(await family("Other"), "Ava", "Tester");
    await receipt("CW-1", 10, 24500, { student: "Ava Tester", parent_email: "parent@example.test" });
    await link();
    expect(await order("CW-1")).toEqual({ family_id: byEmail, child_id: null });
  });
});
