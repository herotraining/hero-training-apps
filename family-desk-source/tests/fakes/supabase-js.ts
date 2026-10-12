// Stands in for npm:@supabase/supabase-js@2 in the edge functions. createClient hands back the in-memory database the
// current test set up, so a function under test never opens a connection. A client made with the service-role key
// is "trusted", like app.trusted_writer() in the database; the others act as the signed-in staff member.
import type { FakeDb } from "./fakeDb";

export function createClient(_url: string, key: string, ..._rest: unknown[]) {
  const db = (globalThis as any).__fakeDb as FakeDb | undefined;
  if (!db) throw new Error("No fake database set up for this test");
  const serviceKey = (globalThis as any).Deno?.env?.get("SUPABASE_SERVICE_ROLE_KEY");
  return db.client(!!serviceKey && key === serviceKey);
}
