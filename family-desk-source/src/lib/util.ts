export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents % 100 ? 2 : 0 });

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Arizona has no daylight saving: UTC-7 all year.
export function arizonaNow(): Date {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() - 420) * 60000);
}
export function arizonaToday(): string {
  const d = arizonaNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ageOn(birth: string | null | undefined, on = arizonaToday()): number | null {
  if (!birth) return null;
  const b = new Date(birth + "T12:00:00"), d = new Date(on + "T12:00:00");
  let a = d.getFullYear() - b.getFullYear();
  if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) a--;
  return a;
}
export function ageWords(birth: string | null | undefined): string {
  const a = ageOn(birth);
  return a === null ? "birth date not on file" : `${a} years old`;
}
export function ageBand(age: number | null): string {
  if (age === null) return "Adults";
  if (age <= 6) return "4 to 6";
  if (age <= 9) return "7 to 9";
  return "10 and up";
}

export function dateWords(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === arizonaNow().getFullYear() ? undefined : "numeric" });
}
export function unixWords(s: number | null | undefined): string {
  if (!s) return "";
  return new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Phoenix" });
}
export function monthWords(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
export function timeWords(t: string | null): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, "0")} ${ampm}` : `${hh} ${ampm}`;
}

export const ESA_LABEL: Record<string, string> = {
  draft: "Not sent yet",
  sent: "Sent to family",
  submitted: "Family submitted it",
  paid: "Paid",
  rejected: "Sent back by ClassWallet",
  void: "Canceled",
};

export const SITE_NAMES: Record<string, string> = { peoria: "Peoria", mesa: "Mesa", prescott: "Prescott", lab: "L.A.B." };
export const siteName = (id: string | null | undefined) => (id ? SITE_NAMES[id] ?? id : "");
