// Dialogs for adding and changing families, parents, children, care notes, and enrollments.
// Owners and admins see these; the database's row-level security is what actually allows the write.
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import type { CareNotes, Child, Enrollment, EnrollmentInput, EnrollmentStatus, Family, Guardian, PayMethod, Program, Site } from "../types";
import { arizonaToday, siteName, timeWords, WEEKDAYS } from "../lib/util";
import { Dialog, ErrorBox } from "../ui";

export const PAY_OPTIONS: [PayMethod, string][] = [["private", "Card or bank"], ["esa", "Arizona ESA"], ["split", "ESA for co-op, card for classes"]];
export const STATUS_WORDS: Record<EnrollmentStatus, string> = { active: "Enrolled", waitlist: "On the waitlist", hold: "On hold", dropped: "Dropped" };
const SIZES = ["YXS", "YS", "YM", "YL", "YXL", "AS", "AM", "AL", "AXL", "A2XL"];

function str(fd: FormData, k: string): string { return String(fd.get(k) ?? "").trim(); }
function orNull(v: string): string | null { return v === "" ? null : v; }
function lines(v: string): string[] { return v.split(/\n|;/).map((x) => x.trim()).filter(Boolean); }

// A small frame every edit dialog shares: title, fields, Cancel and Save, one error line, one busy flag.
function EditForm({ open, onClose, title, onSubmit, children, saveWord = "Save", danger }: {
  open: boolean; onClose: () => void; title: string; onSubmit: (fd: FormData) => Promise<void>; children: ReactNode; saveWord?: string; danger?: { word: string; onClick: () => Promise<void> };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onSubmit(new FormData(e.currentTarget)); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function doDanger() {
    if (!danger) return;
    setBusy(true); setError(null);
    try { await danger.onClick(); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 style={{ marginBottom: 12 }}>{title}</h2>
        {children}
        <ErrorBox error={error} />
        <div className="row between" style={{ marginTop: 16 }}>
          <span>{danger && <button type="button" className="btn quiet small danger" disabled={busy} onClick={doDanger}>{danger.word}</button>}</span>
          <span className="row"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button className="btn" disabled={busy}>{saveWord}</button></span>
        </div>
      </form>
    </Dialog>
  );
}

export function SiteSelect({ sites, value, name = "site_id", lock }: { sites: Site[]; value?: string; name?: string; lock?: string | null }) {
  const list = lock ? sites.filter((s) => s.id === lock) : sites;
  return (
    <div className="field"><label htmlFor={name}>Site</label>
      <select id={name} name={name} defaultValue={value ?? lock ?? list[0]?.id} required>
        {list.map((s) => <option key={s.id} value={s.id}>{s.name}{s.gym ? ` (${s.gym})` : ""}</option>)}
      </select>
    </div>
  );
}

// ---------- Family ----------
export function FamilyDialog({ open, onClose, family, sites, lockSite, onSaved }: { open: boolean; onClose: () => void; family?: Family | null; sites: Site[]; lockSite?: string | null; onSaved: (id: string) => void }) {
  const isNew = !family;
  return (
    <EditForm open={open} onClose={onClose} title={isNew ? "Add a family" : "Edit the family"} saveWord={isNew ? "Add family" : "Save"} onSubmit={async (fd) => {
      const a = await api();
      const id = await a.saveFamily({
        id: family?.id, name: str(fd, "name"), site_id: str(fd, "site_id"), pay_method: str(fd, "pay_method") as PayMethod,
        address_line1: orNull(str(fd, "address_line1")), city: orNull(str(fd, "city")), zip: orNull(str(fd, "zip")),
        text_consent: fd.get("text_consent") === "on", notes: orNull(str(fd, "notes")), status: str(fd, "status") || "active",
      });
      if (isNew) {
        const gname = str(fd, "g_name");
        if (gname) await a.saveGuardian({ family_id: id, name: gname, mobile: orNull(str(fd, "g_mobile")), email: orNull(str(fd, "g_email")), is_primary: true });
      }
      onSaved(id);
    }}>
      <div className="field"><label htmlFor="name">Family name</label><input id="name" name="name" defaultValue={family?.name ?? ""} placeholder="The Rivera family" required /></div>
      <div className="two">
        <SiteSelect sites={sites} value={family?.site_id} lock={lockSite} />
        <div className="field"><label htmlFor="pay_method">How they pay</label>
          <select id="pay_method" name="pay_method" defaultValue={family?.pay_method ?? "private"}>{PAY_OPTIONS.map(([v, w]) => <option key={v} value={v}>{w}</option>)}</select>
        </div>
      </div>
      {isNew && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}><b>Main parent or guardian.</b> You can add more on the family's page.</p>
          <div className="field"><label htmlFor="g_name">Name</label><input id="g_name" name="g_name" placeholder="Maria Rivera" required /></div>
          <div className="two">
            <div className="field"><label htmlFor="g_mobile">Mobile</label><input id="g_mobile" name="g_mobile" type="tel" placeholder="(602) 555-0142" /></div>
            <div className="field"><label htmlFor="g_email">Email</label><input id="g_email" name="g_email" type="email" /></div>
          </div>
        </>
      )}
      <div className="two">
        <div className="field"><label htmlFor="city">City</label><input id="city" name="city" defaultValue={family?.city ?? ""} /></div>
        <div className="field"><label htmlFor="zip">ZIP</label><input id="zip" name="zip" inputMode="numeric" defaultValue={family?.zip ?? ""} /></div>
      </div>
      {!isNew && <div className="field"><label htmlFor="address_line1">Street address</label><input id="address_line1" name="address_line1" defaultValue={family?.address_line1 ?? ""} /></div>}
      <label className="chk"><input type="checkbox" name="text_consent" defaultChecked={family?.text_consent ?? true} /> Okay to text this family</label>
      {!isNew && (
        <div className="field" style={{ marginTop: 12 }}><label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={family?.status ?? "active"}><option value="active">Active</option><option value="paused">Paused</option><option value="left">Left HERO</option></select>
        </div>
      )}
      <div className="field"><label htmlFor="notes">Notes for staff</label><textarea id="notes" name="notes" defaultValue={family?.notes ?? ""} placeholder="Anything the front desk should know" /></div>
    </EditForm>
  );
}

