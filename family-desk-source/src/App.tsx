import { useEffect, useState } from "react";
import { api, IS_MOCK } from "./lib/api";
import type { Profile } from "./types";
import { useRoute } from "./router";
import { Shell } from "./Shell";
import { Today } from "./screens/Today";
import { Families } from "./screens/Families";
import { Family } from "./screens/Family";
import { Money } from "./screens/Money";
import { Store } from "./screens/Store";
import { StaffScreen } from "./screens/StaffScreen";
import { Programs } from "./screens/Programs";
import { UniformRequest } from "./screens/UniformRequest";
import { ErrorBox, Icon } from "./ui";

function Screens({ signOut }: { signOut: () => void }) {
  const route = useRoute();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api().then((a) => a.profile()).then(setProfile).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="auth"><div className="card"><ErrorBox error={error} /><button className="btn quiet" style={{ marginTop: 14 }} onClick={signOut}>Sign out</button></div></div>;
  if (!profile) return <div className="auth"><p className="hint">Loading…</p></div>;
  if (!profile.staff) {
    return (
      <div className="auth"><div className="card">
        <div className="mark">{Icon.star}<div><b>HERO</b><span>Family Desk</span></div></div>
        <h2>Your account isn't on the staff list</h2>
        <p className="hint" style={{ marginTop: 8 }}>Ask an owner to add your email under Staff, or check that you signed in with the right one.</p>
        <button className="btn quiet" style={{ marginTop: 14 }} onClick={signOut}>Sign out</button>
      </div></div>
    );
  }
  const staff = profile.staff;
  const canMoney = staff.role === "owner" || staff.role === "admin";
  let screen;
  if (route.name === "families" && staff.role !== "coach") screen = <Families staff={staff} />;
  else if (route.name === "family" && staff.role !== "coach") screen = <Family id={route.id} staff={staff} />;
  else if (route.name === "money" && canMoney) screen = <Money />;
  else if (route.name === "store" && canMoney) screen = <Store key={route.familyId ?? ""} staff={staff} familyId={route.familyId} />;
  else if (route.name === "staff" && staff.role === "owner") screen = <StaffScreen />;
  else if (route.name === "programs" && staff.role === "owner") screen = <Programs />;
  else screen = <Today staff={staff} />;

  return <Shell staff={staff} route={route} onSignOut={signOut} mock={IS_MOCK}>{screen}</Shell>;
}

type GateComponent = (p: { children: (s: () => void) => React.ReactNode }) => React.ReactNode;

export function App() {
  const route = useRoute();
  // The sign-in gate loads lazily so the demo build never touches Supabase.
  const [Gate, setGate] = useState<GateComponent | null>(null);
  useEffect(() => { if (!IS_MOCK && route.name !== "request") import("./auth/Auth").then((m) => setGate(() => m.AuthGate)); }, [route.name]);
  // The one page parents see: a uniform request from the Family Hub, with no staff sign-in.
  if (route.name === "request") return <UniformRequest />;
  if (IS_MOCK) return <Screens signOut={() => {}} />;
  if (!Gate) return <div className="auth"><p className="hint">Loading…</p></div>;
  return <Gate>{(signOut) => <Screens signOut={signOut} />}</Gate>;
}
