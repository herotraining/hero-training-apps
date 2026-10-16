import type { Api } from "./api";
import { supabase, functionsUrl } from "./supabase";
import { AGREEMENT_KINDS, type Family, type Program, type Role, type RosterRow, type StoreSale, type UniformRequest } from "../types";

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

// A function that needs no sign-in (the parent-facing request page).
async function callPublicFunction<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(functionsUrl(name), {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string, Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json as T;
}

const CHILD_SELECT = `id, family_id, first_name, last_name, birth_date, site_id, uniform_size, esa, house, active,
    care:care_notes(child_id, allergies, medications, emergency_contacts, authorized_pickups, notes),
    enrollments(id, child_id, program_id, status, pay, start_date, end_date, note, program:programs(id, name, kind, site_id, weekday, start_time, end_time, monthly_price_cents))`;
const FAMILY_SELECT = `id, name, site_id, pay_method, stripe_customer_id, address_line1, city, zip, text_consent, notes, status,
  guardians(id, family_id, name, email, mobile, is_primary),
  children(${CHILD_SELECT}),
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

  // The signed-in role, remembered from profile(), decides whether families come from the full tables or the
  // roster views a site lead is allowed (roster_families, roster_guardians: no addresses, emails, notes or money).
  let role: Role | null = null;
  const roleNow = async (): Promise<Role | null> => role ?? (await api.profile()).staff?.role ?? null;

  // A site lead's view of families: the roster rows, the guardians' names and mobiles, and the children with
  // their active enrollments. Row-level security limits each query to the lead's site.
  async function rosterFamilies(id?: string): Promise<Family[]> {
    let fq = sb.from("roster_families").select("id, name, site_id, status").order("name");
    if (id) fq = fq.eq("id", id);
    const { data: fams, error } = await fq;
    fail(error);
    if (!fams?.length) return [];
    let gq = sb.from("roster_guardians").select("id, family_id, name, mobile, is_primary");
    let cq = sb.from("children").select(CHILD_SELECT);
    if (id) { gq = gq.eq("family_id", id); cq = cq.eq("family_id", id); }
    const [{ data: gs, error: e2 }, { data: kids, error: e3 }] = await Promise.all([gq, cq]);
    fail(e2); fail(e3);
    return fams.map((f: any) => shapeFamily({
      ...f,
      guardians: (gs ?? []).filter((g: any) => g.family_id === f.id).map((g: any) => ({ ...g, email: null })),
      children: (kids ?? []).filter((c: any) => c.family_id === f.id),
      agreements: [],
    }));
  }

  const api: Api = {
    mock: false,
    async profile() {
      const { data, error } = await sb.rpc("my_profile");
      fail(error);
      role = data?.staff?.role ?? null;
      // Set by staff-signin on a temporary password; cleared when the person picks their own.
      const { data: { session } } = await sb.auth.getSession();
      return { staff: data?.staff ?? null, aal: data?.aal ?? null, must_change_password: session?.user?.app_metadata?.must_change_password === true };
    },
    async sites() { const { data, error } = await sb.from("sites").select("*").order("name"); fail(error); return data ?? []; },
    async programs() { const { data, error } = await sb.from("programs").select("*").eq("active", true).order("weekday").order("start_time"); fail(error); return data ?? []; },
    async families() {
      if ((await roleNow()) === "site_lead") return rosterFamilies();
      const { data, error } = await sb.from("families").select(FAMILY_SELECT).order("name");
      fail(error);
      return (data ?? []).map(shapeFamily);
    },
    async family(id) {
      if ((await roleNow()) === "site_lead") return (await rosterFamilies(id))[0] ?? null;
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
          .sort((a: RosterRow, b: RosterRow) => (a.child.birth_date ?? "9999").localeCompare(b.child.birth_date ?? "9999")),
      }));
    },
    async saveFamily(f) {
      const { id, ...rest } = f;
      if (id) { const { error } = await sb.from("families").update(rest).eq("id", id); fail(error); return id; }
      const { data, error } = await sb.from("families").insert(rest).select("id").single();
      fail(error);
      const fid = data!.id as string;
      const { error: e2 } = await sb.from("agreements").insert(AGREEMENT_KINDS.map((kind) => ({ family_id: fid, kind })));
      fail(e2);
      return fid;
    },
    async saveGuardian(g) {
      const { id, ...rest } = g;
      if (rest.is_primary) { const { error } = await sb.from("guardians").update({ is_primary: false }).eq("family_id", rest.family_id); fail(error); }
      const { error } = id ? await sb.from("guardians").update(rest).eq("id", id) : await sb.from("guardians").insert(rest);
      fail(error);
    },
    async removeGuardian(id) { const { error } = await sb.from("guardians").delete().eq("id", id); fail(error); },
    async saveChild(c) {
      const { id, ...rest } = c;
      if (id) { const { error } = await sb.from("children").update(rest).eq("id", id); fail(error); return id; }
      const { data, error } = await sb.from("children").insert(rest).select("id").single();
      fail(error);
      const cid = data!.id as string;
      const { error: e2 } = await sb.from("care_notes").insert({ child_id: cid });
      fail(e2);
      return cid;
    },
    async saveCare(childId, care) {
      const { error } = await sb.from("care_notes").upsert({ child_id: childId, ...care }, { onConflict: "child_id" });
      fail(error);
    },
    async setAgreement(familyId, kind, signedBy) {
      const patch = signedBy ? { signed_at: new Date().toISOString(), signed_by: signedBy } : { signed_at: null, signed_by: null };
      const { data, error } = await sb.from("agreements").select("id").eq("family_id", familyId).eq("kind", kind).limit(1);
      fail(error);
      if (data?.length) { const { error: e2 } = await sb.from("agreements").update(patch).eq("id", data[0].id); fail(e2); }
      else { const { error: e2 } = await sb.from("agreements").insert({ family_id: familyId, kind, ...patch }); fail(e2); }
    },
    async saveEnrollment(e) {
      const { id, ...rest } = e;
      if (id) { const { error } = await sb.from("enrollments").update(rest).eq("id", id); fail(error); return; }
      // A child holds at most one open row per program (active, hold or waitlist); dropped rows stay as history,
      // so re-enrolling after a drop adds a fresh row rather than rewriting the old one.
      const { data, error } = await sb.from("enrollments").select("id").eq("child_id", rest.child_id).eq("program_id", rest.program_id).in("status", ["active", "hold", "waitlist"]).limit(1);
      fail(error);
      if (data?.length) { const { error: e2 } = await sb.from("enrollments").update(rest).eq("id", data[0].id); fail(e2); }
      else { const { error: e2 } = await sb.from("enrollments").insert(rest); fail(e2); }
    },
    async removeEnrollment(id) { const { error } = await sb.from("enrollments").delete().eq("id", id); fail(error); },
    async jackrabbitHistory(familyId) {
      const { data, error } = await sb.from("jackrabbit_history").select("id, family_id, on_date, kind, subtype, student, activity, amount_cents, note").eq("family_id", familyId).order("on_date", { ascending: false });
      fail(error);
      return data ?? [];
    },
    async attendanceFor(dateIso) { const { data, error } = await sb.from("attendance").select("id, enrollment_id, on_date, status").eq("on_date", dateIso); fail(error); return data ?? []; },
    async markAttendance(enrollmentId, dateIso, status) {
      if (!status) { const { error } = await sb.from("attendance").delete().eq("enrollment_id", enrollmentId).eq("on_date", dateIso); fail(error); return; }
      const { error } = await sb.from("attendance").upsert({ enrollment_id: enrollmentId, on_date: dateIso, status }, { onConflict: "enrollment_id,on_date" });
      fail(error);
    },
    async allPrograms() { const { data, error } = await sb.from("programs").select("*").order("site_id").order("weekday").order("start_time"); fail(error); return data ?? []; },
    async saveProgram(p) { const { error } = await sb.from("programs").upsert(p, { onConflict: "id" }); fail(error); },
    async saveClosure(c) {
      const { id, ...rest } = c;
      const { error } = id ? await sb.from("closures").update(rest).eq("id", id) : await sb.from("closures").insert(rest);
      fail(error);
    },
    async removeClosure(id) { const { error } = await sb.from("closures").delete().eq("id", id); fail(error); },
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
    async markEsaPaid(id, reason, classwalletDepositId) {
      const r = await callFunction<{ ok: boolean; note?: string }>("esa-invoices", { action: "mark_paid", esa_invoice_id: id, reason, classwallet_deposit_id: classwalletDepositId });
      if (r.note && classwalletDepositId) throw new Error(r.note);
    },
    async feed() {
      const { data, error } = await sb.from("desk_feed").select("*").eq("status", "open").order("last_message_at", { ascending: false }).limit(50);
      fail(error);
      return data ?? [];
    },
    async setFeedStatus(id, status) { const { error } = await sb.from("desk_feed").update({ status }).eq("id", id); fail(error); },
    async classwalletDeposits(sinceIso) {
      const { data, error } = await sb.from("classwallet_deposits").select("*, order:classwallet_orders(student, order_date, child_id, family_id)").gte("on_date", sinceIso).order("on_date", { ascending: false }).limit(400);
      fail(error);
      return data ?? [];
    },
    async setDepositStatus(id, status, note) {
      const { error } = await sb.from("classwallet_deposits").update(note === undefined ? { status } : { status, note }).eq("id", id);
      fail(error);
    },
    async trainerPay(sinceIso) {
      const { data, error } = await sb.from("trainer_pay").select("id, paid_on, payee, amount_cents, memo, period, hours, kind").gte("paid_on", sinceIso).order("paid_on", { ascending: false }).limit(1000);
      fail(error);
      return data ?? [];
    },
    storeConfig: () => callFunction("store", { action: "config" }),
    async storeItems() { const { data, error } = await sb.from("store_items").select("id, name, kind, price_cents, sizes, colors, esa_ok, active, sort, image_url, description").order("sort").order("name"); fail(error); return data ?? []; },
    async saveStoreItem(i) {
      const { id, ...rest } = i;
      const { error } = id ? await sb.from("store_items").update(rest).eq("id", id) : await sb.from("store_items").insert(rest);
      fail(error);
    },
    async uploadStoreImage(file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from("store-images").upload(path, file, { contentType: file.type || undefined, upsert: false });
      fail(error);
      return sb.storage.from("store-images").getPublicUrl(path).data.publicUrl;
    },
    async storeSales(sinceIso) {
      const { data, error } = await sb
        .from("store_sales")
        .select("id, family_id, site_id, pay, status, total_cents, stripe_checkout_id, stripe_url, stripe_live, note, paid_at, created_at, lines:store_sale_lines(id, sale_id, item_id, child_id, name, size, color, quantity, unit_cents, esa_invoice_id, handed_out_at, child:children(first_name, last_name)), family:families(name), seller:staff(name)")
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(300);
      fail(error);
      return (data ?? []) as unknown as StoreSale[];
    },
    async sell(s) {
      const { data, error } = await sb.rpc("store_create_sale", { p_site: s.site_id, p_family: s.family_id, p_pay: s.pay, p_card_tapped: !!s.card_tapped, p_note: s.note, p_lines: s.lines });
      fail(error);
      return data as StoreSale;
    },
    storeCheckout: (s) => callFunction("store", "sale_id" in s ? { action: "checkout", sale_id: s.sale_id } : { action: "checkout", cart: { site_id: s.site_id, family_id: s.family_id, note: s.note, lines: s.lines } }),
    storeStatus: (saleId) => callFunction("store", { action: "status", sale_id: saleId }),
    storeCancel: (saleId, reason) => callFunction("store", { action: "cancel", sale_id: saleId, reason }),
    async voidSale(saleId, note) { const { error } = await sb.from("store_sales").update({ status: "void", note }).eq("id", saleId); fail(error); },
    async setHandedOut(lineId, handed) { const { error } = await sb.from("store_sale_lines").update({ handed_out_at: handed ? new Date().toISOString() : null }).eq("id", lineId); fail(error); },
    chargeCard: (s) => callFunction("store", { action: "charge", cart: { site_id: s.site_id, family_id: s.family_id, note: s.note, lines: s.lines } }),
    async uniformRequests() {
      const { data, error } = await sb.from("uniform_requests")
        .select("*, child:children(first_name, last_name, esa, uniform_size), family:families(name, site_id, stripe_customer_id)")
        .order("status").order("created_at").limit(300);
      fail(error);
      return (data ?? []) as unknown as UniformRequest[];
    },
    async closeRequests(ids, status, saleId, note) {
      const { error } = await sb.from("uniform_requests").update({ status, sale_id: saleId, closed_note: note }).in("id", ids).eq("status", "new");
      fail(error);
    },
    uniformLookup: (email, childFirstName) => callPublicFunction("uniform-request", { action: "lookup", email, child_first_name: childFirstName }),
    uniformSubmit: (ask) => callPublicFunction("uniform-request", { action: "submit", ...ask }),
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
    async changePassword(newPassword) {
      // The staff-signin function sets it (service role) and clears must_change_password; a fresh token then
      // carries the cleared flag.
      await callFunction("staff-signin", { action: "password_changed", new_password: newPassword });
      const { error } = await sb.auth.refreshSession();
      fail(error);
    },
    async auditRecent() {
      const { data, error } = await sb.from("audit_log").select("id, at, actor_email, action, entity, entity_id, reason").order("at", { ascending: false }).limit(40);
      fail(error);
      return data ?? [];
    },
  };
  return api;
}