// ---------- Guardian ----------
export function GuardianDialog({ open, onClose, familyId, guardian, onSaved }: { open: boolean; onClose: () => void; familyId: string; guardian?: Guardian | null; onSaved: () => void }) {
  return (
    <EditForm open={open} onClose={onClose} title={guardian ? "Edit parent or guardian" : "Add a parent or guardian"}
      danger={guardian ? { word: "Remove", onClick: async () => { const a = await api(); await a.removeGuardian(guardian.id); onSaved(); } } : undefined}
      onSubmit={async (fd) => {
        const a = await api();
        await a.saveGuardian({ id: guardian?.id, family_id: familyId, name: str(fd, "name"), mobile: orNull(str(fd, "mobile")), email: orNull(str(fd, "email")), is_primary: fd.get("is_primary") === "on" });
        onSaved();
      }}>
      <div className="field"><label htmlFor="gname">Name</label><input id="gname" name="name" defaultValue={guardian?.name ?? ""} required /></div>
      <div className="two">
        <div className="field"><label htmlFor="gmobile">Mobile</label><input id="gmobile" name="mobile" type="tel" defaultValue={guardian?.mobile ?? ""} /></div>
        <div className="field"><label htmlFor="gemail">Email</label><input id="gemail" name="email" type="email" defaultValue={guardian?.email ?? ""} /></div>
      </div>
      <label className="chk"><input type="checkbox" name="is_primary" defaultChecked={guardian?.is_primary ?? false} /> Main contact for the family</label>
    </EditForm>
  );
}

