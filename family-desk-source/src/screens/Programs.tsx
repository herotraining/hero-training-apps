// Owners keep the program list here: what runs where, on which day, and the monthly price.
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { Program, Site } from "../types";
import { money, siteName, timeWords, WEEKDAYS } from "../lib/util";
import { Band, Dialog, ErrorBox, Loading, Tag, Toast, useToast } from "../ui";

const KINDS: [string, string][] = [["coop", "Co-op Day"], ["class", "Class"], ["tumbling", "Tumbling"], ["gymnastics", "Gymnastics"], ["rally_saber", "Rally Saber"], ["star_team", "Star Team"], ["family_fitness", "Family Fitness"], ["other", "Other"]];

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48); }

export function Programs() {
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [editing, setEditing] = useState<Program | null | "new">(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, show] = useToast();

  async function load() { const a = await api(); const [p, s] = await Promise.all([a.allPrograms(), a.sites()]); setPrograms(p); setSites(s); }
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name")).trim();
    const cur = editing && editing !== "new" ? editing : null;
    const id = cur?.id ?? (slug(name) || "program") + (programs?.some((p) => p.id === slug(name)) ? "-" + Date.now().toString(36) : "");
    const wd = String(fd.get("weekday"));
    setBusy(true); setError(null);
    try {
      const a = await api();
      await a.saveProgram({
        id, name, kind: String(fd.get("kind")), site_id: String(fd.get("site_id")), weekday: wd === "" ? null : Number(wd),
        start_time: String(fd.get("start_time") || "") || null, end_time: String(fd.get("end_time") || "") || null,
        monthly_price_cents: Math.round(Number(fd.get("price") || 0) * 100), active: fd.get("active") === "on",
      });
      setEditing(null); show(cur ? "Program saved." : "Program added."); await load();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const cur = editing && editing !== "new" ? editing : null;
  const bySite = new Map<string, Program[]>();
  for (const p of programs ?? []) bySite.set(p.site_id, [...(bySite.get(p.site_id) ?? []), p]);

  return (
    <>
      <Band>
        <h1>Programs</h1>
        <p className="lede">Every program, site, and day. Enrollments and rosters hang off these, so rename rather than delete; turn a program off when it stops running.</p>
        <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => setEditing("new")}>Add a program</button></div>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {programs === null && !error && <Loading what="programs" />}
        {[...bySite.entries()].map(([site, list]) => (
          <div key={site} className="section">
            <h2>{siteName(site)}</h2>
            <ul className="list">
              {list.map((p) => (
                <li key={p.id}>
                  <div className="item">
                    <span className="n">{p.name}{p.active === false && <Tag kind="warn">Off</Tag>}</span>
                    <span className="k">{p.weekday != null ? `${WEEKDAYS[p.weekday]}s` : "No set day"}{p.start_time ? `, ${timeWords(p.start_time)}${p.end_time ? ` to ${timeWords(p.end_time)}` : ""}` : ""} · {money(p.monthly_price_cents)} a month · {KINDS.find((k) => k[0] === p.kind)?.[1] ?? p.kind}</span>
                    <span className="p"><button className="btn quiet small" onClick={() => setEditing(p)}>Edit</button></span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="hint" style={{ marginTop: 20 }}>Prices here are what the ESA invoices use. Stripe's own prices are set in Stripe; keep the two the same.</p>
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)}>
        <form onSubmit={onSave}>
          <h2 style={{ marginBottom: 12 }}>{cur ? "Edit program" : "Add a program"}</h2>
          <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" defaultValue={cur?.name ?? ""} placeholder="Co-op Day, Peoria, Tuesdays" required /></div>
          <div className="two">
            <div className="field"><label htmlFor="kind">Kind</label><select id="kind" name="kind" defaultValue={cur?.kind ?? "coop"}>{KINDS.map(([v, w]) => <option key={v} value={v}>{w}</option>)}</select></div>
            <div className="field"><label htmlFor="site_id">Site</label><select id="site_id" name="site_id" defaultValue={cur?.site_id ?? sites[0]?.id}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          </div>
          <div className="two">
            <div className="field"><label htmlFor="weekday">Day</label>
              <select id="weekday" name="weekday" defaultValue={cur?.weekday == null ? "" : String(cur.weekday)}>
                <option value="">No set day</option>
                {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}s</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="price">Monthly price ($)</label><input id="price" name="price" type="number" min="0" step="1" defaultValue={cur ? cur.monthly_price_cents / 100 : ""} required /></div>
          </div>
          <div className="two">
            <div className="field"><label htmlFor="start_time">Starts</label><input id="start_time" name="start_time" type="time" defaultValue={cur?.start_time?.slice(0, 5) ?? ""} /></div>
            <div className="field"><label htmlFor="end_time">Ends</label><input id="end_time" name="end_time" type="time" defaultValue={cur?.end_time?.slice(0, 5) ?? ""} /></div>
          </div>
          <label className="chk"><input type="checkbox" name="active" defaultChecked={cur ? cur.active !== false : true} /> Running (shows on rosters and in Enroll)</label>
          <div className="row end"><button type="button" className="btn quiet" onClick={() => setEditing(null)}>Cancel</button><button className="btn" disabled={busy}>{cur ? "Save" : "Add program"}</button></div>
        </form>
      </Dialog>
      <Toast msg={toast} />
    </>
  );
}
