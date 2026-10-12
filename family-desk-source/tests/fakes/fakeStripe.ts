// A pretend Stripe API behind fetch. It keeps invoices and their items in memory and answers the calls the ESA
// invoice function makes. Any request that is not to api.stripe.com fails the test, so nothing leaves the machine.

type Invoice = { id: string; status: "draft" | "open" | "paid" | "void"; params: Record<string, string>; items: Record<string, string>[]; hosted_invoice_url: string | null; paid_out_of_band?: boolean };

export class FakeStripe {
  invoices = new Map<string, Invoice>();
  calls: { method: string; path: string; params: Record<string, string> }[] = [];
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

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.stripe.com") throw new Error(`Test tried to reach ${url.hostname}; only the fake Stripe is allowed`);
    const method = (init.method ?? "GET").toUpperCase();
    const params = Object.fromEntries(new URLSearchParams(method === "GET" ? url.search : String(init.body ?? "")));
    this.calls.push({ method, path: url.pathname, params });

    const i = this.failures.findIndex((f) => f.method === method && f.path.test(url.pathname));
    const fail = i >= 0 ? this.failures.splice(i, 1)[0] : null;
    if (fail && !fail.afterApplying) return this.reply(400, { error: { message: fail.message } });
    const res = this.handle(method, url.pathname, params);
    return fail ? this.reply(500, { error: { message: fail.message } }) : res;
  };

  private reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private handle(method: string, path: string, params: Record<string, string>): Response {
    if (method === "POST" && path === "/v1/invoices") return this.reply(200, this.addInvoice("draft", params));
    if (method === "POST" && path === "/v1/invoiceitems") {
      const inv = this.invoices.get(params.invoice);
      if (!inv) return this.reply(404, { error: { message: "No such invoice" } });
      if (inv.status !== "draft") return this.reply(400, { error: { message: "Invoice is not a draft" } });
      inv.items.push(params);
      return this.reply(200, { id: `ii_test_${++this.n}`, ...params });
    }
    const m = /^\/v1\/invoices\/([^/]+)(?:\/(finalize|pay|void))?$/.exec(path);
    const inv = m && this.invoices.get(m[1]);
    if (!m || !inv) return this.reply(404, { error: { message: `No such route or invoice: ${method} ${path}` } });
    const verb = m[2];
    if (method === "GET" && !verb) return this.reply(200, inv);
    if (verb === "finalize" && inv.status === "draft") inv.status = "open";
    else if (verb === "pay" && inv.status === "open") { inv.status = "paid"; inv.paid_out_of_band = params.paid_out_of_band === "true"; }
    else if (verb === "void" && inv.status === "open") inv.status = "void";
    else return this.reply(400, { error: { message: `Can't ${verb} a ${inv.status} invoice` } });
    return this.reply(200, inv);
  }
}