// ---------- Child ----------
export function ChildDialog({ open, onClose, family, child, sites, houses, onSaved }: { open: boolean; onClose: () => void; family: Family; child?: Child | null; sites: Site[]; houses: string[]; onSaved: () => void }) {
  return (
    <EditForm open={open} onClose={onClose} title={child ? `Edit ${child.first_name}` : "Add a child"} saveWord={child ? "Save" : "Add child"} onSubmit={async (fd) => {
      const a = await api();
      await a.saveChild({
        id: child?.id, family_id: family.id, first_name: str(fd, "first_name"), last_name: str(fd, "last_name"), birth_date: orNull(str(fd, "birth_date")),
        site_id: str(fd, "site_id"), uniform_size: orNull(str(fd, "uniform_size")), esa: fd.get("esa") === "on", house: orNull(str(fd, "house")), active: child ? str(fd, "active_mirror") !== "off" : true,
      });
      onSaved();
    }}>
      <div className="two">
        <div className="field"><label htmlFor="first_name">First name</label><input id="first_name" name="first_name" defaultValue={child?.first_name ?? ""} required /></div>
        <div className="field"><label htmlFor="last_name">Last name</label><input id="last_name" name="last_name" defaultValue={child?.last_name ?? (family.guardians?.[0]?.name.split(" ").slice(-1)[0] ?? "")} required /></div>
      </div>
      <div className="two">
        <div className="field"><label htmlFor="birth_date">Birth date</label><input id="birth_date" name="birth_date" type="date" defaultValue={child?.birth_date ?? ""} max={arizonaToday()} /><span className="hint">Leave blank for an adult student.</span></div>
        <SiteSelect sites={sites} value={child?.site_id ?? family.site_id} />
      </div>
      <div className="two">
        <div className="field"><label htmlFor="house">House</label><input id="house" name="house" list="houses" defaultValue={child?.house ?? ""} placeholder="Not sorted yet" /><datalist id="houses">{houses.map((h) => <option key={h} value={h} />)}</datalist></div>
        <div className="field"><label htmlFor="uniform_size">Uniform size</label><input id="uniform_size" name="uniform_size" list="sizes" defaultValue={child?.uniform_size ?? ""} placeholder="YM" /><datalist id="sizes">{SIZES.map((h) => <option key={h} value={h} />)}</datalist></div>
      </div>
      <label className="chk"><input type="checkbox" name="esa" defaultChecked={child?.esa ?? family.pay_method !== "private"} /> Has an Arizona ESA account</label>
      {child && <label className="chk"><input type="checkbox" defaultChecked={child.active} onChange={(e) => { (e.currentTarget.form!.elements.namedItem("active_mirror") as HTMLInputElement).value = e.currentTarget.checked ? "on" : "off"; }} /> Still at HERO (untick when the child has left)</label>}
      {child && <input type="hidden" name="active_mirror" defaultValue={child.active ? "on" : "off"} />}
    </EditForm>
  );
}

// ---------- Care notes ----------
export function CareDialog({ open, onClose, child, onSaved }: { open: boolean; onClose: () => void; child: Child; onSaved: () => void }) {
  const c: CareNotes | null = child.care ?? null;
  return (
    <EditForm open={open} onClose={onClose} title={`Care notes for ${child.first_name}`} onSubmit={async (fd) => {
      const a = await api();
      await a.saveCare(child.id, {
        allergies: orNull(str(fd, "allergies")), medications: orNull(str(fd, "medications")), notes: orNull(str(fd, "notes")),
        emergency_contacts: lines(str(fd, "emergency")).map((l) => { const m = /^(.*?)[,:]\s*(.+)$/.exec(l); return m ? { name: m[1].trim(), phone: m[2].trim() } : { name: l, phone: "" }; }),
        authorized_pickups: lines(str(fd, "pickups")),
      });
      onSaved();
    }}>
      <p className="hint" style={{ marginBottom: 10 }}>Coaches see these on class day. Keep them short and useful at the door.</p>
      <div className="field"><label htmlFor="allergies">Allergies</label><input id="allergies" name="allergies" defaultValue={c?.allergies ?? ""} placeholder="Peanuts (carries an EpiPen)" /></div>
      <div className="field"><label htmlFor="medications">Medications to know about</label><input id="medications" name="medications" defaultValue={c?.medications ?? ""} placeholder="Inhaler in backpack" /></div>
      <div className="field"><label htmlFor="emergency">Emergency contacts, one per line as Name, phone</label><textarea id="emergency" name="emergency" defaultValue={(c?.emergency_contacts ?? []).map((x) => `${x.name}, ${x.phone}`).join("\n")} placeholder={"Grandma Rivera, (602) 555-0201"} /></div>
      <div className="field"><label htmlFor="pickups">Who may pick up, one per line</label><textarea id="pickups" name="pickups" defaultValue={(c?.authorized_pickups ?? []).join("\n")} placeholder={"Maria Rivera\nGrandma Rivera"} /></div>
      <div className="field"><label htmlFor="cnotes">Other notes</label><input id="cnotes" name="notes" defaultValue={c?.notes ?? ""} placeholder="Shy the first few weeks; pair with Leo" /></div>
    </EditForm>
  );
}

