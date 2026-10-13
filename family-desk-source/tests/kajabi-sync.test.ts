// Kajabi access sync (supabase/functions/kajabi-sync): who should be in the hubs, who is, and the grants and
// revokes that close the gap, done by submitting Kajabi forms whose automations grant or revoke the offers. The
// real function runs against the in-memory database and a pretend hero.training. Made-up families and staff only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fakes/fakeDb";
import { FakeKajabi } from "./fakes/fakeKajabi";

const FAMILY = "2151417348", STAFF = "2151415672";
const FORM = { familyIn: "2149752392", familyOut: "2149752393", staffIn: "2149752394", staffOut: "2149752395" };
let handler: (req: Request) => Promise<Response>;
let db: FakeDb;
let kajabi: FakeKajabi;
const env: Record<string, string> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  (globalThis as any).Deno = { serve: (h: typeof handler) => { handler = h; }, env: { get: (k: string) => env[k] } };
  env.KAJABI_PACE_MS = "0";   // read when the function loads; no pause between pretend submissions
  await import("../supabase/functions/kajabi-sync/index.ts");
});
afterAll(() => { globalThis.fetch = realFetch; delete (globalThis as any).Deno; });

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { SUPABASE_URL: "http://supabase.invalid", SUPABASE_ANON_KEY: "anon-test", SUPABASE_SERVICE_ROLE_KEY: "service-test", KAJABI_PACE_MS: "0" });
  db = new FakeDb();
  (globalThis as any).__fakeDb = db;
  kajabi = new FakeKajabi();
  globalThis.fetch = kajabi.fetch as typeof fetch;
});

