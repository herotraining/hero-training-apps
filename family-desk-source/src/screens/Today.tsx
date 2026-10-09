import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { Attendance, Closure, EsaInvoice, Program, RosterRow, Site, Staff } from "../types";
import { ageBand, ageOn, ageWords, arizonaNow, arizonaToday, dateWords, monthWords, timeWords, WEEKDAYS, money, siteName } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";
import { href } from "../router";

function careFlags(r: RosterRow): string[] {
  const c = r.child.care;
  if (!c) return [];
  const out: string[] = [];
  if (c.allergies) out.push(`Allergy: ${c.allergies}`);
  if (c.medications) out.push(`Medication: ${c.medications}`);
  if (c.notes) out.push(c.notes);
  return out;
}

export function Today({ staff }: { staff: Staff }) {
  const [rosters, setRosters] = useState<{ program: Program; rows: RosterRow[] }[] | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [marks, setMarks] = useState<Map<string, Attendance["status"]>>(new Map());
  const [needs, setNeeds] = useState<EsaInvoice[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [editing, setEditing] = useState<Closure | null | "new">(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, show] = useToast();
  const now = arizonaNow();
  const weekday = now.getDay();
  const today = arizonaToday();
  const canMoney = staff.role === "owner" || staff.role === "admin";
  const canMark = staff.role !== "site_lead";

  async function loadClosures() { const a = await api(); setClosures(await a.closures(today)); }

  useEffect(() => {
    (async () => {
      try {
        const a = await api();
        const [r, c, at] = await Promise.all([a.rosterFor(weekday), a.closures(today), a.attendanceFor(today)]);
        setRosters(r); setClosures(c);
        setMarks(new Map(at.map((x) => [x.enrollment_id, x.status])));
        if (canMoney) {
          const [inv, s] = await Promise.all([a.esaInvoices(), a.sites()]);
          setSites(s);
          setNeeds(inv.filter((i) => (i.status === "sent" || i.status === "submitted") && i.class_month <= today).concat(inv.filter((i) => i.status === "rejected")));
        }
      } catch (e) { setError((e as Error).message); }
    })();
  }, [weekday, today, canMoney]);

  async function mark(r: RosterRow, status: Attendance["status"]) {
    const current = marks.get(r.enrollment.id);
    const next = current === status ? null : status;
    const before = new Map(marks);
    setMarks((m) => { const n = new Map(m); if (next) n.set(r.enrollment.id, next); else n.delete(r.enrollment.id); return n; });
    try { const a = await api(); await a.markAttendance(r.enrollment.id, today, next); }
    catch (e) { setMarks(before); setError((e as Error).message); }
  }

  async function onClosure(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const a = await api();
      await a.saveClosure({ id: editing && editing !== "new" ? editing.id : undefined, site_id: String(fd.get("site_id") || "") || null, on_date: String(fd.get("on_date")), title: String(fd.get("title")).trim(), note: String(fd.get("note") ?? "").trim() || null });
      setEditing(null); show("Closure saved."); await loadClosures();
    } catch (err) { setError((err as Error).message); }
  }
  async function removeClosure(c: Closure) {
    if (!window.confirm(`Remove "${c.title}" on ${dateWords(c.on_date)}?`)) return;
    try { const a = await api(); await a.removeClosure(c.id); show("Closure removed."); await loadClosures(); }
    catch (err) { setError((err as Error).message); }
  }

  const hour = now.getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const closedToday = closures.filter((c) => c.on_date === today);
  const upcoming = closures.filter((c) => c.on_date > today);
  const kidsToday = rosters?.reduce((n, r) => n + r.rows.length, 0) ?? 0;
  const hereToday = rosters?.reduce((n, r) => n + r.rows.filter((x) => marks.get(x.enrollment.id) === "present").length, 0) ?? 0;

  return (
    <>
      <Band>
        <h1>{hello}, {staff.name.split(" ")[0]}</h1>
        <p className="lede">
          {WEEKDAYS[weekday]}, {dateWords(today)}.{" "}
          {rosters === null ? "" : kidsToday ? `${kidsToday} ${kidsToday === 1 ? "child" : "children"} across ${rosters.filter((r) => r.rows.length).length} ${rosters.filter((r) => r.rows.length).length === 1 ? "program" : "programs"} today${hereToday ? `; ${hereToday} checked in so far` : ""}.` : "No classes on the schedule today."}
        </p>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {closedToday.length > 0 && (
          <div className="section"><div className="err">{closedToday.map((c) => <div key={c.id}><b>{c.title}</b>{c.site_id ? ` (${siteName(c.site_id)})` : ""}{c.note ? ` ${c.note}` : ""}</div>)}</div></div>
        )}

        {canMoney && needs.length > 0 && (
          <div className="section">
            <h2>Needs you</h2>
            <ul className="list">
              {needs.map((i) => (
                <li key={i.id}><a className="item" href={href.family(i.child?.family_id ?? "")}>
                  <span className="n">{i.child?.first_name} {i.child?.last_name}, {monthWords(i.class_month.slice(0, 7))} ESA invoice</span>
                  <span className="k">{i.status === "rejected" ? "ClassWallet sent it back." : `Class month has started and the ${money(i.amount_cents)} invoice is still ${i.status === "submitted" ? "with the state" : "unpaid"}.`}</span>
                  <span className="p"><Tag kind={i.status === "rejected" ? "warn" : "gold"}>{i.status === "rejected" ? "Problem" : "Waiting"}</Tag></span>
                </a></li>
              ))}
            </ul>
          </div>
        )}

        <div className="section">
          <h2>Today's rosters</h2>
          {rosters === null && !error && <Loading what="rosters" />}
          {rosters && rosters.filter((r) => r.rows.length).length === 0 && (
            <div className="pane"><p className="hint">{isCoachNote(staff)}</p></div>
          )}
          {rosters?.filter((r) => r.rows.length).map(({ program, rows }) => {
            const bands = new Map<string, RosterRow[]>();
            for (const r of rows) {
              const b = ageBand(ageOn(r.child.birth_date));
              bands.set(b, [...(bands.get(b) ?? []), r]);
            }
            const here = rows.filter((x) => marks.get(x.enrollment.id) === "present").length;
            const away = rows.filter((x) => marks.get(x.enrollment.id) === "absent").length;
            return (
              <div key={program.id} className="pane">
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{program.name}</h3>
                  <span className="hint">{timeWords(program.start_time)}{program.end_time ? ` to ${timeWords(program.end_time)}` : ""} · {here}{away ? ` here, ${away} out` : " here"} of {rows.length}</span>
                </div>
                {[...bands.entries()].map(([band, list]) => (
                  <div key={band}>
                    <div className="bandhead"><h3>{band === "Adults" ? "Adults" : `Ages ${band}`}</h3><span className="hint">{list.length}</span></div>
                    <ul className="roster">
                      {list.map((r) => {
                        const flags = careFlags(r);
                        const m = marks.get(r.enrollment.id);
                        return (
                          <li key={r.child.id} className={m === "present" ? "here" : m === "absent" ? "away" : ""}>
                            <div>
                              <div className="kn">{canMoney ? <a href={href.family(r.child.family_id)}>{r.child.first_name} {r.child.last_name}</a> : `${r.child.first_name} ${r.child.last_name}`}</div>
                              <div className="km">{ageWords(r.child.birth_date)}{r.child.house ? `, House ${r.child.house}` : ""}{r.child.care?.authorized_pickups?.length ? ` · pickup: ${r.child.care.authorized_pickups.join(", ")}` : ""}</div>
                            </div>
                            <div className="row">
                              {r.enrollment.pay === "esa" && <Tag kind="esa">ESA</Tag>}
                              {canMark ? (
                                <span className="seg" role="group" aria-label={`Attendance for ${r.child.first_name}`}>
                                  <button aria-pressed={m === "present"} onClick={() => mark(r, "present")}>Here</button>
                                  <button aria-pressed={m === "absent"} onClick={() => mark(r, "absent")}>Out</button>
                                </span>
                              ) : m ? <Tag kind={m === "present" ? "good" : "warn"}>{m === "present" ? "Here" : "Out"}</Tag> : null}
                            </div>
                            {flags.map((f, i) => <div key={i} className="flag">{f}</div>)}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {(upcoming.length > 0 || canMoney) && (
          <div className="section">
            <h2>Closures coming up</h2>
            <div className="pane">
              {upcoming.map((c) => (
                <div key={c.id} className="line" style={{ alignItems: "center" }}>
                  <span>{c.title}{c.site_id ? ` (${siteName(c.site_id)})` : " (all sites)"}{c.note ? <span className="hint" style={{ display: "block" }}>{c.note}</span> : null}</span>
                  <span className="v">{dateWords(c.on_date)}{canMoney && <span className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}><button className="linkbtn" onClick={() => setEditing(c)}>edit</button><button className="linkbtn" onClick={() => removeClosure(c)}>remove</button></span>}</span>
                </div>
              ))}
              {upcoming.length === 0 && <p className="hint">No closures on the calendar.</p>}
              {canMoney && <div className="row" style={{ marginTop: 10 }}><button className="btn quiet small" onClick={() => setEditing("new")}>Add a closure</button></div>}
            </div>
          </div>
        )}
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)}>
        <form onSubmit={onClosure}>
          <h2 style={{ marginBottom: 12 }}>{editing === "new" ? "Add a closure" : "Edit closure"}</h2>
          <div className="field"><label htmlFor="title">What</label><input id="title" name="title" defaultValue={editing && editing !== "new" ? editing.title : ""} placeholder="Thanksgiving: no classes" required /></div>
          <div className="two">
            <div className="field"><label htmlFor="on_date">Date</label><input id="on_date" name="on_date" type="date" defaultValue={editing && editing !== "new" ? editing.on_date : ""} required /></div>
            <div className="field"><label htmlFor="site_id">Site</label>
              <select id="site_id" name="site_id" defaultValue={editing && editing !== "new" ? editing.site_id ?? "" : staff.site_id ?? ""}>
                {!staff.site_id && <option value="">All sites</option>}
                {sites.filter((s) => !staff.site_id || s.id === staff.site_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="note">Note for staff</label><input id="note" name="note" defaultValue={editing && editing !== "new" ? editing.note ?? "" : ""} placeholder="Gym is hosting a meet" /></div>
          <div className="row end"><button type="button" className="btn quiet" onClick={() => setEditing(null)}>Cancel</button><button className="btn">Save</button></div>
        </form>
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}

function isCoachNote(staff: Staff): string {
  if (staff.role === "coach") return "Nothing on your schedule today. Your rosters appear here on the days you coach; care notes show on class day only.";
  return "No classes today. Rosters for each site and group appear here on class days.";
}
