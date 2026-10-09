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
  const [error, setError] = useState<string | null>(null);
  const canAdd = staff.role === "owner" || staff.role === "admin";

  useEffect(() => { api().then((a) => a.families()).then(setFams).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (canAdd) api().then((a) => a.sites()).then(setSites).catch(() => {}); }, [canAdd]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (fams ?? []).filter((f) => {
      if (!s) return true;
      const hay = [f.name, ...(f.guardians ?? []).map((g) => g.name), ...(f.children ?? []).map((c) => `${c.first_name} ${c.last_name}`)].join(" ").toLowerCase();
      return hay.includes(s);
    });
  }, [fams, q]);

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
          <input id="search" className="search" type="search" placeholder="For example: Avery, Carter, or Dana" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
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
