// A pretend hero.training behind fetch: the four Kajabi forms the sync submits, and the automations behind them
// (grant or revoke the matching offer for the contact with that email). Kajabi answers a form submission with a
// redirect to the thank-you page. Any other host fails the test.
type Contact = { email: string; name: string; offers: Set<string> };

const FAMILY = "2151417348", STAFF = "2151415672";
const FORMS: Record<string, { offer: string; action: "grant" | "revoke" }> = {
  "2149752392": { offer: FAMILY, action: "grant" }, "2149752393": { offer: FAMILY, action: "revoke" },
  "2149752394": { offer: STAFF, action: "grant" }, "2149752395": { offer: STAFF, action: "revoke" },
};

export class FakeKajabi {
  contacts = new Map<string, Contact>();
  submissions: { form: string; email: string; name: string }[] = [];
  // Automations the admin has published. A submission to a form with no published automation is taken but does nothing.
  published = new Set(Object.keys(FORMS));
  private failures: { form: string; status: number; text: string }[] = [];

  failNext(form: string, status: number, text: string) { this.failures.push({ form, status, text }); }

  addContact(email: string, name: string, offers: string[] = []): Contact {
    const c: Contact = { email: email.toLowerCase(), name, offers: new Set(offers) };
    this.contacts.set(c.email, c);
    return c;
  }
  byEmail(email: string) { return this.contacts.get(email.toLowerCase()) ?? null; }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "www.hero.training") throw new Error(`Test tried to reach ${url.hostname}; only the fake Kajabi site is allowed`);
    const m = /^\/forms\/(\d+)\/form_submissions$/.exec(url.pathname);
    if (!m || (init.method ?? "GET").toUpperCase() !== "POST") return new Response("Not found", { status: 404 });
    const form = m[1];
    const params = new URLSearchParams(String(init.body ?? ""));
    const email = (params.get("form_submission[email]") ?? "").trim().toLowerCase();
    const name = (params.get("form_submission[name]") ?? "").trim();
    const i = this.failures.findIndex((f) => f.form === form);
    if (i >= 0) { const f = this.failures.splice(i, 1)[0]; return new Response(`<html><body>${f.text}</body></html>`, { status: f.status }); }
    if (!FORMS[form]) return new Response("Not found", { status: 404 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response("<html>Email is invalid</html>", { status: 422 });
    this.submissions.push({ form, email, name });
    // The site makes a contact for any new email; the automation then grants or revokes.
    const c = this.byEmail(email) ?? this.addContact(email, name);
    if (this.published.has(form)) { const { offer, action } = FORMS[form]; if (action === "grant") c.offers.add(offer); else c.offers.delete(offer); }
    return new Response(null, { status: 302, headers: { Location: `https://www.hero.training/forms/${form}/thank_you` } });
  };
}
