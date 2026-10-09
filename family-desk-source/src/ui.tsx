import { useEffect, useRef, useState, type ReactNode } from "react";

export const Icon = {
  star: <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 14.4 9.6 22.5 12 14.4 14.4 12 22.5 9.6 14.4 1.5 12 9.6 9.6Z" fill="currentColor" /></svg>,
  today: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /><circle cx="12" cy="12" r="4" /></svg>,
  families: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><circle cx="17" cy="9.5" r="2.4" /><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5M15 15.2c2.6-.4 5 1.2 5.6 4.8" /></svg>,
  money: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  programs: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  staff: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6" /><path d="M17 4l1 1 2-2" /></svg>,
};

export function Tag({ kind, children }: { kind?: "esa" | "warn" | "gold" | "good"; children: ReactNode }) {
  return <span className={"tag" + (kind ? " " + kind : "")}>{children}</span>;
}

export function Band({ children }: { children: ReactNode }) {
  return <div className="band"><div className="band-in">{children}</div></div>;
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className="toast" role="status" aria-live="polite">{msg}</div>;
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number | undefined>(undefined);
  const show = (m: string) => {
    setMsg(m);
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 5000);
  };
  useEffect(() => () => window.clearTimeout(t.current), []);
  return [msg, show];
}

export function Dialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="dlg">{open ? children : null}</div>
    </dialog>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="hint" style={{ padding: 18 }}>Loading {what}…</p>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="err" role="alert">{error}</div>;
}
