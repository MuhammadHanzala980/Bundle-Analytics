// app/pairs/page.js
"use client";

import React, { useEffect, useMemo, useState } from "react";

/**
 * Pairs (Metorik-style "Bought Together")
 * - Reads public/data/orders.json
 * - Uses date_paid and only 'completed' orders (Metorik-like defaults)
 * - Skips fully refunded orders and zero-value/zero-qty line items
 * - Product identity: product_id::variation_id (deduped per order)
 * - Gummies are CONSOLIDATED as a single product key 'gummies::consolidated'
 * - Computes support, support %, confidence A->B, confidence B->A, lift
 *
 * Paste this file as: app/pairs/page.js
 * Requires Tailwind for styling (optional).
 */

export default function Page() {
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // UI controls
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [minCount, setMinCount] = useState(2);
  const [topN, setTopN] = useState(100);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("support"); // support | lift | confAtoB | supportPct

  // load orders.json
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const res = await fetch("/data/orders.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to fetch orders.json: ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setOrders(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // canonical gummies flavour words (for detection only; but we'll consolidate)
  const GUMMIES_KEYWORDS = useMemo(() => ["gummi", "gummies"], []);

  // safe date parse
  function toDateSafe(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  // Decide if order is eligible (Metorik-style):
  // - status must be 'completed'
  // - skip fully refunded orders (total_refunded >= total)
  // - optional date range uses date_paid (preferred) then date_completed then date_created
  function isOrderEligible(order, fromIso, toIso) {
    if (!order) return false;
    const status = String(order?.status || "").toLowerCase();
    if (status !== "completed") return false; // Metorik uses completed by default

    // skip fully refunded orders
    const total = Number(order?.total ?? 0);
    const refunded = Number(order?.total_refunded ?? 0);
    if (total === 0 || refunded >= total) return false;

    const dateVal = order?.date_paid ?? order?.date_completed ?? order?.date_created ?? order?.date_created_gmt;
    const dt = toDateSafe(dateVal);
    if (!dt) {
      // if no date field, consider it eligible (or change to false if you prefer)
      return true;
    }
    if (fromIso) {
      const f = new Date(fromIso);
      if (dt < f) return false;
    }
    if (toIso) {
      const t = new Date(toIso);
      if (dt > t) return false;
    }
    return true;
  }

  // Extract items for an order as identity keys { key, label }.
  // - Identity key for non-gummies: `${product_id}::${variation_id}`
  // - Gummies consolidated: `gummies::consolidated` with label "Gummies"
  // - Skip line items with quantity <=0 or total/subtotal <= 0 (discounted/refunded lines)
  function extractItemsForOrder(order) {
    const rawItems = Array.isArray(order?.line_items) ? order.line_items : [];
    const items = [];
    let sawGummiesLine = false;

    for (const li of rawItems) {
      const qty = Number(li?.quantity ?? 0);
      const lineTotal = Number(li?.total ?? li?.subtotal ?? 0);

      if (qty <= 0) continue; // ignore zero quantity
      if (lineTotal <= 0) continue; // ignore zero-value lines

      const name = String(li?.name ?? "").trim();
      // detect gummy lines by keyword in name (consolidate)
      const lower = name.toLowerCase();
      if (GUMMIES_KEYWORDS.some(k => lower.includes(k))) {
        sawGummiesLine = true;
        // don't push flavored variants here — consolidation only
        continue;
      }

      const pid = li?.product_id ?? li?.id ?? null;
      const vid = li?.variation_id ?? 0;
      const key = `${String(pid)}::${String(vid)}`;
      // short label for UI - first two words
      const words = name.split(/\s+/).filter(Boolean);
      const label = words.slice(0, 2).join(" ") || name || `product-${pid}`;

      items.push({ key, label });
    }

    // add consolidated Gummies presence if any gummy line was present
    if (sawGummiesLine) {
      items.push({ key: "gummies::consolidated", label: "Gummies" });
    }

    // dedupe per order by key
    const uniq = new Map();
    for (const it of items) {
      if (!uniq.has(it.key)) uniq.set(it.key, it);
    }
    return Array.from(uniq.values());
  }

  // Main computation: pair metrics (support/counts/etc.)
  const { pairs, totalEligibleOrders, productsByKey } = useMemo(() => {
    if (!Array.isArray(orders)) return { pairs: [], totalEligibleOrders: 0, productsByKey: {} };

    // prepare date range ISO from controls (if set)
    const fromIso = fromDate ? new Date(`${fromDate}T00:00:00Z`).toISOString() : null;
    const toIso = toDate ? new Date(`${toDate}T23:59:59Z`).toISOString() : null;

    const eligible = [];
    for (const o of orders) {
      if (isOrderEligible(o, fromIso, toIso)) eligible.push(o);
    }

    // maps for counts
    const itemCounts = new Map(); // key -> count of orders containing it
    const pairCounts = new Map(); // 'A||B' -> count
    const products = new Map(); // key -> label (for dropdown)

    for (const ord of eligible) {
      const items = extractItemsForOrder(ord).map(it => ({ key: it.key, label: it.label }));
      if (!items || items.length < 1) continue;

      // update product label map and itemCounts (presence-based)
      const seenKeys = new Set();
      for (const it of items) {
        products.set(it.key, it.label);
        if (!seenKeys.has(it.key)) {
          itemCounts.set(it.key, (itemCounts.get(it.key) || 0) + 1);
          seenKeys.add(it.key);
        }
      }

      // unordered pairs within this order (presence-based)
      const keys = items.map(i => i.key).sort(); // sort for stability; keys unique per order
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = keys[i], b = keys[j];
          const pairKey = `${a}||${b}`; // canonical
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
        }
      }
    }

    // build pairs array
    const arr = [];
    const total = eligible.length;
    for (const [pairKey, cnt] of pairCounts.entries()) {
      if (cnt < minCount) continue;
      const [A, B] = pairKey.split("||");
      const countA = itemCounts.get(A) || 0;
      const countB = itemCounts.get(B) || 0;
      const support = cnt;
      const supportPct = total > 0 ? (support / total) * 100 : 0;
      const confAtoB = countA > 0 ? support / countA : 0; // P(B|A)
      const confBtoA = countB > 0 ? support / countB : 0; // P(A|B)
      const lift = (total > 0 && countA > 0 && countB > 0) ? (support / total) / ((countA / total) * (countB / total)) : 0;
      arr.push({ A, B, support, supportPct, countA, countB, confAtoB, confBtoA, lift });
    }

    // sort by chosen metric (default: support)
    arr.sort((x, y) => {
      if (sortBy === "lift") return y.lift - x.lift;
      if (sortBy === "confAtoB") return y.confAtoB - x.confAtoB;
      if (sortBy === "supportPct") return y.supportPct - x.supportPct;
      return y.support - x.support;
    });

    // productsByKey array for UI dropdown (sorted by label)
    const productsByKeyObj = {};
    Array.from(products.entries()).sort((a, b) => a[1].localeCompare(b[1])).forEach(([k, lbl]) => { productsByKeyObj[k] = lbl; });

    return { pairs: arr, totalEligibleOrders: total, productsByKey: productsByKeyObj };
  }, [orders, fromDate, toDate, minCount, sortBy]);

  // filtered / displayed pairs for UI (search + topN)
  const displayedPairs = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = pairs;
    if (q) {
      arr = arr.filter(p => {
        const Ak = productsByKey[p.A] || p.A;
        const Bk = productsByKey[p.B] || p.B;
        return Ak.toLowerCase().includes(q) || Bk.toLowerCase().includes(q);
      });
    }
    return arr.slice(0, topN);
  }, [pairs, query, topN, productsByKey]);

  // also-bought for selected product
  const [selectedProductKey, setSelectedProductKey] = useState("");
  const alsoBought = useMemo(() => {
    if (!selectedProductKey) return [];
    const list = [];
    for (const p of pairs) {
      if (p.A === selectedProductKey) list.push({ productKey: p.B, support: p.support, conf: p.confAtoB, lift: p.lift });
      else if (p.B === selectedProductKey) list.push({ productKey: p.A, support: p.support, conf: p.confBtoA, lift: p.lift });
    }
    list.sort((a, b) => b.support - a.support);
    return list;
  }, [pairs, selectedProductKey]);

  // CSV export
  function downloadCSV() {
    const rows = [["A_key", "A_label", "B_key", "B_label", "support", "countA", "countB", "confAtoB", "confBtoA", "lift", "supportPct"]];
    for (const p of pairs.slice(0, topN)) {
      const aLabel = productsByKey[p.A] || p.A;
      const bLabel = productsByKey[p.B] || p.B;
      rows.push([p.A, aLabel, p.B, bLabel, String(p.support), String(p.countA), String(p.countB), p.confAtoB.toFixed(4), p.confBtoA.toFixed(4), p.lift.toFixed(4), p.supportPct.toFixed(3)]);
    }
    const csv = rows.map(r => r.map(field => `"${String(field).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pairs-${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // small helper for display label
  function labelFor(key) {
    return productsByKey[key] || key;
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6 md:p-10">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Bought Together — Metorik style (pairs)</h1>
            <p className="text-sm text-gray-600">Using <strong>date_paid</strong>, only <strong>completed</strong> orders, product identity by <code>product_id::variation_id</code>, and Gummies are consolidated as one product.</p>
          </div>
          <div className="text-sm text-gray-600">Eligible orders: <span className="font-medium">{totalEligibleOrders}</span></div>
        </header>

        <section className="bg-white rounded-lg shadow p-4 md:p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm">From</div>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="p-2 border rounded" />
              <div className="text-sm">To</div>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="p-2 border rounded" />

              <div className="flex items-center gap-2">
                <div className="text-sm">Min count</div>
                <input type="number" min={1} value={minCount} onChange={e => setMinCount(Number(e.target.value || 1))} className="w-24 p-2 border rounded" />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input placeholder="Search product..." value={query} onChange={e => setQuery(e.target.value)} className="p-2 border rounded" />
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="p-2 border rounded">
                <option value="support">Sort: support</option>
                <option value="lift">Sort: lift</option>
                <option value="confAtoB">Sort: confidence A→B</option>
                <option value="supportPct">Sort: support %</option>
              </select>
              <input type="number" min={10} value={topN} onChange={e => setTopN(Number(e.target.value || 100))} className="w-24 p-2 border rounded" />
              <button onClick={downloadCSV} className="px-3 py-2 bg-indigo-600 text-white rounded">Export CSV</button>
            </div>
          </div>
        </section>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-4">
            {displayedPairs.length === 0 ? (
              <div className="p-4 bg-yellow-50 rounded">No pairs found with current filters (try lowering min count or widening date range).</div>
            ) : (
              displayedPairs.map((p, i) => (
                <div key={`${p.A}||${p.B}`} className="bg-white rounded-lg shadow p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="flex items-center gap-4">
                    <div className="text-sm text-gray-500">#{i + 1}</div>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-indigo-50 text-indigo-700 border" title={labelFor(p.A)}>{labelFor(p.A)}</span>
                      <div className="text-gray-400">+</div>
                      <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-indigo-50 text-indigo-700 border" title={labelFor(p.B)}>{labelFor(p.B)}</span>
                    </div>
                    <div className="ml-3 text-sm text-gray-600">Support: <span className="font-semibold text-gray-800">{p.support}</span></div>
                  </div>

                  <div className="flex items-center gap-6 flex-wrap">
                    <div className="text-sm text-gray-600">Support %: <span className="font-medium">{p.supportPct.toFixed(2)}%</span></div>
                    <div className="text-sm text-gray-600">P({labelFor(p.B)}|{labelFor(p.A)}): <span className="font-medium">{(p.confAtoB * 100).toFixed(1)}%</span></div>
                    <div className="text-sm text-gray-600">P({labelFor(p.A)}|{labelFor(p.B)}): <span className="font-medium">{(p.confBtoA * 100).toFixed(1)}%</span></div>
                    <div className="text-sm text-gray-600">Lift: <span className="font-medium">{p.lift.toFixed(2)}</span></div>
                  </div>
                </div>
              ))
            )}
          </div>

          <aside className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Also bought (for product)</div>
                <div className="text-xs text-gray-400">Top co-occurring</div>
              </div>

              <select value={selectedProductKey} onChange={e => setSelectedProductKey(e.target.value)} className="w-full p-2 border rounded mb-3">
                <option value="">-- select product --</option>
                {Object.entries(productsByKey).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
              </select>

              {!selectedProductKey ? (
                <div className="text-xs text-gray-500">Choose a product to see what customers also buy with it.</div>
              ) : alsoBought.length === 0 ? (
                <div className="text-xs text-gray-500">No co-occurring products found for this product with current filters.</div>
              ) : (
                <div className="space-y-2">
                  {alsoBought.map((ab) => (
                    <div key={ab.productKey} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-gray-50 border" title={labelFor(ab.productKey)}>{labelFor(ab.productKey)}</span>
                        <div className="text-xs text-gray-500">({ab.support} orders)</div>
                      </div>
                      <div className="text-xs text-gray-600">P={(ab.conf*100).toFixed(1)}% • lift {ab.lift.toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-lg shadow p-4 text-sm text-gray-600">
              Tip: This matches Metorik-like behaviour: uses <strong>date_paid</strong> and only <strong>completed</strong> orders, product identity by <code>product_id::variation_id</code>, and Gummies consolidated as one product.
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
