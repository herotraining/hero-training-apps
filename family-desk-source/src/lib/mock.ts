// Made-up data mirroring the practice families, for screenshots and design work without a sign-in.
import type { Api } from "./api";
import type { Child, Enrollment, EsaInvoice, Family, Program, RosterRow, Staff } from "../types";

const sites = [
  { id: "peoria", name: "Peoria", gym: "Oasis Gymnastics", city: "Peoria" },
  { id: "mesa", name: "Mesa", gym: "Arizona Gymkids", city: "Mesa" },
  { id: "prescott", name: "Prescott", gym: "Storm Elite Gymnastics Academy", city: "Prescott" },
  { id: "lab", name: "L.A.B.", gym: "Learn. Adapt. Build.", city: "Glendale" },
];
const programs: Program[] = [
  { id: "coop-peoria-tue", name: "Co-op Day, Peoria, Tuesdays", kind: "coop", site_id: "peoria", weekday: 2, start_time: "10:00", end_time: "14:00", monthly_price_cents: 25000 },
  { id: "coop-peoria-thu", name: "Co-op Day, Peoria, Thursdays", kind: "coop", site_id: "peoria", weekday: 4, start_time: "10:00", end_time: "14:00", monthly_price_cents: 25000 },
  { id: "coop-prescott-mon", name: "Co-op Day, Prescott, Mondays", kind: "coop", site_id: "prescott", weekday: 1, start_time: "10:00", end_time: "14:00", monthly_price_cents: 25000 },
  { id: "coop-mesa-wed", name: "Co-op Day, Mesa, Wednesdays", kind: "coop", site_id: "mesa", weekday: 3, start_time: "10:00", end_time: "14:00", monthly_price_cents: 25000 },
  { id: "class-peoria-wed", name: "Wednesday Class, Peoria", kind: "class", site_id: "peoria", weekday: 3, start_time: "10:00", end_time: "11:00", monthly_price_cents: 13500 },
  { id: "tumbling-peoria-fri", name: "Friday Tumbling, Peoria", kind: "tumbling", site_id: "peoria", weekday: 5, start_time: "10:00", end_time: "11:00", monthly_price_cents: 13500 },
  { id: "rally-saber-peoria", name: "Rally Saber, Peoria", kind: "rally_saber", site_id: "peoria", weekday: 3, start_time: "11:00", end_time: "12:00", monthly_price_cents: 13500 },
  { id: "family-fitness-peoria-wed", name: "Family Fitness, Peoria, Wednesdays", kind: "family_fitness", site_id: "peoria", weekday: 3, start_time: "12:00", end_time: "13:00", monthly_price_cents: 10000 },
  { id: "star-team-peoria", name: "Star Team, Peoria", kind: "star_team", site_id: "peoria", weekday: 3, start_time: "13:00", end_time: "14:00", monthly_price_cents: 15000 },
];
const P = Object.fromEntries(programs.map((p) => [p.id, p]));

function child(id: string, family_id: string, first: string, last: string, birth: string, site: string, size: string, esa: boolean, house: string, care: Partial<NonNullable<Child["care"]>>, enr: [string, "esa" | "card", Enrollment["status"]][]): Child {
  return {
    id, family_id, first_name: first, last_name: last, birth_date: birth, site_id: site, uniform_size: size, esa, house, active: true,
    care: { child_id: id, allergies: null, medications: null, emergency_contacts: [], authorized_pickups: [], notes: null, ...care } as Child["care"],
    enrollments: enr.map(([pid, pay, status], i) => ({ id: `${id}-e${i}`, child_id: id, program_id: pid, status, pay, start_date: "2026-11-01", program: P[pid] })),
  };
}

