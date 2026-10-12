// Kajabi access: keep the hubs on hero.training in step with Family Desk. Every guardian of an active family with a
// child in a class gets Family Hub Access; every active staff member gets Staff Hub Access; both are taken back
// when that stops being true. Works out the difference between what should be and what is (the kajabi_access
// ledger), then grants and revokes through Kajabi's public API. Owners and admins may run it; the app nudges it
// after family and staff changes, and an owner can run it from the Staff screen.
//
// Needs Kajabi API credentials in Supabase secrets (Kajabi: Settings → Public API): KAJABI_CLIENT_ID and
// KAJABI_CLIENT_SECRET. Until they are set, status says so and nothing is granted.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, userClient } from "./_shared.ts";

const SITE_ID = Deno.env.get("KAJABI_SITE_ID") || "2148781454";
const FAMILY_OFFER = Deno.env.get("KAJABI_FAMILY_OFFER_ID") || "2151417348";   // Family Hub Access: Family Hub + The Library
const STAFF_OFFER = Deno.env.get("KAJABI_STAFF_OFFER_ID") || "2151415672";     // Staff Hub Access: Staff Hub
const API = Deno.env.get("KAJABI_API") || "https://api.kajabi.com";
const MAX_PER_RUN = 40;   // grants and revokes per call, so a big catch-up spreads over a few runs

type Want = { email: string; name: string; kind: "family" | "staff"; offer_id: string };
type Ledger = { email: string; kind: string; offer_id: string; kajabi_contact_id: string | null; status: string };

