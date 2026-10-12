// Stands in for npm:@supabase/supabase-js@2 in the edge functions. createClient hands back the in-memory database the
// current test set up, so a function under test never opens a connection.
import type { FakeDb } from "./fakeDb";

export function createClient(..._args: unknown[]) {
  const db = (globalThis as any).__fakeDb as FakeDb | undefined;
  if (!db) throw new Error("No fake database set up for this test");
  return db.client();
}
