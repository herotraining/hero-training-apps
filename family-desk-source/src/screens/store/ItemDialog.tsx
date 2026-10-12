// Add or edit a price-list item (owners). A photo, a name, a price, the sizes and colors it comes in.
import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import type { StoreItem, StoreKind } from "../../types";
import { Dialog, ErrorBox } from "../../ui";
import { ALL_SIZES, Photo } from "./shared";

export function ItemDialog({ item, onClose, onSaved }: { item: StoreItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState<StoreKind>(item?.kind ?? "uniform");
  const [price, setPrice] = useState(item ? (item.price_cents / 100).toFixed(2) : "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [oneSize, setOneSize] = useState(item ? item.sizes.length === 0 : false);
  const [sizes, setSizes] = useState<string[]>(item?.sizes.length ? item.sizes : ALL_SIZES);
  const [colors, setColors] = useState(item ? item.colors.join(", ") : "");
  const [esaOk, setEsaOk] = useState(item?.esa_ok ?? true);
  const [active, setActive] = useState(item?.active ?? true);
  const [sort, setSort] = useState(String(item?.sort ?? 100));
  const [imageUrl, setImageUrl] = useState<string | null>(item?.image_url ?? null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleSize = (s: string) => setSizes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : ALL_SIZES.filter((x) => x === s || cur.includes(x))));

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError("Photos up to 5 MB, please."); return; }
    setUploading(true); setError(null);
    try { const a = await api(); setImageUrl(await a.uploadStoreImage(file)); }
    catch (e) { setError(`The photo didn't upload: ${(e as Error).message}`); }
    finally { setUploading(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(price) * 100);
    if (!name.trim()) { setError("Give it a name."); return; }
    if (!Number.isFinite(cents) || cents < 0 || cents > 100000) { setError("Price must be between $0 and $1,000."); return; }
    if (!oneSize && sizes.length === 0) { setError("Pick at least one size, or mark it one size."); return; }
    setBusy(true); setError(null);
    try {
      const a = await api();
      await a.saveStoreItem({
        id: item?.id, name: name.trim(), kind, price_cents: cents, sizes: oneSize ? [] : sizes,
        colors: colors.split(",").map((s) => s.trim()).filter(Boolean), esa_ok: kind === "uniform" && esaOk, active, sort: Number(sort) || 100,
        image_url: imageUrl, description: description.trim() || null,
      });
      onSaved();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose}>
      <form onSubmit={submit}>
        <h2>{item ? "Edit item" : "Add an item"}</h2>
        <div className="field" style={{ marginTop: 12 }}>
          <span className="label">Photo</span>
          <div className="photo-pick">
            <Photo url={imageUrl} alt="" className="ph" />
            <div>
              <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose a photo" disabled={uploading} onChange={(e) => pickPhoto(e.target.files?.[0])} />
              <div className="hint">{uploading ? "Uploading…" : "JPG, PNG or WebP, up to 5 MB. A square photo looks best."}{imageUrl && !uploading ? <> · <button type="button" className="linkbtn" style={{ padding: 0 }} onClick={() => setImageUrl(null)}>remove</button></> : null}</div>
            </div>
          </div>
        </div>
        <div className="field"><label htmlFor="it-name">Name</label><input id="it-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="HERO uniform T-shirt" required /></div>
        <div className="two">
          <div className="field"><label htmlFor="it-kind">Type</label>
            <select id="it-kind" value={kind} onChange={(e) => setKind(e.target.value as StoreKind)}><option value="uniform">Required uniform</option><option value="gear">Gear</option><option value="other">Other</option></select>
          </div>
          <div className="field"><label htmlFor="it-price">Price ($)</label><input id="it-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="25.00" required /></div>
        </div>
        <div className="field"><label htmlFor="it-desc">One line about it (optional)</label><input id="it-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short-sleeve training shirt. Required for class." maxLength={140} /></div>
        <div className="field">
          <span className="label">Sizes</span>
          <label className="chk" style={{ margin: "0 0 6px" }}><input type="checkbox" checked={oneSize} onChange={(e) => setOneSize(e.target.checked)} />One size fits all</label>
          {!oneSize && (
            <div className="chips" style={{ marginTop: 0 }} role="group" aria-label="Sizes">
              {ALL_SIZES.map((s) => <button type="button" key={s} className="chipbtn" aria-pressed={sizes.includes(s)} onClick={() => toggleSize(s)}>{s}</button>)}
            </div>
          )}
        </div>
        <div className="field"><label htmlFor="it-colors">Colors, separated by commas (leave empty for one color)</label><input id="it-colors" value={colors} onChange={(e) => setColors(e.target.value)} placeholder="Navy, Red, Black" /></div>
        <label className="chk"><input type="checkbox" checked={kind === "uniform" && esaOk} disabled={kind !== "uniform"} onChange={(e) => setEsaOk(e.target.checked)} />ESA can pay for it (a uniform the program requires)</label>
        <label className="chk"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />For sale</label>
        <div className="field" style={{ maxWidth: 160 }}><label htmlFor="it-sort">Order on the screen</label><input id="it-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} /></div>
        <ErrorBox error={error} />
        <div className="row end"><button type="button" className="btn quiet" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || uploading}>{busy ? "Saving…" : "Save"}</button></div>
      </form>
    </Dialog>
  );
}