// ---------- Enrollment ----------
export function EnrollDialog({ open, onClose, child, family, programs, enrollment, onSaved }: { open: boolean; onClose: () => void; child: Child; family: Family; programs: Program[]; enrollment?: Enrollment | null; onSaved: () => void }) {
  const taken = new Set((child.enrollments ?? []).filter((e) => e.status !== "dropped").map((e) => e.program_id));
  const choices = enrollment ? programs : programs.filter((p) => !taken.has(p.id));
  const defaultPay = enrollment?.pay ?? (family.pay_method === "esa" ? "esa" : "card");
  return (
    <EditForm open={open} onClose={onClose} title={enrollment ? `${child.first_name}: ${enrollment.program?.name ?? enrollment.program_id}` : `Enroll ${child.first_name}`} saveWord={enrollment ? "Save" : "Enroll"}
      danger={enrollment ? { word: "Remove this row", onClick: async () => { const a = await api(); await a.removeEnrollment(enrollment.id); onSaved(); } } : undefined}
      onSubmit={async (fd) => {
        const a = await api();
        const input: EnrollmentInput = {
          id: enrollment?.id, child_id: child.id, program_id: enrollment?.program_id ?? str(fd, "program_id"),
          status: str(fd, "status") as EnrollmentStatus, pay: str(fd, "pay") as "esa" | "card",
          start_date: str(fd, "start_date") || arizonaToday(), end_date: orNull(str(fd, "end_date")),
        };
        await a.saveEnrollment(input);
        onSaved();
      }}>
      {!enrollment && (
        <div className="field"><label htmlFor="program_id">Program</label>
          <select id="program_id" name="program_id" required defaultValue={choices.find((p) => p.site_id === child.site_id)?.id}>
            {choices.map((p) => <option key={p.id} value={p.id}>{p.name}{p.weekday != null ? `, ${WEEKDAYS[p.weekday]}s${p.start_time ? ` ${timeWords(p.start_time)}` : ""}` : ""} ({siteName(p.site_id)})</option>)}
          </select>
          {choices.length === 0 && <p className="hint">{child.first_name} is already in every program.</p>}
        </div>
      )}
      <div className="two">
        <div className="field"><label htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={enrollment?.status ?? "active"}>{(Object.keys(STATUS_WORDS) as EnrollmentStatus[]).map((s) => <option key={s} value={s}>{STATUS_WORDS[s]}</option>)}</select>
        </div>
        <div className="field"><label htmlFor="pay">Paid by</label>
          <select id="pay" name="pay" defaultValue={defaultPay}><option value="card">Card or bank</option><option value="esa">Arizona ESA</option></select>
        </div>
      </div>
      <div className="two">
        <div className="field"><label htmlFor="start_date">Start date</label><input id="start_date" name="start_date" type="date" defaultValue={enrollment?.start_date ?? arizonaToday()} /></div>
        <div className="field"><label htmlFor="end_date">End date, if dropping</label><input id="end_date" name="end_date" type="date" defaultValue={enrollment?.end_date ?? ""} /></div>
      </div>
      <p className="hint">Billing stays wherever it is now (Jackrabbit or Stripe); this only changes the roster.</p>
    </EditForm>
  );
}
