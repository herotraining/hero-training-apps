// Owners create a staff member's sign-in (or reset its password) without email. A temporary password is returned
// once; the person must choose their own at their next sign-in (app_metadata.must_change_password), and does so
// through this function too (action password_changed), which sets it and clears the flag.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { cors, json, userClient } from "./_shared.ts";

// 16 symbols from a 32-symbol alphabet = 80 bits, in four groups so it can be read out by phone. No l, o, 0 or 1,
// which are easy to mishear or misread.
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function tempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Send JSON" }, 400); }

  const db = userClient(req);
  const { data: prof, error: perr } = await db.rpc("my_profile");
  if (perr) return json({ error: perr.message }, 400);
  if (!prof?.staff) return json({ error: "Not on the staff list" }, 403);
  if (prof?.aal !== "aal2") return json({ error: "Finish two-step sign-in first" }, 403);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Any staff member: set their own password and clear "must change password". The caller is whoever the token
  // says, never a staff_id from the body.
  if (body.action === "password_changed") {
    const pw = String(body.new_password ?? "");
    if (pw.length < 10) return json({ error: "Use at least 10 characters." }, 400);
    if (pw.length > 200) return json({ error: "That password is too long." }, 400);
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who, error: werr } = await admin.auth.getUser(token);
    if (werr || !who?.user) return json({ error: "Not signed in" }, 401);
    const { error } = await admin.auth.admin.updateUserById(who.user.id, { password: pw, app_metadata: { family_desk: "staff", must_change_password: false } });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (prof.staff.role !== "owner") return json({ error: "Owners only" }, 403);

  const staffId = String(body.staff_id ?? "");
  const { data: s, error: serr } = await db.from("staff").select("id, email, name, user_id, active").eq("id", staffId).maybeSingle();
  if (serr) return json({ error: serr.message }, 400);
  if (!s) return json({ error: "Staff member not found" }, 404);
  if (!s.active) return json({ error: "Turn this person on first" }, 409);

  const password = tempPassword();

  if (body.action === "create") {
    if (s.user_id) return json({ error: `${s.name} already has a sign-in. Use reset instead.` }, 409);
    // family_desk: "staff" is what lets the database link this account to its staff row (app.on_auth_user_created).
    const { data, error } = await admin.auth.admin.createUser({
      email: s.email, password, email_confirm: true, user_metadata: { name: s.name },
      app_metadata: { family_desk: "staff", must_change_password: true },
    });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, email: s.email, password, user_id: data.user?.id });
  }
  if (body.action === "reset") {
    if (!s.user_id) return json({ error: `${s.name} has no sign-in yet. Create one instead.` }, 409);
    const { error } = await admin.auth.admin.updateUserById(s.user_id, { password, app_metadata: { family_desk: "staff", must_change_password: true } });
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
  return json({ error: "action must be create, reset, reset_2fa, or password_changed" }, 400);
});