async function call(body: unknown) {
  const res = await handler(new Request("http://localhost/kajabi-sync", { method: "POST", headers: { Authorization: "Bearer test-user", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

// The Testers (two guardians, Ava in a class), the Samples (Cal dropped), the Olds (inactive family), and three staff.
function seed() {
  const testers = db.insertRow("families", { name: "Tester", status: "active" });
  db.insertRow("guardians", { family_id: testers.id, name: "Pat Tester", email: "Pat.Tester@Example.test" });
  db.insertRow("guardians", { family_id: testers.id, name: "Sam Tester", email: "sam.tester@example.test" });
  db.insertRow("guardians", { family_id: testers.id, name: "Grandma", email: null });
  const ava = db.insertRow("children", { family_id: testers.id, first_name: "Ava", active: true });
  const avaClass = db.insertRow("enrollments", { child_id: ava.id, status: "active", pay: "esa" });
  const samples = db.insertRow("families", { name: "Sample", status: "active" });
  db.insertRow("guardians", { family_id: samples.id, name: "Sal Sample", email: "sal@example.test" });
  const cal = db.insertRow("children", { family_id: samples.id, first_name: "Cal", active: true });
  db.insertRow("enrollments", { child_id: cal.id, status: "dropped", pay: "card" });
  const olds = db.insertRow("families", { name: "Old", status: "inactive" });
  db.insertRow("guardians", { family_id: olds.id, name: "Ollie Old", email: "ollie@example.test" });
  const kid = db.insertRow("children", { family_id: olds.id, first_name: "Kid", active: true });
  db.insertRow("enrollments", { child_id: kid.id, status: "active", pay: "card" });
  db.insertRow("staff", { name: "Lisa", email: "lisa@example.test", active: true });
  db.insertRow("staff", { name: "Kai", email: "kai@example.test", active: true });
  db.insertRow("staff", { name: "Gone", email: "gone@example.test", active: false });
  return { testers, samples, olds, ava, avaClass, cal };
}
const granted = (email: string, offer: string) => db.tables.kajabi_access.find((r) => r.email === email && r.offer_id === offer && r.status === "granted");

describe("who may run it", () => {
  it("turns away a coach and an owner without two-step sign-in", async () => {
    db.profile = { staff: { role: "coach" }, aal: "aal2" };
    expect((await call({ action: "status" })).status).toBe(403);
    db.profile = { staff: { role: "owner" }, aal: "aal1" };
    expect((await call({ action: "status" })).status).toBe(403);
  });
});

describe("status and plan", () => {
  it("counts who should be let in: guardians with a child in a class, and active staff", async () => {
    seed();
    const r = await call({ action: "plan" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, counts: { family: 0, staff: 0, errors: 0 }, to_grant: 4, to_revoke: 0 });
    expect(r.body.grants.map((g: any) => [g.email, g.kind]).sort()).toEqual([
      ["kai@example.test", "staff"], ["lisa@example.test", "staff"], ["pat.tester@example.test", "family"], ["sam.tester@example.test", "family"],
    ]);
    // Not Sal (Cal dropped), not Ollie (inactive family), not Gone (inactive staff), not Grandma (no email).
  });

  it("can be paused from Supabase secrets", async () => {
    seed();
    env.KAJABI_SYNC = "off";
    expect((await call({ action: "status" })).body.configured).toBe(false);
    const r = await call({ action: "sync" });
    expect(r.status).toBe(503);
    expect(kajabi.submissions).toHaveLength(0);
  });

  it("plans a revoke for someone who had access and no longer qualifies", async () => {
    seed();
    db.insertRow("kajabi_access", { email: "ollie@example.test", kind: "family", offer_id: FAMILY, status: "granted" });
    const r = await call({ action: "plan" });
    expect(r.body.to_revoke).toBe(1);
    expect(r.body.revokes).toEqual([{ email: "ollie@example.test", kind: "family", offer_id: FAMILY }]);
  });
});

describe("sync: granting", () => {
  it("submits the right form for each person with their name, and keeps the ledger", async () => {
    seed();
    const pat = kajabi.addContact("pat.tester@example.test", "Pat T"); // already a Kajabi contact (made a Hero Account)
    const r = await call({ action: "sync" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, remaining: 0, failed: [] });
    expect(r.body.granted.sort()).toEqual(["kai@example.test", "lisa@example.test", "pat.tester@example.test", "sam.tester@example.test"]);
    expect(kajabi.submissions.map((s) => [s.form, s.email, s.name]).sort()).toEqual([
      [FORM.familyIn, "pat.tester@example.test", "Pat Tester"], [FORM.familyIn, "sam.tester@example.test", "Sam Tester"],
      [FORM.staffIn, "kai@example.test", "Kai"], [FORM.staffIn, "lisa@example.test", "Lisa"],
    ]);
    // Pat's existing contact got the offer; Sam became a contact; staff got the Staff Hub only.
    expect(pat.offers.has(FAMILY)).toBe(true);
    expect(kajabi.byEmail("sam.tester@example.test")!.offers.has(FAMILY)).toBe(true);
    expect(kajabi.byEmail("lisa@example.test")!.offers.has(STAFF)).toBe(true);
    expect(kajabi.byEmail("lisa@example.test")!.offers.has(FAMILY)).toBe(false);
    expect(granted("pat.tester@example.test", FAMILY)).toMatchObject({ kind: "family" });
  });

  it("is a no-op the second time", async () => {
    seed();
    await call({ action: "sync" });
    const r = await call({ action: "sync" });
    expect(r.body).toMatchObject({ granted: [], revoked: [], failed: [], remaining: 0 });
    expect(kajabi.submissions).toHaveLength(4);
    expect((await call({ action: "status" })).body).toMatchObject({ counts: { family: 2, staff: 2, errors: 0 }, to_grant: 0, to_revoke: 0 });
  });

  it("gives a parent who is also staff both hubs", async () => {
    seed();
    db.insertRow("staff", { name: "Pat Tester", email: "pat.tester@example.test", active: true });
    await call({ action: "sync" });
    expect([...kajabi.byEmail("pat.tester@example.test")!.offers].sort()).toEqual([STAFF, FAMILY].sort());
  });

  it("records a refused submission on that person, carries on with the others, and retries next time", async () => {
    seed();
    kajabi.failNext(FORM.staffIn, 422, "Email is invalid");
    const r = await call({ action: "sync" });
    expect(r.body.failed).toHaveLength(1);
    expect(r.body.failed[0].why).toMatch(/refused the submission \(422\): Email is invalid/);
    expect(r.body.granted).toHaveLength(3);
    expect((await call({ action: "status" })).body).toMatchObject({ counts: { errors: 1 }, to_grant: 1 });
    const again = await call({ action: "sync" });
    expect(again.body.granted).toHaveLength(1);
    expect(db.tables.kajabi_access.filter((x) => x.status === "error")).toHaveLength(0);
  });

  it("stops when Kajabi asks for a pause, marks nobody as failed, and picks up the rest next run", async () => {
    seed();
    kajabi.burst = 2;
    const r = await call({ action: "sync" });
    expect(r.body).toMatchObject({ failed: [], remaining: 2, throttled: { retry_after: 30 } });
    expect(r.body.granted).toHaveLength(2);
    expect(db.tables.kajabi_access.filter((x) => x.status === "error")).toHaveLength(0);
    kajabi.burst = Infinity;
    const again = await call({ action: "sync" });
    expect(again.body).toMatchObject({ remaining: 0, throttled: null });
    expect(again.body.granted).toHaveLength(2);
  });

  it("limits one person's sync to that email", async () => {
    seed();
    const r = await call({ action: "sync", emails: ["LISA@example.test"] });
    expect(r.body.granted).toEqual(["lisa@example.test"]);
    expect(r.body.remaining).toBe(3);
  });

  it("still records the grant when the automation isn't published yet: the form took it, Kajabi runs it later", async () => {
    seed();
    kajabi.published.delete(FORM.familyIn);
    const r = await call({ action: "sync" });
    expect(r.body.failed).toEqual([]);
    expect(kajabi.byEmail("pat.tester@example.test")!.offers.has(FAMILY)).toBe(false);
    expect(granted("pat.tester@example.test", FAMILY)).toBeTruthy();
  });
});

describe("sync: revoking", () => {
  it("closes the Family Hub when the family goes inactive or the child drops, and the Staff Hub when staff are turned off", async () => {
    const s = seed();
    await call({ action: "sync" });
    s.testers.status = "inactive";
    db.tables.staff.find((p) => p.email === "kai@example.test")!.active = false;
    const r = await call({ action: "sync" });
    expect(r.body.revoked.sort()).toEqual(["kai@example.test", "pat.tester@example.test", "sam.tester@example.test"]);
    expect(kajabi.submissions.slice(4).map((x) => [x.form, x.email]).sort()).toEqual([
      [FORM.familyOut, "pat.tester@example.test"], [FORM.familyOut, "sam.tester@example.test"], [FORM.staffOut, "kai@example.test"],
    ]);
    expect(kajabi.byEmail("pat.tester@example.test")!.offers.has(FAMILY)).toBe(false);
    expect(kajabi.byEmail("kai@example.test")!.offers.has(STAFF)).toBe(false);
    expect(kajabi.byEmail("lisa@example.test")!.offers.has(STAFF)).toBe(true);
    expect(db.tables.kajabi_access.find((x) => x.email === "kai@example.test")).toMatchObject({ status: "revoked" });
  });

  it("closes access when a child's only class ends, and reopens it when a new one starts", async () => {
    const s = seed();
    await call({ action: "sync" });
    s.avaClass.status = "dropped";
    expect((await call({ action: "sync" })).body.revoked.sort()).toEqual(["pat.tester@example.test", "sam.tester@example.test"]);
    db.insertRow("enrollments", { child_id: s.ava.id, status: "active", pay: "card" });
    expect((await call({ action: "sync" })).body.granted.sort()).toEqual(["pat.tester@example.test", "sam.tester@example.test"]);
    expect(kajabi.byEmail("pat.tester@example.test")!.offers.has(FAMILY)).toBe(true);
  });

  it("never touches a Hero Account someone made on their own, beyond the one offer", async () => {
    seed();
    const sal = kajabi.addContact("sal@example.test", "Sal", ["2151417349"]); // the free Hearth offer, self-made
    await call({ action: "sync" });
    expect(sal.offers.has("2151417349")).toBe(true);
    expect(sal.offers.has(FAMILY)).toBe(false);
  });
});
