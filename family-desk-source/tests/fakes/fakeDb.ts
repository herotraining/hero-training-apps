// A small in-memory stand-in for the Supabase client, covering only the query shapes the edge functions use:
// from().select/insert/update/delete with eq, neq, is, in, not, gte, limit, single, maybeSingle, a head count, and rpc().
// Embedded filters such as "children.family_id" read the joined row, like PostgREST's !inner joins.
// It keeps the database rules the money code leans on: one live ESA invoice per child per class month, a uniform
// line lets go of its invoice when that invoice row is deleted, and the store's card-sale rules from
// app.stamp_store_sale (a staff session can't set the Stripe page or settle a card sale; the service key can).
// Row-level security is not modelled.

type Row = Record<string, any>;
type Filter = { op: "eq" | "neq" | "is" | "in" | "not_is" | "gte"; col: string; val: any };
type Result = { data: any; error: { message: string } | null; count?: number | null };

export type Profile = { staff: { id?: string; role: string } | null; aal: string };

let seq = 0;
export const newId = (prefix = "row") => `${prefix}-${++seq}`;

export class FakeDb {
  tables: Record<string, Row[]> = {
    sites: [], families: [], children: [], programs: [], enrollments: [],
    esa_invoices: [], store_items: [], store_sales: [], store_sale_lines: [], classwallet_deposits: [],
  };
  profile: Profile = { staff: { id: "staff-owner", role: "owner" }, aal: "aal2" };
  calls: { table: string; op: string; filters: Filter[]; payload?: any; trusted: boolean }[] = [];
  rpcCalls: { name: string; args: any }[] = [];
  private failures: { table: string; op: string; message: string }[] = [];

  // The next matching call returns this error instead of touching the data.
  failNext(table: string, op: "select" | "insert" | "update" | "delete" | "rpc", message: string) {
    this.failures.push({ table, op, message });
  }

  insertRow(table: string, row: Row): Row {
    const full = { id: newId(table), ...row };
    this.tables[table].push(full);
    return full;
  }

  find(table: string, id: string): Row | undefined {
    return this.tables[table].find((r) => r.id === id);
  }

  client(trusted = false) {
    return {
      from: (table: string) => new Query(this, table, trusted),
      rpc: async (name: string, args: any = {}): Promise<Result> => {
        this.rpcCalls.push({ name, args });
        const fail = this.takeFailure(name, "rpc");
        if (fail) return { data: null, error: { message: fail } };
        if (name === "my_profile") return { data: this.profile, error: null };
        if (name === "mark_esa_paid") return this.markEsaPaid(args.p_id, args.p_reason);
        if (name === "store_create_sale") return this.storeCreateSale(args);
        return { data: null, error: { message: `fake rpc ${name} not modelled` } };
      },
    };
  }

  takeFailure(table: string, op: string): string | null {
    const i = this.failures.findIndex((f) => f.table === table && f.op === op);
    if (i < 0) return null;
    return this.failures.splice(i, 1)[0].message;
  }

  // Mirrors public.mark_esa_paid (migration 0004): only an open invoice can be marked paid.
  private markEsaPaid(id: string, reason: string): Result {
    if (!reason) return { data: null, error: { message: "A reason is required." } };
    const row = this.find("esa_invoices", id);
    if (!row || !["sent", "submitted", "rejected"].includes(row.status)) {
      return { data: null, error: { message: "Invoice not found, not open, or not yours to change." } };
    }
    row.status = "paid";
    row.paid_at = new Date().toISOString();
    return { data: { ...row }, error: null };
  }

  // Mirrors the parts of public.store_create_sale (migration 0014) the store function relies on: prices come from
  // the price list, a card sale starts "waiting", and Stripe won't take under $0.50. The full rules are tested
  // against the real SQL in store-rules.test.ts.
  private storeCreateSale(a: any): Result {
    const err = (message: string): Result => ({ data: null, error: { message } });
    if (!this.tables.sites.some((s) => s.id === a.p_site)) return err("Pick a site.");
    const lines: any[] = Array.isArray(a.p_lines) ? a.p_lines : [];
    if (!lines.length) return err("Add at least one item.");
    let total = 0;
    const built: Row[] = [];
    for (const l of lines) {
      const it = this.tables.store_items.find((i) => i.id === l.item_id && i.active !== false);
      if (!it) return err("An item in the cart is no longer for sale. Remove it and add it again.");
      const q = l.quantity ?? 1;
      total += it.price_cents * q;
      built.push({ item_id: it.id, child_id: l.child_id ?? null, name: it.name, size: l.size ?? null, color: l.color ?? null, quantity: q, unit_cents: it.price_cents });
    }
    if (a.p_pay === "card" && !a.p_card_tapped && total < 50) return err("Stripe can't take a card payment under $0.50.");
    const status = a.p_pay === "card" ? (a.p_card_tapped ? "done" : "waiting") : a.p_pay === "esa" ? "on_esa" : "done";
    const sale = this.insertRow("store_sales", {
      family_id: a.p_family ?? null, site_id: a.p_site, pay: a.p_pay, status, total_cents: total, note: a.p_note ?? null,
      stripe_checkout_id: null, stripe_url: null, stripe_live: null, sold_by: this.profile.staff?.id ?? null, settled_by: null, paid_at: null,
      created_at: new Date().toISOString(),
    });
    for (const b of built) this.insertRow("store_sale_lines", { sale_id: sale.id, esa_invoice_id: null, ...b });
    return { data: { ...sale }, error: null };
  }