let families: Family[] = [
  { id: "fa", name: "Test Family A", site_id: "peoria", pay_method: "esa", stripe_customer_id: "cus_A", city: "Surprise", zip: "85379", text_consent: true, notes: "Practice family: ESA, one child, Tuesday co-op.", status: "active",
    guardians: [{ id: "ga", family_id: "fa", name: "Alex Anderson", email: "test.family.a@example.com", mobile: "(602) 555-0101", is_primary: true }],
    children: [child("ca1", "fa", "Avery", "Anderson", "2018-03-14", "peoria", "YM", true, "Lion", { emergency_contacts: [{ name: "Grandma Anderson", phone: "(602) 555-0201" }], authorized_pickups: ["Alex Anderson", "Grandma Anderson"] }, [["coop-peoria-tue", "esa", "active"]])],
    agreements: [{ id: "1", kind: "waiver", signed_at: "2026-09-18", signed_by: "Alex Anderson" }, { id: "2", kind: "photo_release", signed_at: "2026-09-18", signed_by: "Alex Anderson" }, { id: "3", kind: "policies", signed_at: "2026-09-18", signed_by: "Alex Anderson" }] },
  { id: "fb", name: "Test Family B", site_id: "peoria", pay_method: "private", stripe_customer_id: "cus_B", city: "Surprise", zip: "85379", text_consent: true, notes: "Practice family: card, Thursday co-op plus Friday tumbling.", status: "active",
    guardians: [{ id: "gb", family_id: "fb", name: "Bailey Brooks", email: "test.family.b@example.com", mobile: "(602) 555-0102", is_primary: true }],
    children: [child("cb1", "fb", "Blake", "Brooks", "2016-06-02", "peoria", "YL", false, "Eagle", { allergies: "Peanuts (carries an EpiPen)", medications: "EpiPen in backpack", notes: "Check snacks on Thursdays.", emergency_contacts: [{ name: "Bailey Brooks", phone: "(602) 555-0102" }], authorized_pickups: ["Bailey Brooks"] }, [["coop-peoria-thu", "card", "active"], ["tumbling-peoria-fri", "card", "active"]])],
    agreements: [{ id: "4", kind: "waiver", signed_at: "2026-09-18", signed_by: "Bailey Brooks" }, { id: "5", kind: "photo_release", signed_at: null, signed_by: null }, { id: "6", kind: "policies", signed_at: "2026-09-18", signed_by: "Bailey Brooks" }] },
  { id: "fc", name: "Test Family C", site_id: "peoria", pay_method: "private", stripe_customer_id: "cus_C", city: "Peoria", zip: "85383", text_consent: false, notes: "Practice family: two siblings on bank debit, Thursday co-op.", status: "active",
    guardians: [{ id: "gc", family_id: "fc", name: "Casey Carter Sr.", email: "test.family.c@example.com", mobile: "(602) 555-0103", is_primary: true }, { id: "gc2", family_id: "fc", name: "Chris Carter", email: "test.family.c2@example.com", mobile: "(602) 555-0113", is_primary: false }],
    children: [
      child("cc1", "fc", "Casey", "Carter", "2020-09-21", "peoria", "YS", false, "Bear", { medications: "Inhaler for exercise; keep at the desk", emergency_contacts: [{ name: "Chris Carter", phone: "(602) 555-0113" }], authorized_pickups: ["Casey Carter Sr.", "Chris Carter"] }, [["coop-peoria-thu", "card", "active"]]),
      child("cc2", "fc", "Cameron", "Carter", "2015-01-30", "peoria", "YXL", false, "Wolf", { emergency_contacts: [{ name: "Chris Carter", phone: "(602) 555-0113" }], authorized_pickups: ["Casey Carter Sr.", "Chris Carter"] }, [["coop-peoria-thu", "card", "active"]]),
    ],
    agreements: [{ id: "7", kind: "waiver", signed_at: "2026-09-18", signed_by: "Casey Carter Sr." }, { id: "8", kind: "photo_release", signed_at: "2026-09-18", signed_by: "Casey Carter Sr." }, { id: "9", kind: "policies", signed_at: "2026-09-18", signed_by: "Casey Carter Sr." }] },
  { id: "fd", name: "Test Family D", site_id: "peoria", pay_method: "split", stripe_customer_id: "cus_D", city: "Surprise", zip: "85379", text_consent: true, notes: "Practice family: Tuesday co-op on ESA, Rally Saber on card.", status: "active",
    guardians: [{ id: "gd", family_id: "fd", name: "Dana Dawson", email: "test.family.d@example.com", mobile: "(602) 555-0104", is_primary: true }],
    children: [child("cd1", "fd", "Drew", "Dawson", "2014-05-11", "peoria", "AS", true, "Eagle", { allergies: "Bee stings", emergency_contacts: [{ name: "Dana Dawson", phone: "(602) 555-0104" }], authorized_pickups: ["Dana Dawson", "Uncle Dev"] }, [["coop-peoria-tue", "esa", "active"], ["rally-saber-peoria", "card", "active"]])],
    agreements: [{ id: "10", kind: "waiver", signed_at: "2026-09-18", signed_by: "Dana Dawson" }, { id: "11", kind: "photo_release", signed_at: "2026-09-18", signed_by: "Dana Dawson" }, { id: "12", kind: "policies", signed_at: "2026-09-18", signed_by: "Dana Dawson" }] },
  { id: "fe", name: "Test Family E", site_id: "mesa", pay_method: "esa", stripe_customer_id: "cus_E", city: "Mesa", zip: "85201", text_consent: true, notes: "Practice family: Mesa ESA, Wednesday co-op.", status: "active",
    guardians: [{ id: "ge", family_id: "fe", name: "Emerson Ellis", email: "test.family.e@example.com", mobile: "(480) 555-0105", is_primary: true }],
    children: [child("ce1", "fe", "Emery", "Ellis", "2019-08-08", "mesa", "YM", true, "Lion", { emergency_contacts: [{ name: "Emerson Ellis", phone: "(480) 555-0105" }], authorized_pickups: ["Emerson Ellis"] }, [["coop-mesa-wed", "esa", "active"]])],
    agreements: [{ id: "13", kind: "waiver", signed_at: "2026-09-18", signed_by: "Emerson Ellis" }, { id: "14", kind: "photo_release", signed_at: "2026-09-18", signed_by: "Emerson Ellis" }, { id: "15", kind: "policies", signed_at: "2026-09-18", signed_by: "Emerson Ellis" }] },
  { id: "ff", name: "DEV Family F", site_id: "peoria", pay_method: "private", stripe_customer_id: null, city: "Glendale", zip: "85308", text_consent: true, notes: "Development family. Safe to change or delete.", status: "active",
    guardians: [{ id: "gf", family_id: "ff", name: "Frankie Fox", email: "dev.family.f@example.com", mobile: "(623) 555-0106", is_primary: true }],
    children: [
      child("cf1", "ff", "Finley", "Fox", "2017-11-23", "peoria", "YM", false, "Bear", { allergies: "Dairy (mild)", emergency_contacts: [{ name: "Frankie Fox", phone: "(623) 555-0106" }], authorized_pickups: ["Frankie Fox"] }, [["tumbling-peoria-fri", "card", "active"], ["coop-peoria-tue", "card", "waitlist"]]),
      child("cf2", "ff", "Flynn", "Fox", "2019-02-14", "peoria", "YS", false, "Wolf", { emergency_contacts: [{ name: "Frankie Fox", phone: "(623) 555-0106" }], authorized_pickups: ["Frankie Fox"] }, [["tumbling-peoria-fri", "card", "active"]]),
    ],
    agreements: [{ id: "16", kind: "waiver", signed_at: "2026-09-18", signed_by: "Frankie Fox" }, { id: "17", kind: "photo_release", signed_at: "2026-09-18", signed_by: "Frankie Fox" }, { id: "18", kind: "policies", signed_at: "2026-09-18", signed_by: "Frankie Fox" }] },
];

