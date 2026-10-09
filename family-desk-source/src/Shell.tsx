import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "./lib/api";
import { Dialog, ErrorBox, Toast, useToast } from "./ui";
import type { Staff } from "./types";
import { href, type Route } from "./router";
import { Icon } from "./ui";
import { siteName } from "./lib/util";

const ROLE_WORDS: Record<Staff["role"], string> = { owner: "Owner", admin: "Admin", site_lead: "Site lead", coach: "Coach" };

export function Shell({ staff, route, onSignOut, mock, children }: { staff: Staff; route: Route; onSignOut: () => void; mock: boolean; children: ReactNode }) {
  const isCoach = staff.role === "coach";
  const canMoney = staff.role === "owner" || staff.role === "admin";
  const items: { key: Route["name"] | "family"; label: string; to: string; icon: ReactNode; show: boolean }[] = [
    { key: "today", label: "Today", to: href.today, icon: Icon.today, show: true },
    { key: "families", label: "Families", to: href.families, icon: Icon.families, show: !isCoach },
    { key: "money", label: "Money", to: href.money, icon: Icon.money, show: canMoney },
    { key: "staff", label: "Staff", to: href.staff, icon: Icon.staff, show: staff.role === "owner" },
  ];
  const current = (k: string) => route.name === k || (k === "families" && route.name === "family");
  const nav = items.filter((i) => i.show);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, show] = useToast();
  async function onChange(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pw = String(new FormData(e.currentTarget).get("password") ?? "");
    setBusy(true); setError(null);
    try { const a = await api(); await a.changePassword(pw); setChanging(false); show("Password changed."); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const who = (
    <div className="who"><b>{staff.name}</b><span>{ROLE_WORDS[staff.role]}{staff.site_id ? `, ${siteName(staff.site_id)}` : ""}{mock ? " (demo data)" : ""}</span>
      {!mock && <div className="row" style={{ gap: 12 }}><button onClick={() => setChanging(true)}>Change password</button><button onClick={onSignOut}>Sign out</button></div>}
    </div>
  );
  return (
    <div className="shell">
      <aside className="rail" aria-label="Main">
        <div className="mark">{Icon.star}<div><b>HERO</b><span>Family Desk</span></div></div>
        <nav className="nav">
          {nav.map((i) => <a key={i.key} href={i.to} aria-current={current(i.key) ? "page" : undefined}>{i.icon}{i.label}</a>)}
        </nav>
        {who}
      </aside>
      <main id="main">
        <div className="topbar">
          <div className="mark">{Icon.star}<div><b>HERO</b></div></div>
          {who}
        </div>
        {children}
      </main>
      <nav className="tabbar" aria-label="Sections">
        {nav.map((i) => <a key={i.key} href={i.to} aria-current={current(i.key) ? "page" : undefined}>{i.icon}{i.label}</a>)}
      </nav>
      <Dialog open={changing} onClose={() => setChanging(false)}>
        <form onSubmit={onChange}>
          <h2>Change your password</h2>
          <div className="field" style={{ marginTop: 12 }}><label htmlFor="newpw">New password</label><input id="newpw" name="password" type="password" autoComplete="new-password" minLength={10} required /></div>
          <p className="hint">At least 10 characters. A short sentence you'll remember works well.</p>
          <ErrorBox error={error} />
          <div className="row end" style={{ marginTop: 16 }}><button type="button" className="btn quiet" onClick={() => setChanging(false)}>Cancel</button><button className="btn" disabled={busy}>Save</button></div>
        </form>
      </Dialog>
      <Toast msg={toast} />
    </div>
  );
}
