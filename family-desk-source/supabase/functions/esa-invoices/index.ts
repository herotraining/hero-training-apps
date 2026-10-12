// ESA invoices: create a class month's invoices in Stripe, or mark one paid (ClassWallet paid outside Stripe).
// Owners and admins only; row-level security on esa_invoices decides who may act on which child.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { cors, json, userClient, stripe, stripeKey } from "./_shared.ts";

const VENDOR = "Hero Training Center (HERO HQ LLC)";
const EIN = "93-1488714";
const FOOTER = "Hero Training Center · HERO HQ LLC · 14426 W Evans Dr, Surprise, AZ 85379 · EIN 93-1488714 · (602) 622-7662 · info@hero.llc";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Noon Arizona (UTC-7, no daylight saving) on a date, as unix seconds.
function noonArizona(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d, 19, 0, 0) / 1000);
}

type Uniform = { id: string; sale_id: string; name: string; size: string | null; quantity: number; unit_cents: number };

// Required uniforms bought on ESA at the front desk ride on the child's next invoice. Claiming them (tying each line
// to this invoice row) keeps another invoice from taking them too; if the invoice is then thrown away, the lines are
// let go automatically and wait for the next one.
async function claimUniforms(db: any, childId: string, invoiceId: string): Promise<Uniform[]> {
  const { data: pending, error } = await db
    .from("store_sale_lines")
    .select("id, store_sales!inner(pay, status)")
    .eq("child_id", childId)
    .is("esa_invoice_id", null)
    .eq("store_sales.pay", "esa")
    .eq("store_sales.status", "on_esa");
  if (error || !pending?.length) return [];
  const { data: claimed, error: cerr } = await db
    .from("store_sale_lines")
    .update({ esa_invoice_id: invoiceId })
    .in("id", pending.map((p: any) => p.id))
    .is("esa_invoice_id", null)
    .select("id, sale_id, name, size, quantity, unit_cents");
  return cerr ? [] : (claimed ?? []);
}

