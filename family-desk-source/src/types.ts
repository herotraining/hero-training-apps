export type Role = "owner" | "admin" | "site_lead" | "coach";
export type PayMethod = "esa" | "private" | "split";
export type EsaStatus = "draft" | "sent" | "submitted" | "paid" | "rejected" | "void";

export interface Staff {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  role: Role;
  site_id: string | null;
  active: boolean;
}

export interface Site { id: string; name: string; gym: string | null; city: string | null }

export interface Program {
  id: string;
  name: string;
  kind: string;
  site_id: string;
  weekday: number | null;
  start_time: string | null;
  end_time: string | null;
  monthly_price_cents: number;
  active?: boolean;
}
export type ProgramInput = { id: string; name: string; kind: string; site_id: string; weekday: number | null; start_time: string | null; end_time: string | null; monthly_price_cents: number; active: boolean };
export type ClosureInput = { id?: string; site_id: string | null; on_date: string; title: string; note: string | null };
export interface Attendance { id: string; enrollment_id: string; on_date: string; status: "present" | "absent" }

export interface Guardian { id: string; family_id: string; name: string; email: string | null; mobile: string | null; is_primary: boolean }

export interface CareNotes {
  child_id: string;
  allergies: string | null;
  medications: string | null;
  emergency_contacts: { name: string; phone: string }[];
  authorized_pickups: string[];
  notes: string | null;
}

export type EnrollmentStatus = "active" | "hold" | "dropped" | "waitlist";
export interface Enrollment {
  id: string;
  child_id: string;
  program_id: string;
  status: EnrollmentStatus;
  pay: "esa" | "card";
  start_date: string;
  end_date?: string | null;
  note?: string | null;
  program?: Program;
}

/** One line of the Jackrabbit ledger we brought over (fees, payments, uniforms, refunds). */
export interface JackrabbitLine {
  id: string;
  family_id: string | null;
  on_date: string;
  kind: string;
  subtype: string | null;
  student: string | null;
  activity: string | null;
  amount_cents: number;
  note: string | null;
}

export interface Child {
  id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  birth_date: string | null;
  site_id: string;
  uniform_size: string | null;
  esa: boolean;
  house: string | null;
  active: boolean;
  care?: CareNotes | null;
  enrollments?: Enrollment[];
}

export interface Agreement { id: string; kind: string; signed_at: string | null; signed_by: string | null }

export interface Family {
  id: string;
  name: string;
  site_id: string;
  pay_method: PayMethod;
  stripe_customer_id: string | null;
  address_line1?: string | null;
  city: string | null;
  zip: string | null;
  text_consent: boolean;
  notes: string | null;
  status: string;
  guardians?: Guardian[];
  children?: Child[];
  agreements?: Agreement[];
}

// What the edit screens send. An id means update; none means create.
export type FamilyInput = { id?: string; name: string; site_id: string; pay_method: PayMethod; address_line1: string | null; city: string | null; zip: string | null; text_consent: boolean; notes: string | null; status: string };
export type GuardianInput = { id?: string; family_id: string; name: string; email: string | null; mobile: string | null; is_primary: boolean };
export type ChildInput = { id?: string; family_id: string; first_name: string; last_name: string; birth_date: string | null; site_id: string; uniform_size: string | null; esa: boolean; house: string | null; active: boolean };
export type CareInput = Omit<CareNotes, "child_id">;
export type EnrollmentInput = { id?: string; child_id: string; program_id: string; status: EnrollmentStatus; pay: "esa" | "card"; start_date: string; end_date: string | null; note?: string | null };
export const AGREEMENT_KINDS = ["waiver", "photo_release", "policies"] as const;

export interface EsaInvoice {
  id: string;
  child_id: string;
  class_month: string;
  amount_cents: number;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null;
  status: EsaStatus;
  sent_at: string | null;
  paid_at: string | null;
  notes: string | null;
  child?: { first_name: string; last_name: string; family_id: string; site_id: string; family?: { name: string } };
}

export interface Closure { id: string; site_id: string | null; on_date: string; title: string; note: string | null }

