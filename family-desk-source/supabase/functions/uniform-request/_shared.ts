// Shared helpers for HERO Family Desk edge functions.
import { createClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// A Supabase client that acts as the signed-in staff member, so row-level security applies.
export function userClient(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } },
  );
}

export function stripeKey(): string | null {
  const k = Deno.env.get("STRIPE_SECRET_KEY");
  if (!k) return null;
  if (k.startsWith("sk_live") || k.startsWith("rk_live")) {
    // The app is built against the sandbox until the owners say otherwise.
    if (Deno.env.get("STRIPE_LIVE_OK") !== "yes") return null;
  }
  return k;
}

// Flatten nested params into Stripe's form encoding: a[b][0][c]=v
function encode(params: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) encode(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      encode(v as Record<string, unknown>, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export async function stripe(
  key: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const body = encode(params).join("&");
  const url = method === "GET" && body ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? body : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message ?? `Stripe ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
