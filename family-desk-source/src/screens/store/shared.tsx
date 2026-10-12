// Bits the Store screens share: words for things, which sales can be voided, and small pieces of markup.
import type { Child, StoreKind, StoreSale } from "../../types";
import { arizonaToday, dateWords } from "../../lib/util";

export const KIND_WORDS: Record<StoreKind, string> = { uniform: "Required uniform", gear: "Gear", other: "Other" };
export const ALL_SIZES = ["Youth XS", "Youth S", "Youth M", "Youth L", "Youth XL", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL"];

// Sizes typed the short way on a child's record (YM, AL) read as the Store's size names.
const SHORT_SIZES: Record<string, string> = { YXS: "Youth XS", YS: "Youth S", YM: "Youth M", YL: "Youth L", YXL: "Youth XL", AS: "Adult S", AM: "Adult M", AL: "Adult L", AXL: "Adult XL", A2XL: "Adult 2XL", AXXL: "Adult 2XL" };
export const sizeName = (s: string | null | undefined) => (s ? SHORT_SIZES[s.replace(/\s+/g, "").toUpperCase()] ?? s.trim() : null);

// A child an ESA invoice can carry a uniform for: on ESA, with an active ESA class.
export const esaKid = (c: Child | undefined) => !!c && c.esa && (c.enrollments ?? []).some((e) => e.pay === "esa" && e.status === "active");

export function arizonaDay(iso: string): string { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Phoenix" }); }
export function whenWords(iso: string): string {
  const time = new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Phoenix" }).toLowerCase();
  const day = arizonaDay(iso);
  return `${day === arizonaToday() ? "Today" : dateWords(day)}, ${time}`;
}
export function sinceDays(n: number): string { return new Date(Date.now() - n * 86400000).toISOString(); }

// "2 × HERO uniform tank top, Navy (Youth M)"
export function lineWords(l: { name: string; size: string | null; color?: string | null; quantity: number }): string {
  return `${l.quantity > 1 ? `${l.quantity} × ` : ""}${l.name}${l.color ? `, ${l.color}` : ""}${l.size ? ` (${l.size})` : ""}`;
}

export function saleTag(s: StoreSale): { label: string; kind?: "esa" | "warn" | "gold" | "good" } {
  if (s.status === "void") return { label: "Voided", kind: "warn" };
  if (s.status === "waiting") return { label: "Waiting for payment", kind: "gold" };
  if (s.status === "on_esa") return Date.now() - new Date(s.created_at).getTime() > 40 * 86400000
    ? { label: "Still waiting for an ESA invoice", kind: "warn" }
    : { label: "On the next ESA invoice", kind: "esa" };
  if (s.status === "invoiced") return { label: "On an ESA invoice", kind: "esa" };
  if (s.pay === "jackrabbit") return { label: "On their Jackrabbit account" };
  if (s.pay === "free") return { label: "No charge" };
  if (s.pay === "cash") return { label: "Paid in cash", kind: "good" };
  return { label: s.stripe_live === false ? "Paid by card (practice)" : "Paid by card", kind: "good" };
}

// Which sales can be voided here. A paid card sale is refunded in Stripe; a uniform on an ESA invoice stays there.
export function canVoid(s: StoreSale): boolean {
  if (s.status === "void" || s.status === "invoiced") return false;
  if (s.pay === "card" && s.status === "done") return false;
  if (s.lines.some((l) => l.esa_invoice_id)) return false;
  return true;
}

// A color name as a dot. Unknown names fall back to a neutral so nothing looks broken.
const COLOR_HEX: Record<string, string> = {
  navy: "#1C3A6E", blue: "#2F6FD1", "royal blue": "#2F5FD6", "light blue": "#8FB8EA", red: "#C8202F", black: "#111111", white: "#F5F5F5",
  gray: "#8A8F98", grey: "#8A8F98", charcoal: "#3C4048", gold: "#D9A21B", yellow: "#E8C547", green: "#2E8B57", purple: "#6B4BB3", pink: "#E07BA8", orange: "#E8732A", maroon: "#7A1F2B",
};
export function colorHex(name: string): string { return COLOR_HEX[name.trim().toLowerCase()] ?? "#B8BCC4"; }

export const PhotoFallback = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 4h8l3 3v2l-3 1v10H8V10L5 9V7Z" /><path d="M10 4c.5 1.4 1.2 2 2 2s1.5-.6 2-2" />
  </svg>
);

export function Photo({ url, alt, className }: { url: string | null; alt: string; className: string }) {
  return <span className={className} aria-hidden={url ? undefined : true}>{url ? <img src={url} alt={alt} loading="lazy" /> : PhotoFallback}</span>;
}
