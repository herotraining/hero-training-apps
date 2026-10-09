// Owners create a staff member's sign-in (or reset its password) without email.
// A temporary password is returned once; the person changes it after their first sign-in.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, userClient } from "./_shared.ts";

const WORDS = ["river", "cedar", "falcon", "ember", "summit", "harbor", "maple", "canyon", "lantern", "meadow", "anchor", "comet", "saddle", "willow", "beacon", "granite", "orchard", "prairie", "signal", "thunder", "valley", "voyage", "zephyr", "bridge"];
function tempPassword(): string {
  const pick = () => WORDS[crypto.getRandomValues(new Uint32Array(1))[0] % WORDS.length];
  const n = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90);
  return `${pick()}-${pick()}-${pick()}-${n}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Send JSON" }, 400); }

  const db = userClient(req);
  const { data: prof, error: perr } = await db.rpc("my_profile");
  if (perr) return json({ error: perr.message }, 400);
  if (prof?.staff?.role !== "owner") return json({ error: "Owners only" }, 403);
  if (prof?.aal !== "aal2") return json({ error: "Finish two-step sign-in first" }, 403);

  const staffId = String(body.staff_id ?? "");
  const { data: s, error: serr } = await db.from("staff").select("id, email, name, user_id, active").eq("id", staffId).maybeSingle();
  if (serr) return json({ error: serr.message }, 400);
  if (!s) return json({ error: "Staff member not found" }, 404);
  if (!s.active) return json({ error: "Turn this person on first" }, 409);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const password = tempPassword();

  if (body.action === "create") {
    if (s.user_id) return json({ error: `${s.name} already has a sign-in. Use reset instead.` }, 409);
    const { data, error } = await admin.auth.admin.createUser({ email: s.email, password, email_confirm: true, user_metadata: { name: s.name } });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, email: s.email, password, user_id: data.user?.id });
  }
  if (body.action === "reset") {
    if (!s.user_id) return json({ error: `${s.name} has no sign-in yet. Create one instead.` }, 409);
    const { error } = await admin.auth.admin.updateUserById(s.user_id, { password });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, email: s.email, password });
  }
  if (body.action === "reset_2fa") {
    if (!s.user_id) return json({ error: `${s.name} has no sign-in yet.` }, 409);
    const { data: factors, error: ferr } = await admin.auth.admin.mfa.listFactors({ userId: s.user_id });
    if (ferr) return json({ error: ferr.message }, 400);
    for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: s.user_id });
    return json({ ok: true, removed: factors?.factors?.length ?? 0 });
  }
  return json({ error: "action must be create, reset, or reset_2fa" }, 400);
});
