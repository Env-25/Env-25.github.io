/** Client cart (localStorage, per-user when signed in) + orders API helpers. */

export const CART_KEY_GUEST = "chbe_cart_v1";
export const CART_USER_PREFIX = "chbe_cart_v1:user:";
export const CART_ACTIVE_USER_KEY = "chbe_cart_active_user";
export const CARD_SURCHARGE = 1.03;

export type CartItem = {
  kind: "merch" | "locker";
  id: string;
  slug: string;
  name: string;
  image: string;
  qty: number;
  unitPrice: number;
  color?: string;
  size?: string;
  level?: "Top" | "Mid" | "Bottom";
  location?: string;
};

function storageKeyFor(userSub: string | null | undefined): string {
  if (userSub) return `${CART_USER_PREFIX}${userSub}`;
  return CART_KEY_GUEST;
}

function activeUserSub(): string | null {
  try {
    return localStorage.getItem(CART_ACTIVE_USER_KEY) || null;
  } catch {
    return null;
  }
}

function readRaw(key: string): CartItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(key: string, items: CartItem[]): void {
  localStorage.setItem(key, JSON.stringify(items));
}

function mergeCarts(a: CartItem[], b: CartItem[]): CartItem[] {
  const out = a.map((x) => ({ ...x }));
  for (const item of b) {
    const key = cartLineKey(item);
    const existing = out.find((c) => cartLineKey(c) === key);
    if (!existing) {
      out.push({ ...item, qty: item.kind === "locker" ? 1 : item.qty });
      continue;
    }
    if (item.kind === "locker") {
      existing.qty = 1;
    } else {
      existing.qty += item.qty;
    }
  }
  return out;
}

/**
 * Bind cart storage to the signed-in Cognito user.
 * Merges any guest cart into the user cart once, then clears guest.
 * Call on login / session restore. Pass null on logout to switch back to guest key.
 */
export function bindCartUser(userSub: string | null): void {
  if (typeof localStorage === "undefined") return;
  const prev = activeUserSub();

  if (!userSub) {
    localStorage.setItem(CART_ACTIVE_USER_KEY, "");
    window.dispatchEvent(new CustomEvent("chbe-cart-updated"));
    return;
  }

  if (prev === userSub) {
    window.dispatchEvent(new CustomEvent("chbe-cart-updated"));
    return;
  }

  const guest = readRaw(CART_KEY_GUEST);
  const userKey = storageKeyFor(userSub);
  const userCart = readRaw(userKey);
  const merged = mergeCarts(userCart, guest);
  writeRaw(userKey, merged);
  writeRaw(CART_KEY_GUEST, []);
  localStorage.setItem(CART_ACTIVE_USER_KEY, userSub);
  window.dispatchEvent(new CustomEvent("chbe-cart-updated"));
}

export function cartLineKey(item: Pick<CartItem, "kind" | "id" | "size" | "level">): string {
  if (item.kind === "merch") return `merch:${item.id}:${item.size || ""}`;
  return `locker:${item.id}:${item.level || ""}`;
}

export function inventorySku(item: Pick<CartItem, "kind" | "id" | "size" | "level">): string {
  if (item.kind === "merch") return `merch#${item.id}#${item.size}`;
  return `locker#${item.id}#${item.level}`;
}

export function readCart(): CartItem[] {
  return readRaw(storageKeyFor(activeUserSub()));
}

export function writeCart(items: CartItem[]): void {
  writeRaw(storageKeyFor(activeUserSub()), items);
  window.dispatchEvent(new CustomEvent("chbe-cart-updated"));
}

export function cartCount(items = readCart()): number {
  return items.reduce((n, it) => n + (it.qty || 0), 0);
}

export function cashSubtotal(items = readCart()): number {
  return items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
}

export function cardSubtotal(items = readCart()): number {
  return Math.round(cashSubtotal(items) * CARD_SURCHARGE * 100) / 100;
}

/** Add merch (merges qty) or locker (qty always 1, replaces same level). */
export function addToCart(item: CartItem): CartItem[] {
  const cart = readCart();
  const key = cartLineKey(item);

  if (item.kind === "locker") {
    const next = cart.filter((c) => cartLineKey(c) !== key);
    next.push({ ...item, qty: 1 });
    writeCart(next);
    return next;
  }

  const existing = cart.find((c) => cartLineKey(c) === key);
  if (existing) {
    existing.qty += item.qty;
    writeCart(cart);
    return cart;
  }
  cart.push({ ...item });
  writeCart(cart);
  return cart;
}

export function updateQty(key: string, qty: number): CartItem[] {
  let cart = readCart();
  cart = cart
    .map((c) => {
      if (cartLineKey(c) !== key) return c;
      if (c.kind === "locker") return { ...c, qty: 1 };
      return { ...c, qty: Math.max(1, Math.floor(qty)) };
    })
    .filter((c) => c.qty > 0);
  writeCart(cart);
  return cart;
}

export function removeFromCart(key: string): CartItem[] {
  const cart = readCart().filter((c) => cartLineKey(c) !== key);
  writeCart(cart);
  return cart;
}

export function clearCart(): void {
  writeCart([]);
}

export function ordersApiUrl(): string {
  return (import.meta.env.PUBLIC_ORDERS_API_URL as string | undefined)?.replace(/\/$/, "") || "";
}

export async function fetchInventoryStock(skus?: string[]): Promise<Record<string, number>> {
  const base = ordersApiUrl();
  if (!base) return {};
  const qs = new URLSearchParams({ inventory: "1" });
  if (skus?.length) qs.set("skus", skus.join(","));
  const res = await fetch(`${base}/?${qs.toString()}`);
  if (!res.ok) return {};
  const data = await res.json();
  return (data?.stock as Record<string, number>) || {};
}

export async function placeOrder(args: {
  idToken: string;
  studentNumber: string;
  items: CartItem[];
}): Promise<{ orderID: string; status: number }> {
  const base = ordersApiUrl();
  if (!base) throw new Error("Orders API is not configured.");
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.idToken}`,
    },
    body: JSON.stringify({
      action: "place",
      studentNumber: args.studentNumber,
      items: args.items,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Could not place order."), {
      status: res.status,
      code: data.code,
      outOfStock: data.outOfStock,
    });
  }
  return { orderID: data.orderID, status: data.status };
}

export async function fetchOrder(args: {
  idToken: string;
  orderId: string;
}): Promise<Record<string, unknown>> {
  const base = ordersApiUrl();
  if (!base) throw new Error("Orders API is not configured.");
  const qs = new URLSearchParams({ orderId: args.orderId });
  const res = await fetch(`${base}/?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${args.idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Could not load order."), {
      status: res.status,
    });
  }
  return data.order as Record<string, unknown>;
}

export async function listOrders(args: {
  idToken: string;
}): Promise<Record<string, unknown>[]> {
  const base = ordersApiUrl();
  if (!base) throw new Error("Orders API is not configured.");
  const qs = new URLSearchParams({ list: "1" });
  const res = await fetch(`${base}/?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${args.idToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "Could not load orders."), {
      status: res.status,
    });
  }
  return Array.isArray(data.orders) ? data.orders : [];
}
