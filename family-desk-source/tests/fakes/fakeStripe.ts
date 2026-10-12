// A pretend Stripe API behind fetch. It keeps invoices (ESA) and Checkout Sessions (store) in memory and answers the
// calls the edge functions make. Any request that is not to api.stripe.com fails the test, so nothing leaves the
// machine. A key starting sk_live_ or rk_live_ makes "live" objects, so mode handling can be tested without money.

type Invoice = { id: string; status: "draft" | "open" | "paid" | "void"; params: Record<string, string>; items: Record<string, string>[]; hosted_invoice_url: string | null; paid_out_of_band?: boolean };
export type Session = {
  id: string; status: "open" | "complete" | "expired"; payment_status: "unpaid" | "paid"; url: string; livemode: boolean;
  amount_total: number; currency: string; client_reference_id: string | null; expires_at: number; params: Record<string, string>;
};

export class FakeStripe {
  invoices = new Map<string, Invoice>();
  sessions = new Map<string, Session>();
  calls: { method: string; path: string; params: Record<string, string> }[] = [];
  // Runs right after a Checkout Session is made, before the function gets the reply (to stage a race in a test).
  afterSessionCreated: ((s: Session) => void) | null = null;
  private failures: { method: string; path: RegExp; message: string; afterApplying: boolean }[] = [];
  private n = 0;

  // The next matching call fails. afterApplying: Stripe did the work but the reply was lost.
  failNext(method: string, path: RegExp, message: string, afterApplying = false) {
    this.failures.push({ method, path, message, afterApplying });
  }

  addInvoice(status: Invoice["status"], params: Record<string, string> = {}): Invoice {
    const inv: Invoice = { id: `in_test_${++this.n}`, status, params, items: [], hosted_invoice_url: `https://invoice.stripe.test/${this.n}` };
    this.invoices.set(inv.id, inv);
    return inv;
  }

  addSession(fields: Partial<Session> = {}): Session {
    const id = `cs_test_${++this.n}`;
    const s: Session = {
      id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.test/${id}`, livemode: false,
      amount_total: 0, currency: "usd", client_reference_id: null, expires_at: Math.floor(Date.now() / 1000) + 3600, params: {}, ...fields,
    };
    this.sessions.set(id, s);
    return s;
  }

  // The parent paid on Stripe's page.
  pay(id: string) { const s = this.sessions.get(id)!; s.status = "complete"; s.payment_status = "paid"; }
  // Complete but the money hasn't settled yet.
  processing(id: string) { const s = this.sessions.get(id)!; s.status = "complete"; s.payment_status = "unpaid"; }
  expire(id: string) { this.sessions.get(id)!.status = "expired"; }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.stripe.com") throw new Error(`Test tried to reach ${url.hostname}; only the fake Stripe is allowed`);
    const method = (init.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(new URLSearchParams(method === "GET" ? url.search : String(init.body ?? "")));
    const key = String((init.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    this.calls.push({ method, path: url.pathname, params });

    const i = this.failures.findIndex((f) => f.method === method && f.path.test(url.pathname));
    const fail = i >= 0 ? this.failures.splice(i, 1)[0] : null;
    if (fail && !fail.afterApplying) return this.reply(400, { error: { message: fail.message } });
    const res = this.handle(method, url.pathname, params, /^(sk|rk)_live_/.test(key));
    return fail ? this.reply(500, { error: { message: fail.message } }) : res;
  };

  private reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private handle(method: string, path: string, params: Record<string, string>, live: boolean): Response {
    // Invoices (ESA).
    if (method === "POST" && path === "/v1/invoices") return this.reply(200, this.addInvoice("draft", params));
    if (method === "POST" && path === "/v1/invoiceitems") {
      const inv = this.invoices.get(params.invoice);
      if (!inv) return this.reply(404, { error: { message: "No such invoice" } });
      if (inv.status !== "draft") return this.reply(400, { error: { message: "Invoice is not a draft" } });
      inv.items.push(params);
      return this.reply(200, { id: `ii_test_${++this.n}`, ...params });
    }
    const im = /^\/v1\/invoices\/([^/]+)(?:\/(finalize|pay|void))?$/.exec(path);
    if (im) {
      const inv = this.invoices.get(im[1]);
      if (!inv) return this.reply(404, { error: { message: `No such invoice: ${im[1]}` } });
      const verb = im[2];
      if (method === "GET" && !verb) return this.reply(200, inv);
      if (verb === "finalize" && inv.status === "draft") inv.status = "open";
      else if (verb === "pay" && inv.status === "open") { inv.status = "paid"; inv.paid_out_of_band = params.paid_out_of_band === "true"; }
      else if (verb === "void" && inv.status === "open") inv.status = "void";
      else return this.reply(400, { error: { message: `Can't ${verb} a ${inv.status} invoice` } });
      return this.reply(200, inv);
    }

    // Checkout Sessions (store). amount_total is what the line items add up to, like Stripe computes it.
    if (method === "POST" && path === "/v1/checkout/sessions") {
      let total = 0;
      for (const [k, v] of Object.entries(params)) {
        const m = /^line_items\[(\d+)\]\[quantity\]$/.exec(k);
        if (m) total += Number(v) * Number(params[`line_items[${m[1]}][price_data][unit_amount]`] ?? 0);
      }
      const s = this.addSession({
        livemode: live, amount_total: total, currency: "usd", client_reference_id: params.client_reference_id ?? null,
        expires_at: Number(params.expires_at ?? 0), params,
      });
      this.afterSessionCreated?.(s);
      return this.reply(200, s);
    }
    const sm = /^\/v1\/checkout\/sessions\/([^/]+)(?:\/(expire))?$/.exec(path);
    if (sm) {
      const s = this.sessions.get(sm[1]);
      // A session made in the other mode can't be seen with this key, same as Stripe.
      if (!s || s.livemode !== live) return this.reply(404, { error: { message: `No such checkout.session: '${sm[1]}'` } });
      if (method === "GET" && !sm[2]) return this.reply(200, s);
      if (sm[2] === "expire") {
        if (s.status !== "open") return this.reply(400, { error: { message: "You cannot expire a Checkout Session that is not open." } });
        s.status = "expired";
        return this.reply(200, s);
      }
    }
    return this.reply(404, { error: { message: `No such route: ${method} ${path}` } });
  }
}
