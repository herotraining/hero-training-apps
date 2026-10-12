import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in Node with made-up data only. The edge functions' Deno imports point at in-memory fakes, so nothing
// here can reach the live Supabase project or Stripe.
const fake = (f: string) => fileURLToPath(new URL(`./tests/fakes/${f}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^jsr:@supabase\/functions-js\/edge-runtime\.d\.ts$/, replacement: fake("edge-runtime.ts") },
      { find: /^npm:@supabase\/supabase-js@2$/, replacement: fake("supabase-js.ts") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
