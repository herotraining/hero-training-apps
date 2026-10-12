import { useEffect, useState } from "react";

export type Route =
  | { name: "today" }
  | { name: "families" }
  | { name: "family"; id: string }
  | { name: "money" }
  | { name: "store"; familyId?: string }
  | { name: "programs" }
  | { name: "staff" }
  | { name: "request" };

export function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  if (a === "families" && b) return { name: "family", id: b };
  if (a === "families") return { name: "families" };
  if (a === "money") return { name: "money" };
  if (a === "store") return b ? { name: "store", familyId: b } : { name: "store" };
  if (a === "staff") return { name: "staff" };
  if (a === "programs") return { name: "programs" };
  if (a === "request") return { name: "request" };
  return { name: "today" };
}

export function useRoute(): Route {
  const [r, setR] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const on = () => setR(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const href = {
  today: "#/today",
  families: "#/families",
  family: (id: string) => `#/families/${id}`,
  money: "#/money",
  store: "#/store",
  storeFor: (familyId: string) => `#/store/${familyId}`,
  programs: "#/programs",
  staff: "#/staff",
  request: "#/request",
};