const allChildren = () => families.flatMap((f) => f.children ?? []);
const esa: EsaInvoice[] = [
  { id: "ia", child_id: "ca1", class_month: "2026-12-01", amount_cents: 25000, stripe_invoice_id: "in_A", hosted_invoice_url: "https://invoice.stripe.com/", status: "sent", sent_at: "2026-10-03", paid_at: null, notes: null, child: { first_name: "Avery", last_name: "Anderson", family_id: "fa", site_id: "peoria", family: { name: "Test Family A" } } },
  { id: "id", child_id: "cd1", class_month: "2026-12-01", amount_cents: 25000, stripe_invoice_id: "in_D", hosted_invoice_url: "https://invoice.stripe.com/", status: "paid", sent_at: "2026-10-03", paid_at: "2026-10-07", notes: null, child: { first_name: "Drew", last_name: "Dawson", family_id: "fd", site_id: "peoria", family: { name: "Test Family D" } } },
  { id: "ie", child_id: "ce1", class_month: "2026-12-01", amount_cents: 25000, stripe_invoice_id: "in_E", hosted_invoice_url: "https://invoice.stripe.com/", status: "sent", sent_at: "2026-10-03", paid_at: null, notes: null, child: { first_name: "Emery", last_name: "Ellis", family_id: "fe", site_id: "mesa", family: { name: "Test Family E" } } },
];

