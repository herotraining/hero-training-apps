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
}

export interface Guardian { id: string; family_id: string; name: string; email: string | null; mobile: string | null; is_primary: boolean }

export interface CareNotes {
  child_id: string;
  allergies: string | null;
  medications: string | null;
  emergency_contacts: { name: string; phone: string }[];
  authorized_pickups: string[];
  notes: string | null;
}

export interface Enrollment {
  id: string;
  child_id: string;
  program_id: string;
  status: "active" | "hold" | "dropped" | "waitlist";
  pay: "esa" | "card";
  start_date: string;
  program?: Program;
}

export interface Child {
  id: string;
  family_id: string;
  first_name: string;
  last_name: string;
  birth_date: string;
  site_id: string;
  uniform_size: string | null;
  esa: boolean;
  house: string | null;
  active: boolean;
  care?: CareNotes | null;
  enrollments?: Enrollment[];
}

export interface Family {
  id: string;
  name: string;
  site_id: string;
  pay_method: PayMethod;
  stripe_customer_id: string | null;
  city: string | null;
  zip: string | null;
  text_consent: boolean;
  notes: string | null;
  status: string;
  guardians?: Guardian[];
  children?: Child[];
  agreements?: { id: string; kind: string; signed_at: string | null; signed_by: string | null }[];
}

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
