// A pretend Kajabi public API behind fetch: the token endpoint, contacts (search and create) and the contact-offer
// relationship that grants or revokes access. JSON:API shapes, like the real one. Any other host fails the test.
type Contact = { id: string; email: string; name: string; offers: Set<string> };

export class FakeKajabi {
  contacts = new Map<string, Contact>();
  calls: { method: string; path: string; body: any; auth: string | null }[] = [];
  tokensIssued = 0;
  creds = { id: "kj_client_test", secret: "kj_secret_test" };
  private failures: { method: string; path: RegExp; status: number; detail: string }[] = [];
  private n = 0;

  failNext(method: string, path: RegExp, status: number, detail: string) { this.failures.push({ method, path, status, detail }); }

  addContact(email: string, name: string, offers: string[] = []): Contact {
    const c: Contact = { id: String(500 + ++this.n), email: email.toLowerCase(), name, offers: new Set(offers) };
    this.contacts.set(c.id, c);
    return c;
  }
  byEmail(email: string) { return [...this.contacts.values()].find((c) => c.email === email.toLowerCase()) ?? null; }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.kajabi.com") throw new Error(`Test tried to reach ${url.hostname}; only the fake Kajabi is allowed`);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = headers.Authorization ?? null;
    this.calls.push({ method, path: url.pathname + url.search, body, auth });

    const i = this.failures.findIndex((f) => f.method === method && f.path.test(url.pathname));
    if (i >= 0) { const f = this.failures.splice(i, 1)[0]; return this.reply(f.status, { errors: [{ title: "Error", detail: f.detail }] }); }

    if (method === "POST" && url.pathname === "/v1/oauth/token") {
      if (body?.grant_type !== "client_credentials" || body.client_id !== this.creds.id || body.client_secret !== this.creds.secret) return this.reply(401, { error: "invalid_client", error_description: "Client authentication failed" });
      this.tokensIssued++;
      return this.reply(200, { access_token: `kj_token_${this.tokensIssued}`, token_type: "Bearer", expires_in: 7200 });
    }
    if (!/^Bearer kj_token_\d+$/.test(auth ?? "")) return this.reply(401, { errors: [{ title: "Unauthorized", detail: "Missing or invalid token" }] });

    if (method === "GET" && url.pathname === "/v1/contacts") {
      const q = (url.searchParams.get("filter[search]") ?? "").toLowerCase();
      const hits = [...this.contacts.values()].filter((c) => !q || c.email.includes(q) || c.name.toLowerCase().includes(q));
      return this.reply(200, { data: hits.map((c) => ({ id: c.id, type: "contacts", attributes: { email: c.email, name: c.name } })) });
    }
    if (method === "POST" && url.pathname === "/v1/contacts") {
      const a = body?.data?.attributes ?? {};
      if (!a.email) return this.reply(422, { errors: [{ title: "Invalid", detail: "email can't be blank" }] });
      if (this.byEmail(a.email)) return this.reply(422, { errors: [{ title: "Invalid", detail: "email has already been taken" }] });
      const c = this.addContact(a.email, a.name ?? "");
      return this.reply(201, { data: { id: c.id, type: "contacts", attributes: { email: c.email, name: c.name } } });
    }
    const rm = /^\/v1\/contacts\/(\d+)\/relationships\/offers$/.exec(url.pathname);
    if (rm) {
      const c = this.contacts.get(rm[1]);
      if (!c) return this.reply(404, { errors: [{ title: "Not found", detail: "No such contact" }] });
      const ids: string[] = (body?.data ?? []).map((d: any) => String(d.id));
      if (method === "POST") { for (const id of ids) c.offers.add(id); return new Response(null, { status: 204 }); }
      if (method === "DELETE") { for (const id of ids) c.offers.delete(id); return new Response(null, { status: 204 }); }
    }
    return this.reply(404, { errors: [{ title: "Not found", detail: `${method} ${url.pathname}` }] });
  };

  private reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/vnd.api+json" } });
  }
}
