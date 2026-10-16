import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { Program, Site, Staff, TrainerPay } from "../types";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { WEEKDAYS, arizonaNow, dateWords, money, siteName } from "../lib/util";

const ROLE_WORDS: Record<Staff["role"], string> = { owner: "Owner", admin: "Admin", site_lead: "Site lead", coach: "Coach" };

export function StaffScreen() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [assign, setAssign] = useState<{ staff_id: string; program_id: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [handoff, setHandoff] = useState<{ name: string; email: string; password: string; kind: "create" | "reset" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState<TrainerPay[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [toast, show] = useToast();
  const year = arizonaNow().getFullYear();

  async function load() {
    const a = await api();
    const [s, si, p, ca, tp] = await Promise.all([a.staff(), a.sites(), a.programs(), a.coachAssignments(), a.trainerPay(`${year}-01-01`).catch(() => [] as TrainerPay[])]);
    setStaff(s); setSites(si); setPrograms(p); setAssign(ca); setPay(tp);
  }
  // Per person this year, from the Venmo receipts the morning sweep reads (owners only; the table is empty for anyone else).
  const payByPerson = [...pay.reduce((m, r) => {
    const cur = m.get(r.payee) ?? { payee: r.payee, kind: r.kind, total: 0, n: 0, hours: 0, last: r.paid_on };
    cur.total += r.amount_cents; cur.n += 1; cur.hours += r.hours ?? 0; if (r.paid_on > cur.last) cur.last = r.paid_on;
    return m.set(r.payee, cur);
  }, new Map<string, { payee: string; kind: TrainerPay["kind"]; total: number; n: number; hours: number; last: string }>()).values()].sort((a, b) => b.total - a.total);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try {
      const a = await api();
      await a.addStaff({ email: String(fd.get("email")).trim().toLowerCase(), name: String(fd.get("name")).trim(), role: fd.get("role") as Staff["role"], site_id: String(fd.get("site") || "") || null });
      setAdding(false); show("Added. They can now create their password on the sign-in page.");
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function onAssign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const ids = new FormData(e.currentTarget).getAll("program").map(String);
    setBusy(true);
    try { const a = await api(); await a.setCoachAssignments(editing.id, ids); setEditing(null); show(`${editing.name}'s programs saved.`); await load(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function signin(s: Staff, action: "create" | "reset" | "reset_2fa") {
    if (action === "reset_2fa" && !window.confirm(`Remove ${s.name}'s authenticator? They set up a new one at their next sign-in.`)) return;
    setBusy(true); setError(null);
    try {
      const a = await api();
      const r = await a.staffSignin(s.id, action);
      if (action === "reset_2fa") show(`${s.name}'s two-step code was reset.`);
      else setHandoff({ name: s.name, email: r.email ?? s.email, password: r.password ?? "", kind: action });
      await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function toggle(s: Staff) {
    try { const a = await api(); await a.setStaffActive(s.id, !s.active); show(s.active ? `${s.name} can no longer sign in.` : `${s.name} can sign in again.`); await load(); }
    catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <Band>
        <h1>Staff</h1>
        <p className="lede">Who can sign in, and what each person sees. Add someone, create their sign-in, and hand them the temporary password in person.</p>
        <div className="row"><button className="btn" onClick={() => setAdding(true)}>Add a staff member</button></div>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {staff === null && !error && <Loading what="staff" />}
        {staff && (
          <ul className="list">
            {staff.map((s) => {
              const progs = assign.filter((a) => a.staff_id === s.id).map((a) => programs.find((p) => p.id === a.program_id)?.name ?? a.program_id);
              return (
                <li key={s.id}>
                  <div className="item">
                    <span className="n">{s.name}</span>
                    <span className="k">{s.email} · {ROLE_WORDS[s.role]}{s.site_id ? ` for ${siteName(s.site_id)}` : ""}{s.user_id ? "" : " · no sign-in yet"}{progs.length ? ` · coaches ${progs.join(", ")}` : s.role === "coach" ? " · no programs assigned yet" : ""}</span>
                    <span className="p">
                      {!s.active && <Tag kind="warn">Off</Tag>}
                      {s.active && !s.user_id && <button className="btn small" disabled={busy} onClick={() => signin(s, "create")}>Create sign-in</button>}
                      {s.active && s.user_id && <button className="btn quiet small" disabled={busy} onClick={() => signin(s, "reset")}>Reset password</button>}
                      {s.active && s.user_id && <button className="btn quiet small" disabled={busy} onClick={() => signin(s, "reset_2fa")}>Reset 2-step</button>}
                      {(s.role === "coach" || s.role === "site_lead") && <button className="btn quiet small" onClick={() => setEditing(s)}>Programs</button>}
                      <button className="btn quiet small" onClick={() => toggle(s)}>{s.active ? "Turn off" : "Turn on"}</button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint" style={{ marginTop: 16 }}>Owners see everything. Admins handle families and money (pin one to a site, like Mary for Mesa). Site leads see their site's rosters. Coaches see their own programs' rosters, with care notes on class day only.</p>

        {pay.length > 0 && (
          <div className="section">
            <div className="row between"><h2 style={{ margin: 0 }}>Paid by Venmo, {year}</h2><button className="linkbtn" onClick={() => setPayOpen((v) => !v)}>{payOpen ? "Hide" : "Show"}</button></div>
            {payOpen && (
              <div className="pane" style={{ marginTop: 10 }}>
                {payByPerson.map((p) => (
                  <div key={p.payee} className="line">
                    <span>{p.payee}<span className="hint" style={{ display: "block" }}>{p.kind === "facility" ? "facility fees" : p.kind === "trainer" ? "trainer pay" : "other"} · {p.n} {p.n === 1 ? "payment" : "payments"}{p.hours ? ` · ${p.hours} hours` : ""} · last {dateWords(p.last)}</span></span>
                    <span className="v">{money(p.total)}</span>
                  </div>
                ))}
                <div className="line"><span><b>Total</b></span><span className="v"><b>{money(pay.reduce((n, r) => n + r.amount_cents, 0))}</b></span></div>
                <p className="hint">From the Venmo receipts in the front-desk inbox, read by the morning sweep; the same lines are categorized in SuperBooks. Owners only. This is what the accountant needs for 1099s.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={adding} onClose={() => setAdding(false)}>
        <form onSubmit={onAdd}>
          <h2>Add a staff member</h2>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="name">Name</label><input id="name" name="name" required /></div>
          <div className="field"><label htmlFor="email">Email they'll sign in with</label><input id="email" name="email" type="email" required /></div>
          <div className="two">
            <div className="field"><label htmlFor="role">Role</label><select id="role" name="role" defaultValue="coach">{(Object.keys(ROLE_WORDS) as Staff["role"][]).map((r) => <option key={r} value={r}>{ROLE_WORDS[r]}</option>)}</select></div>
            <div className="field"><label htmlFor="site">Limit to a site</label><select id="site" name="site" defaultValue=""><option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </div>
          <div className="row end"><button type="button" className="btn quiet" onClick={() => setAdding(false)}>Cancel</button><button className="btn" disabled={busy}>Add</button></div>
        </form>
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)}>
        <form onSubmit={onAssign}>
          <h2>{editing?.name}'s programs</h2>
          <p className="hint">They see the roster for each checked program, and care notes on that program's class day.</p>
          <div className="checks" style={{ marginTop: 12 }}>
            {programs.map((p) => (
              <label key={p.id}><input type="checkbox" name="program" value={p.id} defaultChecked={assign.some((a) => a.staff_id === editing?.id && a.program_id === p.id)} /> {p.name}{p.weekday != null ? ` (${WEEKDAYS[p.weekday].slice(0, 3)})` : ""}</label>
            ))}
          </div>
          <div className="row end" style={{ marginTop: 16 }}><button type="button" className="btn quiet" onClick={() => setEditing(null)}>Cancel</button><button className="btn" disabled={busy}>Save</button></div>
        </form>
      </Dialog>
      <Dialog open={!!handoff} onClose={() => setHandoff(null)}>
        <h2>{handoff?.kind === "create" ? `${handoff?.name}'s sign-in is ready` : `New password for ${handoff?.name}`}</h2>
        <p className="hint" style={{ marginTop: 8 }}>Give this to {handoff?.name} in person or by phone, not by text or email. It shows only once. They sign in at this site, set up their two-step code, and are then asked to choose their own password before they can do anything else.</p>
        <div className="line" style={{ marginTop: 12 }}><span>Email</span><span className="v">{handoff?.email}</span></div>
        <div className="line"><span>Temporary password</span><span className="v secret">{handoff?.password}</span></div>
        <div className="row end" style={{ marginTop: 16 }}><button className="btn" onClick={() => setHandoff(null)}>Done, I've passed it on</button></div>
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}
