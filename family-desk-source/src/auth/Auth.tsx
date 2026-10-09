import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { ErrorBox, Icon } from "../ui";

type Stage = "loading" | "signin" | "enroll" | "verify" | "ready";

function friendly(msg: string): string {
  if (/staff list/i.test(msg)) return "That email isn't on the HERO staff list. Ask an owner to add you in Family Desk, then try again.";
  if (/Invalid login credentials/i.test(msg)) return "That email and password don't match.";
  if (/rate limit/i.test(msg)) return "Too many tries. Wait a minute and try again.";
  return msg;
}

export function AuthGate({ children }: { children: (signOut: () => void) => React.ReactNode }) {
  const [stage, setStage] = useState<Stage>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [factorId, setFactorId] = useState<string>("");
  const [qr, setQr] = useState<string>("");
  const [secret, setSecret] = useState<string>("");

  const sb = supabase();

  async function decide() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setStage("signin"); return; }
    const { data: aal, error: e1 } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (e1) { setError(e1.message); setStage("signin"); return; }
    if (aal.currentLevel === "aal2") { setStage("ready"); return; }
    const { data: factors, error: e2 } = await sb.auth.mfa.listFactors();
    if (e2) { setError(e2.message); setStage("signin"); return; }
    const verified = factors.totp.find((f) => f.status === "verified");
    if (verified) { setFactorId(verified.id); setStage("verify"); return; }
    // No authenticator yet: enroll one. Remove any unverified leftovers first.
    for (const f of factors.totp.filter((f) => f.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data: enr, error: e3 } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "HERO Family Desk" });
    if (e3) { setError(e3.message); setStage("signin"); return; }
    setFactorId(enr.id); setQr(enr.totp.qr_code); setSecret(enr.totp.secret); setStage("enroll");
  }

  useEffect(() => {
    decide();
    const { data: sub } = sb.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") setStage("signin");
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const password = String(fd.get("password") ?? "");
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await decide();
    } catch (err) {
      setError(friendly((err as Error).message));
    } finally { setBusy(false); }
  }

  async function onCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setBusy(true);
    const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s/g, "");
    try {
      const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId });
      if (e1) throw e1;
      const { error: e2 } = await sb.auth.mfa.verify({ factorId, challengeId: ch.id, code });
      if (e2) throw e2;
      setStage("ready");
    } catch (err) {
      setError(/invalid/i.test((err as Error).message) ? "That code didn't match. Codes change every 30 seconds; try the newest one." : (err as Error).message);
    } finally { setBusy(false); }
  }

  const signOut = () => { sb.auth.signOut(); };

  if (stage === "ready") return <>{children(signOut)}</>;

  return (
    <div className="auth">
      <div className="card">
        <div className="mark">{Icon.star}<div><b>HERO</b><span>Family Desk</span></div></div>
        {stage === "loading" && <p className="hint">Checking your sign-in…</p>}

        {stage === "signin" && (
          <form onSubmit={onSignIn}>
            <h2 style={{ marginBottom: 6 }}>Sign in</h2>
            <p className="hint" style={{ marginBottom: 14 }}>Staff only. Families use hero.training.</p>
            <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
            <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
            <ErrorBox error={error} />
            {notice && <p className="ok" style={{ marginTop: 12 }}>{notice}</p>}
            <div className="row between" style={{ marginTop: 16 }}>
              <span className="hint">New here, or forgot your password? Ask an owner; they can hand you a temporary one.</span>
              <button className="btn" disabled={busy}>Sign in</button>
            </div>
          </form>
        )}

        {stage === "enroll" && (
          <form onSubmit={onCode}>
            <h2 style={{ marginBottom: 6 }}>Set up your two-step code</h2>
            <p className="hint">Family Desk holds children's records, so every staff login needs a code from an authenticator app. Open Google Authenticator, 1Password, or any authenticator app and scan this.</p>
            {qr && <img className="qr" src={qr} alt="QR code to scan in your authenticator app" />}
            <details><summary className="hint" style={{ cursor: "pointer" }}>Can't scan? Type the key instead</summary><p className="secret">{secret}</p></details>
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="code">Enter the 6-digit code it shows</label><input id="code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" required /></div>
            <ErrorBox error={error} />
            <div className="row between" style={{ marginTop: 16 }}>
              <button type="button" className="back" style={{ margin: 0 }} onClick={signOut}>Sign out</button>
              <button className="btn" disabled={busy}>Finish setup</button>
            </div>
          </form>
        )}

        {stage === "verify" && (
          <form onSubmit={onCode}>
            <h2 style={{ marginBottom: 6 }}>Two-step code</h2>
            <p className="hint">Open your authenticator app and enter the code for HERO Family Desk.</p>
            <div className="field" style={{ marginTop: 14 }}><label htmlFor="code">6-digit code</label><input id="code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" autoComplete="one-time-code" autoFocus required /></div>
            <ErrorBox error={error} />
            <div className="row between" style={{ marginTop: 16 }}>
              <button type="button" className="back" style={{ margin: 0 }} onClick={signOut}>Sign out</button>
              <button className="btn" disabled={busy}>Continue</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
