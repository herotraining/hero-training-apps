import type { Api } from "./api";
import { supabase, functionsUrl } from "./supabase";
import type { Family, Program, RosterRow } from "../types";

async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const sb = supabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(functionsUrl(name), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? json?.note ?? `Request failed (${res.status})`);
  return json as T;
}

const FAMILY_SELECT = `id, name, site_id, pay_method, stripe_customer_id, city, zip, text_consent, notes, status,
  guardians(id, family_id, name, email, mobile, is_primary),
  children(id, family_id, first_name, last_name, birth_date, site_id, uniform_size, esa, house, active,
    care:care_notes(child_id, allergies, medications, emergency_contacts, authorized_pickups, notes),
    enrollments(id, child_id, program_id, status, pay, start_date, program:programs(id, name, kind, site_id, weekday, start_time, end_time, monthly_price_cents))),
  agreements(id, kind, signed_at, signed_by)`;

function shapeFamily(f: any): Family {
  return {
    ...f,
    children: (f.children ?? []).map((c: any) => ({ ...c, care: Array.isArray(c.care) ? c.care[0] ?? null : c.care ?? null })),
  };
}

export function supabaseApi(): Api {
  const sb = supabase();
  const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

  return {
    mock: false,
    async profile() {
      const { data, error } = await sb.rpc("my_profile");
      fail(error);
      return { staff: data?.staff ?? null, aal: data?.aal ?? null };
    },
    async sites() { const { data, error } = await sb.from("sites").select("*").order("name"); fail(error); return data ?? []; },
    async programs() { const { data, error } = await sb.from("programs").select("*").eq("active", true).order("weekday").order("start_time"); fail(error); return data ?? []; },
    async families() {
      const { data, error } = await sb.from("families").select(FAMILY_SELECT).order("name");
      fail(error);
      return (data ?? []).map(shapeFamily);
    },
    async family(id) {
      const { data, error } = await sb.from("families").select(FAMILY_SELECT).eq("id", id).maybeSingle();
      fail(error);
      return data ? shapeFamily(data) : null;
    },
    async rosterFor(weekday) {
      const { data: programs, error } = await sb.from("programs").select("*").eq("active", true).eq("weekday", weekday).order("start_time");
      fail(error);
      if (!programs?.length) return [];
      const ids = programs.map((p: Program) => p.id);
      const { data: enrs, error: e2 } = await sb
        .from("enrollments")
        .select("id, child_id, program_id, status, pay, start_date, child:children(id, family_id, first_name, last_name, birth_date, site_id, uniform_size, esa, house, active, care:care_notes(child_id, allergies, medications, emergency_contacts, authorized_pickups, notes))")
        .in("program_id", ids)
        .eq("status", "active");
      fail(e2);
      return programs.map((program: Program) => ({
        program,
        rows: (enrs ?? [])
          .filter((e: any) => e.program_id === program.id && e.child)
          .map((e: any): RosterRow => ({ enrollment: e, child: { ...e.child, care: Array.isArray(e.child.care) ? e.child.care[0] ?? null : e.child.care ?? null } }))
          .sort((a: RosterRow, b: RosterRow) => a.child.birth_date.localeCompare(b.child.birth_date)),
      }));
    },
    async closures(fromIso) {
      const { data, error } = await sb.from("closures").select("*").gte("on_date", fromIso).order("on_date").limit(20);
      fail(error);
      return data ?? [];
    },
    async esaInvoices() {
      const { data, error } = await sb
        .from("esa_invoices")
        .select("*, child:children(first_name, last_name, family_id, site_id, family:families(name))")
        .order("class_month", { ascending: false });
      fail(error);
      return data ?? [];
    },
    stripeFamily: (familyId) => callFunction("stripe-family", { family_id: familyId }),
    createEsaInvoices: (classMonth, familyId) => callFunction("esa-invoices", { action: "create", class_month: classMonth, family_id: familyId }),
    async markEsaPaid(id, reason) { await callFunction("esa-invoices", { action: "mark_paid", esa_invoice_id: id, reason }); },
    async staff() { const { data, error } = await sb.from("staff").select("*").order("name"); fail(error); return data ?? []; },
    async addStaff(s) { const { error } = await sb.from("staff").insert(s); fail(error); },
    async setStaffActive(id, active) { const { error } = await sb.from("staff").update({ active }).eq("id", id); fail(error); },
    async coachAssignments() { const { data, error } = await sb.from("coach_assignments").select("staff_id, program_id"); fail(error); return data ?? []; },
    async setCoachAssignments(staffId, programIds) {
      const { error } = await sb.from("coach_assignments").delete().eq("staff_id", staffId);
      fail(error);
      if (programIds.length) {
        const { error: e2 } = await sb.from("coach_assignments").insert(programIds.map((program_id) => ({ staff_id: staffId, program_id })));
        fail(e2);
      }
    },
    staffSignin: (staffId, action) => callFunction("staff-signin", { staff_id: staffId, action }),
    async changePassword(newPassword) { const { error } = await sb.auth.updateUser({ password: newPassword }); fail(error); },
    async auditRecent() {
      const { data, error } = await sb.from("audit_log").select("id, at, actor_email, action, entity, entity_id, reason").order("at", { ascending: false }).limit(40);
      fail(error);
      return data ?? [];
    },
  };
}
