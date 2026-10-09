import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Family, Site, Staff } from "../types";
import { Band, ErrorBox, Loading, Tag } from "../ui";
import { href } from "../router";
import { siteName } from "../lib/util";
import { FamilyDialog } from "./FamilyEdit";

const PAY: Record<Family["pay_method"], [string, "esa" | "gold" | undefined]> = { esa: ["ESA", "esa"], private: ["Card or bank", undefined], split: ["ESA and card", "gold"] };

export function Families({ staff }: { staff: Staff }) {
  const [fams, setFams] = useState<Family[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [site, setSite] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const canAdd = staff.role === "owner" || staff.role === "admin";

  useEffect(() => { api().then((a) => a.families()).then(setFams).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (canAdd) api().then((a) => a.sites()).then(setSites).catch(() => {}); }, [canAdd]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, "");
    return (fams ?? []).filter((f) => {
      if (site && f.site_id !== site) return false;
      if (!s) return true;
      const hay = [f.name, ...(f.guardians ?? []).flatMap((g) => [g.name, g.email ?? ""]), ...(f.children ?? []).map((c) => `${c.first_name} ${c.last_name}`)].join(" ").toLowerCase();
      if (hay.includes(s)) return true;
      return digits.length >= 4 && (f.guardians ?? []).some((g) => (g.mobile ?? "").replace(/\D/g, "").includes(digits));
    });
  }, [fams, q, site]);
  const siteIds = useMemo(() => [...new Set((fams ?? []).map((f) => f.site_id))].sort(), [fams]);

  return (
    <>
      <Band>
        <h1>Families</h1>
        <p className="lede">Type any parent or child name. Everything about the family is one tap away.</p>
        {canAdd && <div className="row" style={{ marginTop: 6 }}><button className="btn" onClick={() => setAdding(true)}>Add a family</button></div>}
      </Band>
      <div className="page">
        <div className="section">
          <label htmlFor="search" className="hint">Search families and children</label>
          <input id="search" className="search" type="search" placeholder="A parent, a child, an email, or a phone number" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
          {siteIds.length > 1 && (
            <div className="chips" role="group" aria-label="Site">
              <button className="chipbtn" aria-pressed={site === ""} onClick={() => setSite("")}>All sites</button>
              {siteIds.map((id) => <button key={id} className="chipbtn" aria-pressed={site === id} onClick={() => setSite(id)}>{siteName(id)}</button>)}
              <span className="hint" style={{ alignSelf: "center" }}>{rows.length} {rows.length === 1 ? "family" : "families"}</span>
            </div>
          )}
          <ErrorBox error={error} />
          {fams === null && !error && <Loading what="families" />}
          {fams && (
            <ul className="list" style={{ marginTop: 14 }}>
              {rows.map((f) => {
                const [label, kind] = PAY[f.pay_method];
                const kids = (f.children ?? []).filter((c) => c.active).map((c) => c.first_name);
                const waits = (f.children ?? []).some((c) => (c.enrollments ?? []).some((e) => e.status === "waitlist"));
                return (
                  <li key={f.id}>
                    <a className="item" href={href.family(f.id)}>
                      <span className="n">{f.name}</span>
                      <span className="k">{kids.length ? kids.join(" and ") : "No children yet"} · {siteName(f.site_id)}</span>
                      <span className="p">{waits && <Tag>Waitlist</Tag>}<Tag kind={kind}>{label}</Tag></span>
                    </a>
                  </li>
                );
              })}
              {rows.length === 0 && <li className="empty">{fams.length === 0 ? "No families yet." : `No family or child matches "${q}". Check the spelling, or search by a parent's name.`}</li>}
            </ul>
          )}
        </div>
      </div>
      {canAdd && <FamilyDialog open={adding} onClose={() => setAdding(false)} sites={sites} lockSite={staff.site_id} onSaved={(id) => { location.hash = href.family(id); }} />}
    </>
  );
}