// A store sale is invoiced once every one of its uniforms is on an ESA invoice.
async function settleUniformSales(db: any, lines: Uniform[]) {
  for (const saleId of new Set(lines.map((l) => l.sale_id))) {
    const { count } = await db.from("store_sale_lines").select("id", { count: "exact", head: true }).eq("sale_id", saleId).is("esa_invoice_id", null);
    if (count === 0) await db.from("store_sales").update({ status: "invoiced" }).eq("id", saleId).eq("status", "on_esa");
  }
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

  const key = stripeKey();
  if (!key) return json({ error: "Stripe key not set in Supabase secrets" }, 503);

  try {
    if (body.action === "create") {
      const m = /^(\d{4})-(\d{2})$/.exec(String(body.class_month ?? ""));
      if (!m) return json({ error: "class_month must look like 2026-12" }, 400);
      const y = Number(m[1]), mo = Number(m[2]);
      if (mo < 1 || mo > 12) return json({ error: "class_month month out of range" }, 400);
      const classMonth = `${m[1]}-${m[2]}-01`;
      const label = `${MONTHS[mo - 1]} ${y}`;
      const dueDate = noonArizona(y, mo, 1);
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const periodStart = noonArizona(y, mo, 1);
      const periodEnd = noonArizona(y, mo, lastDay);

      // ESA enrollments the caller can see (RLS), optionally one family.
      let q = db
        .from("enrollments")
        .select("id, child_id, program_id, pay, status, children!inner(id, first_name, last_name, family_id, families!inner(id, name, stripe_customer_id, pay_method)), programs!inner(id, name, monthly_price_cents, stripe_product_id, site_id)")
        .eq("pay", "esa")
        .eq("status", "active");
      if (body.family_id) q = q.eq("children.family_id", String(body.family_id));
      const { data: enrs, error } = await q;
      if (error) return json({ error: error.message }, 400);

      const { data: existing } = await db.from("esa_invoices").select("child_id").eq("class_month", classMonth).neq("status", "void");
      const done = new Set((existing ?? []).map((r: any) => r.child_id));

      // One invoice per child per month (each child has their own ESA account), with a tuition line for every ESA
      // class the child is in.
      const byChild = new Map<string, { child: any; fam: any; classes: { enrollmentId: string; prog: any }[] }>();
      for (const e of enrs ?? []) {
        const child = (e as any).children;
        const entry = byChild.get(child.id) ?? { child, fam: child.families, classes: [] };
        entry.classes.push({ enrollmentId: (e as any).id, prog: (e as any).programs });
        byChild.set(child.id, entry);
      }

      const created: any[] = [], skipped: any[] = [];
      for (const { child, fam, classes } of byChild.values()) {
        const student = `${child.first_name} ${child.last_name.charAt(0)}`;
        if (done.has(child.id)) { skipped.push({ student, why: "already has an invoice for this month" }); continue; }
        if (!fam.stripe_customer_id) { skipped.push({ student, why: "family has no Stripe customer" }); continue; }
        classes.sort((a, b) => String(a.prog.name).localeCompare(String(b.prog.name)));
        const prog = classes[0].prog;
        const tuitionCents = classes.reduce((n, c) => n + c.prog.monthly_price_cents, 0);

        // Claim the slot first (unique on child + month), so two people can't both create it in Stripe.
        const { data: draft, error: derr } = await db.from("esa_invoices").insert({
          child_id: child.id, enrollment_id: classes[0].enrollmentId, class_month: classMonth, amount_cents: tuitionCents, status: "draft",
        }).select("id").single();
        if (derr) { skipped.push({ student, why: /duplicate|unique/i.test(derr.message) ? "already has an invoice for this month" : derr.message }); continue; }

        const uniforms = await claimUniforms(db, child.id, draft.id);
        const uniformCents = uniforms.reduce((n, l) => n + l.unit_cents * l.quantity, 0);

        let fin: any;
        try {
        const inv = await stripe(key, "POST", "/v1/invoices", {
          customer: fam.stripe_customer_id,
          collection_method: "send_invoice",
          due_date: dueDate,
          auto_advance: false,
          description: `Arizona ESA invoice for ${label} classes. In ClassWallet, choose Pay Vendor, select Hero Training Center, and upload this PDF. Please submit before ${MONTHS[mo - 1]} 1. Do not pay this invoice by card.`,
          footer: FOOTER,
          custom_fields: [
            { name: "Vendor", value: VENDOR },
            { name: "EIN", value: EIN },
            { name: "Student", value: student },
            { name: "Class month", value: label },
          ],
          metadata: { esa: "true", family: fam.name, student, class_month: `${m[1]}-${m[2]}`, site: prog.site_id, child_id: child.id },
        });
        for (const c of classes) {
          await stripe(key, "POST", "/v1/invoiceitems", {
            customer: fam.stripe_customer_id,
            invoice: inv.id,
            amount: c.prog.monthly_price_cents,
            currency: "usd",
            description: `${c.prog.name}: ${student}, ${label} tuition`,
            period: { start: periodStart, end: periodEnd },
            metadata: { student },
          });
        }
        for (const u of uniforms) {
          await stripe(key, "POST", "/v1/invoiceitems", {
            customer: fam.stripe_customer_id,
            invoice: inv.id,
            amount: u.unit_cents * u.quantity,
            currency: "usd",
            description: `${u.name}${u.size ? ` (${u.size})` : ""}${u.quantity > 1 ? ` × ${u.quantity}` : ""}: ${student}, required HERO uniform`,
            metadata: { student, store_line: u.id },
          });
        }
        fin = await stripe(key, "POST", `/v1/invoices/${inv.id}/finalize`, { auto_advance: false });
        } catch (serr) {
          // Throwing the slot away also lets go of any uniforms claimed for it.
          await db.from("esa_invoices").delete().eq("id", draft.id);
          skipped.push({ student, why: `Stripe refused: ${(serr as Error).message}` }); continue;
        }

        const { error: ierr } = await db.from("esa_invoices").update({
          amount_cents: tuitionCents + uniformCents,
          stripe_invoice_id: fin.id,
          hosted_invoice_url: fin.hosted_invoice_url,
          status: "sent",
          sent_at: new Date().toISOString(),
        }).eq("id", draft.id);
        if (ierr) { skipped.push({ student, why: `Stripe invoice ${fin.id} made but not recorded: ${ierr.message}` }); continue; }
        await settleUniformSales(db, uniforms);
        done.add(child.id);
        created.push({ student, family: fam.name, amount: tuitionCents + uniformCents, classes: classes.length, uniforms: uniforms.reduce((n, u) => n + u.quantity, 0), invoice: fin.id, url: fin.hosted_invoice_url });
      }
      return json({ class_month: label, created, skipped });
    }

    if (body.action === "mark_paid") {
      const id = String(body.esa_invoice_id ?? ""), reason = String(body.reason ?? "").trim();
      if (!id || !reason) return json({ error: "esa_invoice_id and reason are required" }, 400);
      const { data: row, error } = await db.from("esa_invoices").select("id, stripe_invoice_id, status").eq("id", id).maybeSingle();
      if (error) return json({ error: error.message }, 400);
      if (!row) return json({ error: "Invoice not found, or not yours to change" }, 404);
      if (row.status === "paid") return json({ ok: true, note: "Already paid" });
      if (row.stripe_invoice_id) {
        const inv = await stripe(key, "GET", `/v1/invoices/${row.stripe_invoice_id}`);
        if (inv.status === "open") await stripe(key, "POST", `/v1/invoices/${row.stripe_invoice_id}/pay`, { paid_out_of_band: true });
        else if (inv.status !== "paid") return json({ error: `Stripe invoice is ${inv.status}; only an open invoice can be marked paid` }, 409);
      }
      const { data: updated, error: uerr } = await db.rpc("mark_esa_paid", { p_id: id, p_reason: reason });
      if (uerr) return json({ error: `Stripe shows paid but Family Desk did not record it: ${uerr.message}` }, 500);
      // When the payment was confirmed from a ClassWallet bank deposit, tie the deposit to the invoice (RLS: owners and admins).
      const depositId = String(body.classwallet_deposit_id ?? "");
      if (depositId) {
        const { error: derr } = await db.from("classwallet_deposits").update({ status: "confirmed", esa_invoice_id: id }).eq("id", depositId).eq("status", "new");
        if (derr) return json({ ok: true, invoice: updated, note: `Invoice marked paid, but the deposit was not tied to it: ${derr.message}` });
      }
      return json({ ok: true, invoice: updated });
    }

    return json({ error: "action must be create or mark_paid" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