let staff: Staff[] = [
  { id: "s1", user_id: "u1", email: "mike@example.com", name: "Mike", role: "owner", site_id: null, active: true },
  { id: "s2", user_id: null, email: "lisa@example.com", name: "Lisa", role: "admin", site_id: null, active: true },
  { id: "s3", user_id: null, email: "mary@example.com", name: "Mary", role: "admin", site_id: "mesa", active: true },
  { id: "s4", user_id: null, email: "zoe@example.com", name: "Zoe", role: "coach", site_id: null, active: true },
];
let assignments = [{ staff_id: "s4", program_id: "coop-peoria-thu" }];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockApi(): Api {
  return {
    mock: true,
    async profile() { return { staff: staff[0], aal: "aal2" }; },
    async sites() { return sites; },
    async programs() { return programs; },
    async families() { await sleep(80); return families; },
    async family(id) { return families.find((f) => f.id === id) ?? null; },
    async rosterFor(weekday) {
      return programs.filter((p) => p.weekday === weekday).map((program) => ({
        program,
        rows: allChildren().flatMap((c) => (c.enrollments ?? []).filter((e) => e.program_id === program.id && e.status === "active").map((enrollment): RosterRow => ({ child: c, enrollment }))).sort((a, b) => a.child.birth_date.localeCompare(b.child.birth_date)),
      }));
    },
    async saveFamily(f) {
      await sleep(80);
      if (f.id) { families = families.map((x) => (x.id === f.id ? { ...x, ...f } : x)); return f.id; }
      const id = "f" + Date.now();
      families = [...families, { ...f, id, stripe_customer_id: null, guardians: [], children: [], agreements: [{ id: id + "a1", kind: "waiver", signed_at: null, signed_by: null }, { id: id + "a2", kind: "photo_release", signed_at: null, signed_by: null }, { id: id + "a3", kind: "policies", signed_at: null, signed_by: null }] }];
      return id;
    },
    async saveGuardian(g) {
      await sleep(60);
      families = families.map((f) => {
        if (f.id !== g.family_id) return f;
        let gs = (f.guardians ?? []).map((x) => (g.is_primary ? { ...x, is_primary: false } : x));
        if (g.id) gs = gs.map((x) => (x.id === g.id ? { ...x, ...g, id: g.id! } : x));
        else gs = [...gs, { ...g, id: "g" + Date.now() }];
        return { ...f, guardians: gs };
      });
    },
    async removeGuardian(id) { families = families.map((f) => ({ ...f, guardians: (f.guardians ?? []).filter((g) => g.id !== id) })); },
    async saveChild(c) {
      await sleep(60);
      const id = c.id ?? "c" + Date.now();
      families = families.map((f) => {
        if (f.id !== c.family_id) return f;
        const kids = f.children ?? [];
        return { ...f, children: c.id ? kids.map((k) => (k.id === c.id ? { ...k, ...c, id } : k)) : [...kids, { ...c, id, care: { child_id: id, allergies: null, medications: null, emergency_contacts: [], authorized_pickups: [], notes: null }, enrollments: [] }] };
      });
      return id;
    },
    async saveCare(childId, care) {
      families = families.map((f) => ({ ...f, children: (f.children ?? []).map((k) => (k.id === childId ? { ...k, care: { child_id: childId, ...care } } : k)) }));
    },
    async setAgreement(familyId, kind, signedBy) {
      families = families.map((f) => (f.id !== familyId ? f : { ...f, agreements: (f.agreements ?? []).map((a) => (a.kind === kind ? { ...a, signed_at: signedBy ? new Date().toISOString() : null, signed_by: signedBy } : a)) }));
    },
    async saveEnrollment(e) {
      await sleep(60);
      families = families.map((f) => ({ ...f, children: (f.children ?? []).map((k) => {
        if (k.id !== e.child_id) return k;
        const list = k.enrollments ?? [];
        const existing = list.find((x) => (e.id ? x.id === e.id : x.program_id === e.program_id));
        const row: Enrollment = { ...(existing ?? { id: "e" + Date.now() }), ...e, id: existing?.id ?? "e" + Date.now(), program: P[e.program_id] };
        return { ...k, enrollments: existing ? list.map((x) => (x.id === row.id ? row : x)) : [...list, row] };
      }) }));
    },
    async removeEnrollment(id) { families = families.map((f) => ({ ...f, children: (f.children ?? []).map((k) => ({ ...k, enrollments: (k.enrollments ?? []).filter((x) => x.id !== id) })) })); },
    async closures() {
      return [
        { id: "c1", site_id: "peoria", on_date: "2026-10-30", title: "Oasis camp day: no Peoria co-op", note: "Oasis reserved the gym." },
        { id: "c2", site_id: null, on_date: "2026-11-26", title: "Thanksgiving: no classes", note: "All sites closed Thursday and Friday." },
      ];
    },
    async esaInvoices() { return esa; },
    async stripeFamily(familyId) {
      await sleep(200);
      const f = families.find((x) => x.id === familyId)!;
      if (!f.stripe_customer_id) return { family: f.name, note: "No Stripe customer yet" };
      return {
        family: f.name, customer: f.stripe_customer_id,
        subscriptions: f.pay_method === "esa" ? [] : [{ id: "sub_1", status: "active", description: `HERO monthly tuition for ${f.name}`, items: [{ product: "HERO Co-op Day, Peoria, Thursdays", amount: 25000, quantity: 1, interval: "month" }], next_charge: 1794754800 }],
        invoices: esa.filter((i) => i.child?.family_id === familyId).map((i) => ({ id: i.stripe_invoice_id!, number: "4ANDBT2V-0002", status: i.status === "paid" ? "paid" : "open", total: i.amount_cents, amount_paid: 0, due_date: 1796137200, created: 1793545200, esa: true, class_month: "2026-12", student: `${i.child?.first_name} ${i.child?.last_name[0]}`, hosted_invoice_url: i.hosted_invoice_url, paid_out_of_band: i.status === "paid" })),
        payments: f.pay_method === "esa" ? [] : [{ id: "ch_1", amount: 25000, status: "succeeded", created: 1791217856, description: "Tuition", refunded: 0, method: "card", last4: "4242" }],
        payment_methods: f.pay_method === "esa" ? [] : [{ id: "pm_1", type: "card", last4: "4242", brand: "visa" }],
      };
    },
    async createEsaInvoices(classMonth) { await sleep(300); return { class_month: classMonth, created: [{ student: "Avery A", family: "Test Family A", amount: 25000, invoice: "in_new", url: "https://invoice.stripe.com/" }], skipped: [{ student: "Drew D", why: "already has an invoice for this month" }] }; },
    async markEsaPaid(id) { const i = esa.find((x) => x.id === id); if (i) { i.status = "paid"; i.paid_at = new Date().toISOString(); } },
    async staff() { return staff; },
    async addStaff(s) { staff = [...staff, { id: `s${staff.length + 1}`, user_id: null, active: true, ...s }]; },
    async setStaffActive(id, active) { staff = staff.map((s) => (s.id === id ? { ...s, active } : s)); },
    async coachAssignments() { return assignments; },
    async setCoachAssignments(staffId, programIds) { assignments = [...assignments.filter((a) => a.staff_id !== staffId), ...programIds.map((program_id) => ({ staff_id: staffId, program_id }))]; },
    async staffSignin(staffId, action) { if (action === "reset_2fa") return { ok: true, removed: 1 }; const st = staff.find((x) => x.id === staffId)!; if (action === "create") staff = staff.map((x) => (x.id === staffId ? { ...x, user_id: "u-" + x.id } : x)); return { ok: true, email: st.email, password: "maple-harbor-comet-42" }; },
    async changePassword() { await sleep(100); },
    async auditRecent() { return [{ id: 1, at: new Date().toISOString(), actor_email: "lisa@example.com", action: "update", entity: "esa_invoices", entity_id: "id", reason: "ClassWallet deposit seen in bank" }]; },
  };
}
