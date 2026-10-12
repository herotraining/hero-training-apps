// The cart: what's in it, who it's for, the total, and the way to checkout. Shown as a side panel on a wide
// screen and inside a dialog on a phone.
import type { CartLine, Family } from "../../types";
import { money, siteName } from "../../lib/util";
import { Tag } from "../../ui";
import { href } from "../../router";
import { Photo } from "./shared";

export function Cart({ cart, family, onQty, onRemove, onClear, onChangeFamily, onCheckout }: {
  cart: CartLine[]; family: Family | null;
  onQty: (key: string, qty: number) => void; onRemove: (key: string) => void; onClear: () => void; onChangeFamily: () => void; onCheckout: () => void;
}) {
  const total = cart.reduce((n, l) => n + l.unit_cents * l.quantity, 0);
  const count = cart.reduce((n, l) => n + l.quantity, 0);
  return (
    <div className="cart" role="region" aria-label="Cart">
      <h2>Cart <span className="hint">{count === 0 ? "" : `${count} ${count === 1 ? "item" : "items"}`}</span></h2>
      {cart.length === 0 && <p className="empty hint">Tap an item to add it.</p>}
      {cart.map((l) => (
        <div key={l.key} className="cartline">
          <Photo url={l.image_url} alt="" className="th" />
          <div>
            <div className="nm">{l.name}</div>
            <div className="k">{[l.color, l.size, l.child_name ? `for ${l.child_name}` : null].filter(Boolean).join(" · ") || "One size"}</div>
            <div className="ctl">
              <button type="button" aria-label={`One fewer ${l.name}`} onClick={() => (l.quantity > 1 ? onQty(l.key, l.quantity - 1) : onRemove(l.key))}>−</button>
              <b aria-live="polite">{l.quantity}</b>
              <button type="button" aria-label={`One more ${l.name}`} disabled={l.quantity >= 50} onClick={() => onQty(l.key, l.quantity + 1)}>+</button>
              <button type="button" className="linkbtn" onClick={() => onRemove(l.key)}>remove</button>
            </div>
          </div>
          <div className="v">{money(l.unit_cents * l.quantity)}</div>
        </div>
      ))}
      {cart.length > 0 && (
        <>
          <div className="total"><span>Total</span><b>{money(total)}</b></div>
          <div className="who">
            {family ? (
              <>
                <b><a href={href.family(family.id)}>{family.name}</a></b>{family.status !== "active" ? <> <Tag kind="warn">Inactive</Tag></> : null}
                <span className="hint">{siteName(family.site_id)} · {family.stripe_customer_id ? "billed in Family Desk" : "billed in Jackrabbit"}</span>
              </>
            ) : (
              <><b>Walk-up sale</b><span className="hint">No family picked. ESA and account billing need one.</span></>
            )}
            <button type="button" className="linkbtn" style={{ padding: 0, marginTop: 4 }} onClick={onChangeFamily}>{family ? "Change family" : "Pick a family"}</button>
          </div>
          <button type="button" className="btn wide" onClick={onCheckout}>Check out · {money(total)}</button>
          <div className="row" style={{ justifyContent: "center", marginTop: 6 }}><button type="button" className="linkbtn" onClick={onClear}>Empty the cart</button></div>
        </>
      )}
    </div>
  );
}
