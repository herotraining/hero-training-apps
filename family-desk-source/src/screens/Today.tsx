import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Closure, EsaInvoice, Program, RosterRow, Staff } from "../types";
import { ageBand, ageOn, arizonaNow, arizonaToday, dateWords, monthWords, timeWords, WEEKDAYS, money, siteName } from "../lib/util";
import { Band, ErrorBox, Loading, Tag } from "../ui";
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
  const [needs, setNeeds] = useState<EsaInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = arizonaNow();
  const weekday = now.getDay();
  const today = arizonaToday();
  const canMoney = staff.role === "owner" || staff.role === "admin";

  useEffect(() => {
    (async () => {
      try {
        const a = await api();
        const [r, c] = await Promise.all([a.rosterFor(weekday), a.closures(today)]);
        setRosters(r); setClosures(c);
        if (canMoney) {
          const inv = await a.esaInvoices();
          setNeeds(inv.filter((i) => (i.status === "sent" || i.status === "submitted") && i.class_month <= today).concat(inv.filter((i) => i.status === "rejected")));
        }
      } catch (e) { setError((e as Error).message); }
    })();
  }, [weekday, today, canMoney]);

  const hour = now.getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const closedToday = closures.filter((c) => c.on_date === today);
  const kidsToday = rosters?.reduce((n, r) => n + r.rows.length, 0) ?? 0;

  return (
    <>
      <Band>
        <h1>{hello}, {staff.name.split(" ")[0]}</h1>
        <p className="lede">
          {WEEKDAYS[weekday]}, {dateWords(today)}.{" "}
          {rosters === null ? "" : kidsToday ? `${kidsToday} ${kidsToday === 1 ? "child" : "children"} across ${rosters.filter((r) => r.rows.length).length} ${rosters.filter((r) => r.rows.length).length === 1 ? "program" : "programs"} today.` : "No classes on the schedule today."}
        </p>
      </Band>
      <div className="page">
        <ErrorBox error={error} />
        {closedToday.length > 0 && (
          <div className="section"><div className="err">{closedToday.map((c) => <div key={c.id}><b>{c.title}</b>{c.note ? ` ${c.note}` : ""}</div>)}</div></div>
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
            return (
              <div key={program.id} className="pane">
                <div className="row between">
                  <h3 style={{ margin: 0 }}>{program.name}</h3>
                  <span className="hint">{timeWords(program.start_time)}{program.end_time ? ` to ${timeWords(program.end_time)}` : ""} · {rows.length} {rows.length === 1 ? "child" : "children"}</span>
                </div>
                {[...bands.entries()].map(([band, list]) => (
                  <div key={band}>
                    <div className="bandhead"><h3>Ages {band}</h3><span className="hint">{list.length}</span></div>
                    <ul className="roster">
                      {list.map((r) => {
                        const flags = careFlags(r);
                        return (
                          <li key={r.child.id}>
                            <div><div className="kn">{r.child.first_name} {r.child.last_name}</div><div className="km">{ageOn(r.child.birth_date)} years old{r.child.house ? `, House ${r.child.house}` : ""}</div></div>
                            <div className="row">{r.enrollment.pay === "esa" && <Tag kind="esa">ESA</Tag>}{r.child.care?.authorized_pickups?.length ? <span className="hint">Pickup: {r.child.care.authorized_pickups.join(", ")}</span> : null}</div>
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

        {closures.filter((c) => c.on_date > today).length > 0 && (
          <div className="section">
            <h2>Coming up</h2>
            <div className="pane">
              {closures.filter((c) => c.on_date > today).map((c) => (
                <div key={c.id} className="line"><span>{c.title}{c.site_id ? ` (${siteName(c.site_id)})` : ""}</span><span className="v">{dateWords(c.on_date)}</span></div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function isCoachNote(staff: Staff): string {
  if (staff.role === "coach") return "Nothing on your schedule today. Your rosters appear here on the days you coach; care notes show on class day only.";
  return "No classes today. Rosters for each site and group appear here on class days.";
}
