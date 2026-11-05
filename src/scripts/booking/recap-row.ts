// The summary row shared by the booking done/confirm card and the guest cancel page (label and value on ONE row; styles: styles/recap.css).
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A label + value row of the compact summary cards (60 px label column, optional muted detail line). Text only (textContent). */
export function kvRow(label: string, value: string, detail = ""): HTMLElement {
  const row = el("div", "kv");
  const val = el("div", "v");
  val.append(el("p", "t-value-12", value));
  if (detail) val.append(el("p", "t-fb muted w600", detail));
  row.append(el("span", "t-label", label), val);
  return row;
}

export const lrow = (label: string, value: string, detail = ""): string => kvRow(label, value, detail).outerHTML;
