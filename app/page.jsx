"use client";

import React, { useEffect, useMemo, useState } from "react";

/**
 * Bundle Analytics — Metorik-like bought-together behavior
 * Changes made:
 * 1) Counting/aggregation is done by productId (synthetic ids for gummies preserved)
 * 2) Orders with status: completed, processing, OR paid are considered eligible
 * 3) Bundle keys (for counting) are based on productId, while the UI still
 *    displays human-friendly bundle labels (displayName / variant info)
 *
 */

export default function Page() {
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // UI controls
  const [selectedSize, setSelectedSize] = useState(3);
  const [showRangeToEnd, setShowRangeToEnd] = useState(false);
  const [query, setQuery] = useState("");
  const [visiblePerSection, setVisiblePerSection] = useState(8);

  // NEW: explodeGummies toggle
  const [explodeGummies, setExplodeGummies] = useState(false);

  const GUMMIES_FLAVORS = [
    "grape",
    "mango",
    "watermelon",
    "blueberry",
    "lemon",
    "pineapple",
  ];

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const GUMMIES_FLAVOR_REGEXES = useMemo(() => {
    const map = {};
    for (const f of GUMMIES_FLAVORS) {
      map[f] = new RegExp(`\\b${escapeRegExp(f)}\\b`, "i");
    }
    return map;
  }, []);

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

  // total eligible orders (completed, processing, or paid)
  const totalEligibleOrders = useMemo(() => {
    if (!Array.isArray(orders)) return 0;
    return orders.reduce((acc, o) => {
      const st = String(o?.status || "").toLowerCase();
      return acc + ((st === "completed" || st === "processing" || st === "paid") ? 1 : 0);
    }, 0);
  }, [orders]);

  const PALETTE = [
    "#1F4B99", "#0B7546", "#B43E3E", "#D97706", "#7C3AED",
    "#065F46", "#0EA5A4", "#BE185D", "#114D8C", "#92400E"
  ];
  function colorFor(s) {
    if (!s) return PALETTE[0];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function capitalize(s) { if (!s) return s; return s[0].toUpperCase() + s.slice(1); }

  function normalizeProductName(rawName) {
    if (!rawName) return { product: "Unknown", variant: "" };
    const name = String(rawName).trim();
    const lower = name.toLowerCase();

    if (/gummi/i.test(lower)) {
      return { product: "Gummies", variant: "" };
    }

    const words = name.split(/\s+/).filter(Boolean);
    const short = words.slice(0, 2).join(" ");
    return { product: short || name, variant: words.slice(2).join(" ") || "", full: name };
  }

  function extractLineItems(order) {
    const raw = Array.isArray(order?.line_items) ? order.line_items : [];
    const nonGummies = [];
    const gummiesFlavorsSet = new Set();
    let sawAnyGummiesLine = false;

    for (const li of raw) {
      const rawName = String(li?.name || "").trim();
      const pid = li?.product_id ?? li?.id ?? null;
      const variationId = li?.variation_id ?? 0;

      let metaValues = [];
      if (Array.isArray(li?.meta_data)) {
        for (const m of li.meta_data) {
          try {
            if (m && typeof m.value !== 'undefined' && m.value !== null) {
              metaValues.push(String(m.value));
            }
          } catch (e) {}
        }
      }

      const norm = normalizeProductName(rawName);
      const displayName = norm.product;

      if (displayName === "Gummies") {
        sawAnyGummiesLine = true;

        for (const f of GUMMIES_FLAVORS) {
          const re = GUMMIES_FLAVOR_REGEXES[f];
          if (re && re.test(rawName)) {
            gummiesFlavorsSet.add(capitalize(f));
          }
        }

        for (const mv of metaValues) {
          for (const f of GUMMIES_FLAVORS) {
            const re = GUMMIES_FLAVOR_REGEXES[f];
            if (re && re.test(mv)) {
              gummiesFlavorsSet.add(capitalize(f));
            }
          }
        }

        if (gummiesFlavorsSet.size === 0 && metaValues.length > 0) {
          for (const mv of metaValues) {
            const parts = String(mv).split(/[,|\\/]+/).map(p => p.trim()).filter(Boolean);
            for (const p of parts) {
              let found = false;
              for (const f of GUMMIES_FLAVORS) {
                if (GUMMIES_FLAVOR_REGEXES[f].test(p)) {
                  gummiesFlavorsSet.add(capitalize(f));
                  found = true;
                }
              }
              if (!found && p.length > 0) {
                gummiesFlavorsSet.add(p);
              }
            }
          }
        }

        if (explodeGummies) {
          if (gummiesFlavorsSet.size > 0) {
            for (const fv of Array.from(gummiesFlavorsSet)) {
              nonGummies.push({
                productId: `gummies-${fv}`,
                displayName: `Gummies(${fv})`,
                fullName: `Gummies(${fv})`,
                variantId: `0`,
                variantName: "",
              });
            }
          } else {
            nonGummies.push({
              productId: `gummies-unspecified`,
              displayName: `Gummies(Unspecified)`,
              fullName: `Gummies(Unspecified)`,
              variantId: `0`,
              variantName: "",
            });
          }
        }

      } else {
        let metaVariant = "";
        if (Array.isArray(li?.meta_data)) {
          const meta = li.meta_data.find((m) => /flavor|flavour|size|color|variant|attribute/i.test(String(m?.key || "")));
          if (meta) metaVariant = String(meta.value || "");
        }

        nonGummies.push({
          productId: String(pid ?? "null"),
          displayName,
          fullName: rawName || displayName,
          variantId: String(variationId ?? "0"),
          variantName: (metaVariant || norm.variant || "").trim(),
        });
      }
    }

    if (!explodeGummies) {
      const items = [...nonGummies];
      if (gummiesFlavorsSet.size > 0) {
        const flavorsArr = Array.from(gummiesFlavorsSet);
        items.push({
          productId: "gummies",
          displayName: "Gummies",
          fullName: "Gummies",
          variantId: "0",
          variantName: "",
          flavors: flavorsArr.map(f => String(f)),
        });
      } else if (sawAnyGummiesLine) {
        items.push({
          productId: "gummies",
          displayName: "Gummies",
          fullName: "Gummies",
          variantId: "0",
          variantName: "",
          flavors: ["Unspecified"],
        });
      }

      // dedupe by productId (prefer first occurrence for displayName)
      const seen = new Map();
      for (const it of items) {
        const key = it.productId;
        if (!seen.has(key)) seen.set(key, it);
        else {
          const existing = seen.get(key);
          if (existing.productId === "gummies" && Array.isArray(existing.flavors) && Array.isArray(it.flavors)) {
            const merged = new Set([...existing.flavors, ...it.flavors]);
            existing.flavors = Array.from(merged);
            seen.set(key, existing);
          }
        }
      }

      return Array.from(seen.values());
    }

    // exploding: dedupe by productId
    const seen2 = new Map();
    for (const it of nonGummies) {
      const key = it.productId;
      if (!seen2.has(key)) seen2.set(key, it);
    }
    return Array.from(seen2.values());
  }

  function combinations(arr, k) {
    const res = [];
    const n = arr.length;
    if (k > n) return res;
    const cur = new Array(k);
    function bt(i, start) {
      if (i === k) {
        res.push(cur.slice());
        return;
      }
      for (let j = start; j < n; j++) {
        cur[i] = arr[j];
        bt(i + 1, j + 1);
      }
    }
    bt(0, 0);
    return res;
  }

  function variantPartString(it) {
    if (!it) return "";
    if (it.displayName === "Gummies") {
      const flavors = Array.isArray(it.flavors) && it.flavors.length ? it.flavors : [];
      if (flavors.length === 0) return "Gummies(Unspecified)";
      const sorted = flavors.slice().map(String).sort((a, b) => a.localeCompare(b));
      return `Gummies(${sorted.join(",")})`;
    }
    if (it.variantName) return `${it.displayName}(${it.variantName})`;
    return it.displayName;
  }

  // Build bundles for sizes 1..7 using only completed/processing/paid orders
  const bundlesBySize = useMemo(() => {
    const maps = {};
    for (let s = 1; s <= 7; s++) maps[s] = new Map();
    if (!Array.isArray(orders)) return Object.fromEntries(Object.entries(maps).map(([k]) => [k, []]));

    for (const order of orders) {
      const st = String(order?.status || "").toLowerCase();
      if (st !== "completed" && st !== "processing" && st !== "paid") continue;

      const items = extractLineItems(order);
      if (!items || items.length < 1) continue;

      // deterministic sort by productId to make bundleKey stable
      items.sort((a, b) => (String(a.productId)).localeCompare(String(b.productId)));

      for (let s = 1; s <= 7; s++) {
        if (items.length < s) continue;
        const combs = combinations(items, s);
        for (const comb of combs) {
          // Use productId-based key for counting (Metorik-like)
          const bundleIdKey = comb.map((c) => String(c.productId)).join(" | ");
          // For UI label keep human-friendly names (variant-aware)
          const bundleLabel = comb.map((c) => variantPartString(c)).join(" | ");

          // variantKey should include variant/flavor detail so we can aggregate variants
          const variantKey = comb.map((c) => variantPartString(c)).join(" | ");

          if (!maps[s].has(bundleIdKey)) maps[s].set(bundleIdKey, { count: 0, variants: new Map(), sample: [], label: bundleLabel });
          const rec = maps[s].get(bundleIdKey);
          rec.count += 1;
          rec.variants.set(variantKey, (rec.variants.get(variantKey) || 0) + 1);
          if (rec.sample.length < 6) {
            rec.sample.push({
              id: order?.id ?? null,
              date: order?.date_created ?? order?.date_created_gmt ?? order?.date_modified ?? null,
            });
          }
        }
      }
    }

    const out = {};
    for (let s = 1; s <= 7; s++) {
      out[s] = Array.from(maps[s].entries())
        .map(([bundleId, data]) => ({
          bundle: data.label, // human readable label
          idKey: bundleId,     // productId-based key (for debugging / export if needed)
          count: data.count,
          variants: Array.from(data.variants.entries()).map(([k, c]) => ({ combo: k, count: c })),
          sample: data.sample,
        }))
        .sort((a, b) => b.count - a.count);
    }
    return out;
  }, [orders, explodeGummies]);

  const sizesToShow = useMemo(() => {
    const s = Number(selectedSize) || 1;
    if (showRangeToEnd) {
      const arr = [];
      for (let i = s; i <= 7; i++) arr.push(i);
      return arr;
    }
    return [s];
  }, [selectedSize, showRangeToEnd]);

  const combinedList = useMemo(() => {
    const all = [];
    for (const size of sizesToShow) {
      const arr = Array.isArray(bundlesBySize[size]) ? bundlesBySize[size] : [];
      all.push(...arr.map((b) => ({ ...b, size })));
    }
    return all.sort((a, b) => b.count - a.count);
  }, [bundlesBySize, sizesToShow]);

  function shortDisplay(full) {
    if (!full) return "-";
    const words = String(full).split(/\s+/).filter(Boolean);
    return words.slice(0, 2).join(" ");
  }

  function downloadCSV() {
    const rows = ["Size,Bundle,BundleIdKey,Count,TopVariants"];
    for (const b of combinedList) {
      const top = (b.variants || []).slice(0, 5).map((v) => `${v.combo} (${v.count})`).join("; ");
      rows.push(`${b.size},"${b.bundle}","${b.idKey}",${b.count},"${top}"`);
    }
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bundles-${new Date().toISOString()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function percentOf(total, value) {
    if (!total || total === 0) return 0;
    return Math.round((value / total) * 100);
  }

  function gummiesFlavorCounts(bundle) {
    const counts = {};
    if (!bundle || !Array.isArray(bundle.variants)) return [];
    for (const v of bundle.variants) {
      const combo = String(v.combo || "");
      const re = /Gummies\(([^)]+)\)/ig;
      let m;
      let matched = false;
      while ((m = re.exec(combo)) !== null) {
        matched = true;
        const inner = m[1].trim();
        const parts = inner.split(",").map(p => p.trim()).filter(Boolean);
        for (const p of parts) {
          counts[p] = (counts[p] || 0) + (v.count || 0);
        }
      }
      if (!matched && /(^|\s|\|)Gummies($|\s|\|)/i.test(combo)) {
        counts["Unspecified"] = (counts["Unspecified"] || 0) + (v.count || 0);
      }
    }
    const arr = Object.entries(counts).map(([flavor, count]) => ({ flavor, count }));
    arr.sort((a, b) => b.count - a.count);
    return arr;
  }

  // --- UI ---
  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-gray-50 p-4 md:p-8 lg:p-12">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-gray-900">Bundle Analytics — Products Bought Together</h1>
            <p className="text-sm text-gray-600 mt-1">Select bundle size (1–7). Toggle <span className="font-medium">Show range</span> to display from selected size up to 7. Only <span className="italic">completed</span>, <span className="italic">processing</span> and <span className="italic">paid</span> orders are used.</p>
          </div>

          <div className="text-sm text-gray-600">
            Total eligible orders: <span className="font-semibold text-gray-800">{totalEligibleOrders}</span>
          </div>
        </header>

        {/* Controls */}
        <section className="w-full bg-white shadow rounded-lg p-4 md:p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">Bundle size</span>
                <div className="inline-flex rounded-md shadow-sm ring-1 ring-gray-100 overflow-hidden">
                  {[1,2,3,4,5,6,7].map((n) => (
                    <button
                      key={n}
                      onClick={() => setSelectedSize(n)}
                      className={`px-3 py-1 text-sm font-medium focus:outline-none ${selectedSize === n ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                      aria-pressed={selectedSize === n}
                    >{n}</button>
                  ))}
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-600 ml-2">
                  <input type="checkbox" checked={showRangeToEnd} onChange={(e) => setShowRangeToEnd(e.target.checked)} className="h-4 w-4" />
                  <span>Show range (selected → 7)</span>
                </label>
              </div>

              <div className="hidden sm:flex items-center gap-2">
                <button onClick={() => { setVisiblePerSection(8); setQuery(""); }} className="px-3 py-1 bg-gray-100 rounded text-sm">Reset</button>
                <button onClick={downloadCSV} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm shadow">Export CSV</button>

                <button
                  onClick={() => setExplodeGummies(v => !v)}
                  className={`px-3 py-1 rounded text-sm ${explodeGummies ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-800'}`}
                  title="Toggle: treat each gummy flavor as a separate product"
                >
                  {explodeGummies ? 'Gummies: flavors = separate products' : 'Gummies: flavors = consolidated'}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <input placeholder="Search bundle..." value={query} onChange={(e) => setQuery(e.target.value)} className="pl-10 pr-3 py-2 border rounded w-64 focus:ring-1 focus:ring-indigo-200" />
                <div className="absolute left-3 top-2.5 text-gray-400 text-sm">🔎</div>
              </div>

              <div className="sm:hidden flex items-center gap-2">
                <button onClick={downloadCSV} className="px-3 py-1 bg-indigo-600 text-white rounded text-sm">Export</button>
                <button
                  onClick={() => setExplodeGummies(v => !v)}
                  className={`px-3 py-1 rounded text-sm ${explodeGummies ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-800'}`}
                  title="Toggle: treat each gummy flavor as a separate product"
                >
                  {explodeGummies ? 'Gummies: flavors = separate products' : 'Gummies: flavors = consolidated'}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Content */}
        {loading ? (
          <div className="space-y-4">
            {[1,2,3].map((i) => (
              <div key={i} className="animate-pulse bg-white rounded-lg shadow p-4">
                <div className="h-4 bg-gray-200 rounded w-1/3 mb-3"></div>
                <div className="h-3 bg-gray-200 rounded w-1/2 mb-2"></div>
                <div className="h-12 bg-gray-100 rounded"></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 rounded text-red-700">Error loading orders: {String(error)}</div>
        ) : (
          <main className="space-y-8">
            {sizesToShow.map((size) => {
              const arr = Array.isArray(bundlesBySize[size]) ? bundlesBySize[size] : [];
              const filtered = arr.filter((b) => !query || b.bundle.toLowerCase().includes(query.toLowerCase()));
              return (
                <section key={size} className="w-full">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-semibold">Bundles of {size} item{size > 1 ? "s" : ""}</h2>
                    <div className="text-sm text-gray-500">Unique bundles: <span className="font-medium text-gray-700">{arr.length}</span> — Showing: <span className="font-medium">{Math.min(filtered.length, visiblePerSection)}</span></div>
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    {filtered.slice(0, visiblePerSection).map((b, idx) => {
                      const includesGummies = b.bundle.split(" | ").some(p => p === "Gummies" || /gummi/i.test(p));
                      const gummiesCounts = gummiesFlavorCounts(b);
                      const totalGummiesCount = gummiesCounts.length ? gummiesCounts.reduce((s, x) => s + x.count, 0) : 0;

                      return (
                        <article key={`${size}-${b.bundle}`} className="w-full bg-white rounded-lg shadow-md p-4 md:p-6 flex flex-col gap-4 hover:shadow-lg transition relative">

                          <div className="absolute right-4 top-4">
                            <button
                              onClick={() => { navigator.clipboard?.writeText(b.bundle); }}
                              className="px-3 py-1 border rounded text-sm bg-white"
                              title="Copy bundle"
                            >
                              Copy
                            </button>
                          </div>

                          <div className="w-full">
                            <div className="flex items-center gap-3">
                              <div className="text-sm text-gray-500">Rank #{idx + 1}</div>
                              <div className="ml-1 px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded-full text-xs font-semibold">{b.count} orders</div>
                            </div>

                            <h3 className="mt-3 text-lg font-semibold text-gray-900" title={b.bundle}>
                              <div className="flex flex-wrap gap-2">
                                {b.bundle.split(" | ").map((part, i) => {
                                  const c = colorFor(part);
                                  const label = shortDisplay(part);
                                  return (
                                    <span
                                      key={i}
                                      className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium"
                                      style={{ color: c, backgroundColor: `${c}15`, border: `1px solid ${c}22` }}
                                    >
                                      {label}
                                    </span>
                                  );
                                })}
                              </div>
                            </h3>

                            <div className="mt-2 text-sm text-gray-600">
                              Orders: <span className="font-semibold text-gray-800">{b.count}</span>
                              </div>
                          </div>

                          {!explodeGummies && includesGummies  && (
                            <div className="w-full bg-white border border-gray-100 rounded-lg p-4 shadow-sm">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className="text-lg font-semibold text-gray-800 flex items-center gap-2"> Gummies breakdown</div>
                                  <div className="text-xs text-gray-500">flavor distribution in this bundle</div>
                                </div>
                              </div>

                              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {gummiesCounts.length > 0 ? gummiesCounts.map((g) => {
                                  const barColor = colorFor(g.flavor);
                                  const pct = percentOf(totalGummiesCount, g.count);
                                  return (
                                    <div key={g.flavor} className="p-2 bg-gray-50 rounded">
                                      <div className="flex items-center justify-between">
                                        <div className="text-sm font-medium text-gray-800">{g.flavor}</div>
                                        <div className="text-sm text-gray-600">{g.count}</div>
                                      </div>

                                      <div className="mt-2">
                                        <div className="w-full bg-gray-100 rounded h-2 overflow-hidden">
                                          <div
                                            style={{ width: `${pct}%`, backgroundColor: barColor }}
                                            className="h-2 rounded-full"
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  );
                                }) : (
                                  <div className="text-xs text-gray-400 col-span-full">No gummies variant data available</div>
                                )}
                              </div>
                            </div>
                          )}

                        </article>
                      );
                    })}

                    {filtered.length === 0 && (
                      <div className="p-4 bg-yellow-50 rounded">No bundles found for this size/range with current filters.</div>
                    )}
                  </div>

                  <div className="mt-4 text-center">
                    {visiblePerSection < filtered.length && (
                      <button onClick={() => setVisiblePerSection((v) => v + 8)} className="px-4 py-2 bg-gray-100 rounded">Show more</button>
                    )}
                  </div>
                </section>
              );
            })}
          </main>
        )}
      </div>
    </div>
  );
}