// A thin Kajabi client: one token per call, JSON:API bodies.
class Kajabi {
  private token: string | null = null;
  constructor(private id: string, private secret: string) {}
  private async auth(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(`${API}/v1/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: this.id, client_secret: this.secret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Kajabi sign-in failed (${res.status}): ${data.error_description ?? data.error ?? "no token"}`);
    this.token = data.access_token;
    return this.token!;
  }
  async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, Accept: "application/vnd.api+json", ...(body ? { "Content-Type": "application/vnd.api+json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.errors?.map((e: any) => e.detail ?? e.title).join("; ") ?? data?.error ?? `Kajabi ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }
  async findContact(email: string): Promise<{ id: string } | null> {
    const q = new URLSearchParams({ "filter[site_id]": SITE_ID, "filter[search]": email, "page[size]": "20" });
    const data = await this.call("GET", `/v1/contacts?${q}`);
    const hit = (data?.data ?? []).find((c: any) => String(c.attributes?.email ?? "").toLowerCase() === email);
    return hit ? { id: String(hit.id) } : null;
  }
  async createContact(email: string, name: string): Promise<{ id: string }> {
    const data = await this.call("POST", "/v1/contacts", {
      data: { type: "contacts", attributes: { email, name }, relationships: { site: { data: { type: "sites", id: SITE_ID } } } },
    });
    return { id: String(data.data.id) };
  }
  grant(contactId: string, offerId: string) { return this.call("POST", `/v1/contacts/${contactId}/relationships/offers`, { data: [{ type: "offers", id: offerId }] }); }
  revoke(contactId: string, offerId: string) { return this.call("DELETE", `/v1/contacts/${contactId}/relationships/offers`, { data: [{ type: "offers", id: offerId }] }); }
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

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const clientId = Deno.env.get("KAJABI_CLIENT_ID") ?? "", clientSecret = Deno.env.get("KAJABI_CLIENT_SECRET") ?? "";
  const configured = !!clientId && !!clientSecret;

  // Who should have what, from Family Desk.
  async function wanted(): Promise<Want[]> {
    const out = new Map<string, Want>();
    const put = (w: Want) => { const email = w.email.trim().toLowerCase(); if (email) out.set(`${email}|${w.offer_id}`, { ...w, email }); };
    const { data: fams, error } = await admin.from("families").select("id, name, status, guardians(name, email), children(active, enrollments(status))");
    if (error) throw new Error(error.message);
    for (const f of fams ?? []) {
      if ((f as any).status !== "active") continue;
      const inClass = ((f as any).children ?? []).some((c: any) => c.active && (c.enrollments ?? []).some((e: any) => e.status === "active"));
      if (!inClass) continue;
      for (const g of (f as any).guardians ?? []) if (g.email) put({ email: g.email, name: g.name || (f as any).name, kind: "family", offer_id: FAMILY_OFFER });
    }
    const { data: people, error: serr } = await admin.from("staff").select("name, email, active");
    if (serr) throw new Error(serr.message);
    for (const p of people ?? []) if ((p as any).active && (p as any).email) put({ email: (p as any).email, name: (p as any).name, kind: "staff", offer_id: STAFF_OFFER });
    return [...out.values()];
  }
  async function ledger(): Promise<Ledger[]> {
    const { data, error } = await admin.from("kajabi_access").select("email, kind, offer_id, kajabi_contact_id, status");
    if (error) throw new Error(error.message);
    return (data ?? []) as Ledger[];
  }
  async function plan() {
    const [want, have] = await Promise.all([wanted(), ledger()]);
    const granted = new Set(have.filter((h) => h.status === "granted").map((h) => `${h.email}|${h.offer_id}`));
    const wantKeys = new Set(want.map((w) => `${w.email}|${w.offer_id}`));
    const toGrant = want.filter((w) => !granted.has(`${w.email}|${w.offer_id}`));
    const toRevoke = have.filter((h) => h.status === "granted" && !wantKeys.has(`${h.email}|${h.offer_id}`));
    return { want, have, toGrant, toRevoke };
  }

  try {
    if (body.action === "status" || body.action === "plan") {
      const p = await plan();
      const counts = { family: p.have.filter((h) => h.kind === "family" && h.status === "granted").length, staff: p.have.filter((h) => h.kind === "staff" && h.status === "granted").length, errors: p.have.filter((h) => h.status === "error").length };
      const out: any = { configured, counts, to_grant: p.toGrant.length, to_revoke: p.toRevoke.length };
      if (body.action === "plan") { out.grants = p.toGrant; out.revokes = p.toRevoke.map(({ email, kind, offer_id }) => ({ email, kind, offer_id })); }
      return json(out);
    }

    if (body.action === "sync") {
      if (!configured) return json({ error: "Kajabi isn't connected yet. Add KAJABI_CLIENT_ID and KAJABI_CLIENT_SECRET to Supabase secrets (Kajabi: Settings → Public API)." }, 503);
      const only = Array.isArray(body.emails) ? new Set(body.emails.map((e: unknown) => String(e).trim().toLowerCase())) : null;
      const p = await plan();
      const grants = p.toGrant.filter((w) => !only || only.has(w.email)).slice(0, MAX_PER_RUN);
      const revokes = p.toRevoke.filter((h) => !only || only.has(h.email)).slice(0, Math.max(0, MAX_PER_RUN - grants.length));
      const kajabi = new Kajabi(clientId, clientSecret);
      const done = { granted: [] as string[], revoked: [] as string[], failed: [] as { email: string; why: string }[] };
      const now = new Date().toISOString();
      const record = (row: Record<string, unknown>) => admin.from("kajabi_access").upsert({ ...row, synced_at: now }, { onConflict: "email,offer_id" });

      for (const w of grants) {
        try {
          const contact = (await kajabi.findContact(w.email)) ?? (await kajabi.createContact(w.email, w.name));
          await kajabi.grant(contact.id, w.offer_id);
          await record({ email: w.email, kind: w.kind, offer_id: w.offer_id, kajabi_contact_id: contact.id, status: "granted", granted_at: now, revoked_at: null, last_error: null });
          done.granted.push(w.email);
        } catch (e) {
          const why = (e as Error).message;
          await record({ email: w.email, kind: w.kind, offer_id: w.offer_id, status: "error", last_error: why });
          done.failed.push({ email: w.email, why });
        }
      }
      for (const h of revokes) {
        try {
          const contact = h.kajabi_contact_id ? { id: h.kajabi_contact_id } : await kajabi.findContact(h.email);
          if (contact) await kajabi.revoke(contact.id, h.offer_id);
          await record({ email: h.email, kind: h.kind, offer_id: h.offer_id, kajabi_contact_id: contact?.id ?? null, status: "revoked", revoked_at: now, last_error: null });
          done.revoked.push(h.email);
        } catch (e) {
          const why = (e as Error).message;
          await record({ email: h.email, kind: h.kind, offer_id: h.offer_id, status: "error", last_error: why });
          done.failed.push({ email: h.email, why });
        }
      }
      const remaining = p.toGrant.length + p.toRevoke.length - grants.length - revokes.length;
      return json({ ok: true, ...done, remaining });
    }

    return json({ error: "action must be status, plan or sync" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