// Left by the morning sweep (Claude's daily read-only pass over the front-desk inbox and the bank feed).
export interface FeedItem {
  id: string;
  kind: "email";
  source_id: string;
  title: string;
  summary: string | null;
  from_name: string | null;
  from_email: string | null;
  family_id: string | null;
  link: string | null;
  last_message_at: string | null;
  status: "open" | "done";
  done_at: string | null;
}

export interface ClassWalletDeposit {
  id: string;
  bank_txn_id: string;
  on_date: string;
  net_cents: number;
  gross_cents: number;
  fee_cents: number;
  status: "new" | "confirmed" | "ignored";
  esa_invoice_id: string | null;
  note: string | null;
  confirmed_at: string | null;
  order_no?: string | null;
  order?: { student: string; order_date: string; child_id: string | null; family_id: string | null } | null;
}

export interface TrainerPay {
  id: string;
  paid_on: string;
  payee: string;
  amount_cents: number;
  memo: string | null;
  period: string | null;
  hours: number | null;
  kind: "trainer" | "facility" | "other";
}

// Store: uniforms and gear sold at the front desk. Card payments happen on Stripe's pages, never here.
export type StoreKind = "uniform" | "gear" | "other";
export interface StoreItem { id: string; name: string; kind: StoreKind; price_cents: number; sizes: string[]; esa_ok: boolean; active: boolean; sort: number }
export type StoreItemInput = { id?: string; name: string; kind: StoreKind; price_cents: number; sizes: string[]; esa_ok: boolean; active: boolean; sort: number };
export type StorePay = "card" | "esa" | "jackrabbit" | "cash" | "free";
export type StoreStatus = "waiting" | "done" | "on_esa" | "invoiced" | "void";
export interface StoreLine {
  id: string;
  sale_id: string;
  item_id: string | null;
  child_id: string | null;
  name: string;
  size: string | null;
  quantity: number;
  unit_cents: number;
  esa_invoice_id: string | null;
  handed_out_at: string | null;
  child?: { first_name: string; last_name: string } | null;
}
export interface StoreSale {
  id: string;
  family_id: string | null;
  site_id: string;
  pay: StorePay;
  status: StoreStatus;
  total_cents: number;
  stripe_checkout_id: string | null;
  stripe_url: string | null;
  stripe_live: boolean | null;
  note: string | null;
  paid_at: string | null;
  created_at: string;
  lines: StoreLine[];
  family?: { name: string } | null;
  seller?: { name: string } | null;
}
export interface CartLine { key: string; item_id: string; name: string; size: string | null; quantity: number; unit_cents: number; child_id: string | null; child_name: string | null; esa_ok: boolean }
// unit_cents is the price the cart showed; the database refuses the sale if the price list has changed since.
export type NewSale = { site_id: string; family_id: string | null; pay: StorePay; card_tapped?: boolean; note: string | null; lines: { item_id: string; size: string | null; quantity: number; child_id: string | null; unit_cents: number }[] };
// What the store function says about a card sale's Stripe payment page.
export interface CheckoutState { sale_id: string; status: string; url?: string | null; live?: boolean | null; expires_at?: number; note?: string }
export interface StoreConfig { card: "off" | "practice" | "live"; why?: string }

export interface StripePicture {
  family: string;
  customer?: string;
  note?: string;
  subscriptions?: { id: string; status: string; description: string | null; items: { product: string; amount: number; quantity: number; interval: string }[]; next_charge: number | null }[];
  invoices?: { id: string; number: string | null; status: string; total: number; amount_paid: number; due_date: number | null; created: number; esa: boolean; class_month: string | null; student: string | null; hosted_invoice_url: string | null; paid_out_of_band: boolean }[];
  payments?: { id: string; amount: number; status: string; created: number; description: string | null; refunded: number; method: string | null; last4: string | null }[];
  payment_methods?: { id: string; type: string; last4: string | null; brand: string | null }[];
}

export interface RosterRow { child: Child; enrollment: Enrollment; family?: Family }

export interface Profile { staff: Staff | null; aal: "aal1" | "aal2" | null }