  // app.stamp_store_sale, as far as the store function can run into it. Returns an error message or null.
  storeSaleUpdateRule(old: Row, patch: Row, trusted: boolean): string | null {
    if (!trusted) {
      for (const k of ["stripe_checkout_id", "stripe_url", "stripe_live"]) {
        if (k in patch && patch[k] !== old[k]) return "Only the Store's payment step sets the Stripe payment page.";
      }
      if (old.pay === "card" && "status" in patch && patch.status !== old.status
          && !(old.status === "waiting" && patch.status === "void" && old.stripe_checkout_id === null)) {
        return "A card sale is settled through Stripe from the Store screen.";
      }
    }
    if (old.status === "void" && "status" in patch && patch.status !== "void") return "A voided sale stays void. Ring it up again instead.";
    if (old.pay === "card" && old.status === "done" && patch.status === "void") return "This card payment went through. Refund it in Stripe instead.";
    return null;
  }

  // Joined rows a select can embed (and filter on), by table.
  embeds(table: string, row: Row): Row {
    if (table === "enrollments") {
      const child = this.find("children", row.child_id);
      const fam = child && this.find("families", child.family_id);
      return {
        children: child ? { ...child, families: fam ? { ...fam } : null } : null,
        programs: this.tables.programs.find((p) => p.id === row.program_id) ?? null,
      };
    }
    if (table === "store_sale_lines") return { store_sales: this.find("store_sales", row.sale_id) ?? null };
    if (table === "store_sales") return { lines: this.tables.store_sale_lines.filter((l) => l.sale_id === row.id).map((l) => ({ ...l })) };
    return {};
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private payload: any;
  private returning = false;
  private singleMode: "one" | "maybe" | null = null;
  private head = false;
  private max: number | null = null;

  constructor(private db: FakeDb, private table: string, private trusted: boolean) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.head = !!opts?.head;
    else this.returning = true;
    return this;
  }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: any) { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: any) { this.filters.push({ op: "neq", col, val }); return this; }
  is(col: string, val: any) { this.filters.push({ op: "is", col, val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ op: "in", col, val }); return this; }
  gte(col: string, val: any) { this.filters.push({ op: "gte", col, val }); return this; }
  not(col: string, op: string, val: any) {
    if (op !== "is") throw new Error(`fake db: .not() only models "is", got ${op}`);
    this.filters.push({ op: "not_is", col, val }); return this;
  }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "one"; return this; }

  then<A = Result, B = never>(ok?: ((r: Result) => A | PromiseLike<A>) | null, bad?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }

  private value(row: Row, col: string) {
    if (!col.includes(".")) return row[col];
    const [embed, field] = col.split(".");
    return this.db.embeds(this.table, row)[embed]?.[field];
  }

  private matches(row: Row) {
    return this.filters.every((f) => {
      const v = this.value(row, f.col);
      if (f.op === "eq") return v === f.val;
      if (f.op === "neq") return v !== f.val;
      if (f.op === "is") return (v ?? null) === f.val;
      if (f.op === "not_is") return (v ?? null) !== f.val;
      if (f.op === "gte") return v >= f.val;
      return f.val.includes(v);
    });
  }

  private shape(rows: Row[]): Result {
    const out = rows.map((r) => ({ ...r, ...this.db.embeds(this.table, r) }));
    if (this.singleMode === null) return { data: out, error: null };
    if (out.length > 1) return { data: null, error: { message: "More than one row returned" } };
    if (out.length === 0 && this.singleMode === "one") return { data: null, error: { message: "No rows returned" } };
    return { data: out[0] ?? null, error: null };
  }

  private run(): Result {
    const { db, table } = this;
    db.calls.push({ table, op: this.op, filters: this.filters, payload: this.payload, trusted: this.trusted });
    const fail = db.takeFailure(table, this.op);
    if (fail) return { data: null, error: { message: fail } };
    const rows = db.tables[table];
    if (!rows) return { data: null, error: { message: `relation "${table}" does not exist` } };

    if (this.op === "select") {
      let found = rows.filter((r) => this.matches(r));
      if (this.max !== null) found = found.slice(0, this.max);
      if (this.head) return { data: null, error: null, count: found.length };
      return this.shape(found);
    }

    if (this.op === "insert") {
      const row = { id: newId(table), ...this.payload };
      // Mirrors esa_invoices_live_child_month (migration 0016): one live invoice per child per month; void ones don't count.
      if (table === "esa_invoices" && row.status !== "void" && rows.some((r) => r.child_id === row.child_id && r.class_month === row.class_month && r.status !== "void")) {
        return { data: null, error: { message: 'duplicate key value violates unique constraint "esa_invoices_live_child_month"' } };
      }
      rows.push(row);
      return this.shape([row]);
    }

    if (this.op === "update") {
      const hit = rows.filter((r) => this.matches(r));
      if (table === "store_sales") {
        for (const r of hit) {
          const why = db.storeSaleUpdateRule(r, this.payload, this.trusted);
          if (why) return { data: null, error: { message: why } };
        }
      }
      for (const r of hit) {
        Object.assign(r, this.payload);
        if (table === "store_sales" && r.status === "done" && ["card", "cash", "free"].includes(r.pay) && !r.paid_at) r.paid_at = new Date().toISOString();
      }
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }

    const gone = rows.filter((r) => this.matches(r));
    db.tables[table] = rows.filter((r) => !gone.includes(r));
    if (table === "esa_invoices") {
      for (const line of db.tables.store_sale_lines) if (gone.some((g) => g.id === line.esa_invoice_id)) line.esa_invoice_id = null;
      for (const dep of db.tables.classwallet_deposits) if (gone.some((g) => g.id === dep.esa_invoice_id)) dep.esa_invoice_id = null;
    }
    return this.returning ? this.shape(gone) : { data: null, error: null };
  }
}
