// Uniform requests from the Family Hub. No sign-in: a parent gives the email on file and their child's first name,
// and only a child with an active class in that parent's family comes back. The request waits for staff in Family
// Desk. Everything here runs with the service key, so nothing is returned that the email and name don't unlock.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json } from "./_shared.ts";

const MAX_LINES = 6;

type Kid = { id: string; first_name: string; last_name: string; uniform_size: string | null; family_id: string; family_name: string; pay: "esa" | "card" | "jackrabbit"; esa_ok: boolean };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Send JSON" }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const first = String(body.child_first_name ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return json({ error: "Enter the email address on file with HERO." }, 400);
  if (!first || first.length > 60) return json({ error: "Enter your child's first name." }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // The children this email and first name unlock: in an active family with that guardian email, with an active class.
  async function unlock(): Promise<Kid[]> {
    const { data: guardians, error } = await db.from("guardians").select("family_id, families!inner(id, name, status, stripe_customer_id)").ilike("email", email);
    if (error) throw new Error(error.message);
    const fams = new Map<string, any>();
    for (const g of guardians ?? []) { const f = (g as any).families; if (f?.status === "active") fams.set(f.id, f); }
    if (!fams.size) return [];
    const { data: kids, error: kerr } = await db.from("children")
      .select("id, first_name, last_name, uniform_size, family_id, esa, active, enrollments(status, pay)")
      .in("family_id", [...fams.keys()]).eq("active", true);
    if (kerr) throw new Error(kerr.message);
    return (kids ?? []).filter((c: any) => c.first_name.trim().toLowerCase() === first && (c.enrollments ?? []).some((e: any) => e.status === "active")).map((c: any) => {
      const f = fams.get(c.family_id);
      const esaClass = c.esa && (c.enrollments ?? []).some((e: any) => e.status === "active" && e.pay === "esa");
      return { id: c.id, first_name: c.first_name, last_name: c.last_name, uniform_size: c.uniform_size, family_id: f.id, family_name: f.name, pay: !f.stripe_customer_id ? "jackrabbit" : esaClass ? "esa" : "card", esa_ok: esaClass };
    });
  }

  try {
    if (body.action === "lookup") {
      const kids = await unlock();
      if (!kids.length) return json({ error: "We couldn't find a child by that name with an active class under that email. Check the spelling, or ask the front desk which email is on file." }, 404);
      const { data: items, error } = await db.from("store_items").select("id, name, price_cents, sizes, colors, esa_ok, image_url, description, sort").eq("kind", "uniform").eq("active", true).order("sort").order("name");
      if (error) return json({ error: error.message }, 500);
      return json({ children: kids, items: items ?? [] });
    }

    if (body.action === "submit") {
      const kids = await unlock();
      const kid = kids.find((k) => k.id === String(body.child_id ?? ""));
      if (!kid) return json({ error: "That child isn't on file under this email, or has no active class." }, 404);
      const lines: any[] = Array.isArray(body.lines) ? body.lines : [];
      if (!lines.length) return json({ error: "Pick at least one uniform." }, 400);
      if (lines.length > MAX_LINES) return json({ error: `Up to ${MAX_LINES} lines per request, please.` }, 400);
      const { data: items, error } = await db.from("store_items").select("id, name, sizes, colors").eq("kind", "uniform").eq("active", true);
      if (error) return json({ error: error.message }, 500);
      const note = String(body.note ?? "").trim().slice(0, 300) || null;
      const rows: any[] = [];
      for (const l of lines) {
        const it = (items ?? []).find((i: any) => i.id === String(l.item_id ?? ""));
        if (!it) return json({ error: "One of those uniforms isn't available right now. Reload and try again." }, 400);
        const size = String(l.size ?? "").trim() || null, color = String(l.color ?? "").trim() || null;
        if (it.sizes.length && (!size || !it.sizes.includes(size))) return json({ error: `Pick a size for the ${it.name}.` }, 400);
        if (it.colors.length && (!color || !it.colors.includes(color))) return json({ error: `Pick a color for the ${it.name}.` }, 400);
        const quantity = Number(l.quantity ?? 1);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return json({ error: "Quantity must be 1 to 10." }, 400);
        rows.push({ family_id: kid.family_id, child_id: kid.id, item_id: it.id, item_name: it.name, size: it.sizes.length ? size : null, color: it.colors.length ? color : null, quantity, note, requested_by_email: email });
      }
      // A family asks once: the same lines again within a day are the same request, not a second one.
      const { data: open } = await db.from("uniform_requests").select("id").eq("child_id", kid.id).eq("status", "new");
      if ((open ?? []).length + rows.length > 12) return json({ error: "There are already several open requests for this child. The front desk will be in touch." }, 429);
      const { error: ierr } = await db.from("uniform_requests").insert(rows);
      if (ierr) return json({ error: ierr.message }, 500);
      return json({ ok: true, child: kid.first_name, pay: kid.pay, lines: rows.length });
    }

    return json({ error: "action must be lookup or submit" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
