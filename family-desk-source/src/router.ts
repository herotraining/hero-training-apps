import { useEffect, useState } from "react";

export type Route =
  | { name: "today" }
  | { name: "families" }
  | { name: "family"; id: string }
  | { name: "money" }
  | { name: "staff" };

export function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  if (a === "families" && b) return { name: "family", id: b };
  if (a === "families") return { name: "families" };
  if (a === "money") return { name: "money" };
  if (a === "staff") return { name: "staff" };
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
  staff: "#/staff",
};
