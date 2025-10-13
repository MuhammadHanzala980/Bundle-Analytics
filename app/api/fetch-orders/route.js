// app/api/sync-orders/route.js
import { NextResponse } from "next/server";
import { mkdir, writeFile, readFile, stat, rename } from "fs/promises";
import path from "path";
import axios from "axios";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PROGRESS_FILE = path.join(DATA_DIR, "orders_progress.json");
const TEMP_FILE = path.join(DATA_DIR, "orders.tmp.json");

const PER_PAGE = 100; // WooCommerce max per page
const DATE_FIELD_PREFERENCE = ["date_created", "date_created_gmt"];
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeParseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
async function fileExists(p) { try { await stat(p); return true; } catch { return false; } }

/**
 * Compute 'after' ISO default = 1 year ago (user file had custom date — kept it).
 * If orders.json exists we compute last saved date and use that (minus 1s).
 */
async function computeAfterIso() {
  // preserved the user's custom date code (you can replace with dynamic one-year-ago if needed)
  const oneYearAgo = new Date(Date.UTC(2024, 1, 1)); // 2024-02-01 (months are 0-indexed)
  oneYearAgo.setHours(0, 0, 0, 0);
  let afterIso = oneYearAgo.toISOString();

  if (await fileExists(ORDERS_FILE)) {
    try {
      const raw = await readFile(ORDERS_FILE, "utf8");
      const arr = safeParseJSON(raw) || [];
      if (Array.isArray(arr) && arr.length > 0) {
        let maxDate = null;
        for (const o of arr) {
          for (const f of DATE_FIELD_PREFERENCE) {
            if (o && o[f]) {
              const d = new Date(o[f]);
              if (!isNaN(d) && (!maxDate || d > maxDate)) maxDate = d;
              break;
            }
          }
        }
        if (maxDate) {
          maxDate.setSeconds(maxDate.getSeconds() - 1);
          const iso = maxDate.toISOString();
          if (new Date(iso) > new Date(afterIso)) afterIso = iso;
        }
      }
    } catch (e) {
      console.log("[sync-orders] computeAfterIso: failed to read orders.json, using default date.", e?.message || e);
    }
  }
  return afterIso;
}

/**
 * Read progress file if exists to resume exactly where we stopped.
 */
async function readProgress() {
  if (!(await fileExists(PROGRESS_FILE))) return null;
  try {
    const raw = await readFile(PROGRESS_FILE, "utf8");
    return safeParseJSON(raw);
  } catch (e) {
    console.log("[sync-orders] readProgress: failed to parse progress file.", e?.message || e);
    return null;
  }
}

/**
 * Fetch a single page using axios
 */
async function fetchOrdersPageAxios(siteUrl, key, secret, params) {
  const { page, per_page, after, order = "asc", orderby = "date" } = params;
  const url = new URL("/wp-json/wc/v3/orders", siteUrl.replace(/\/$/, ""));
  url.searchParams.set("per_page", String(per_page));
  url.searchParams.set("page", String(page));
  url.searchParams.set("orderby", orderby);
  url.searchParams.set("order", order);
  if (after) url.searchParams.set("after", after);

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await axios.get(url.toString(), {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    timeout: 30000,
    validateStatus: () => true,
  });

  const pageOrders = Array.isArray(res.data) ? res.data : [];
  const totalPagesHeader = res.headers["x-wp-totalpages"] || res.headers["x-wp-total-pages"] || res.headers["x-wp-total"];
  const totalPages = totalPagesHeader ? Number(totalPagesHeader) : null;

  return { orders: pageOrders, totalPages, statusCode: res.status, headers: res.headers };
}

/**
 * Simplify a single line item (keep only essential fields)
 */
function simplifyLineItem(li) {
  if (!li || typeof li !== "object") return null;
  // keep limited meta: key + value only
  const meta = Array.isArray(li.meta_data)
    ? li.meta_data.map((m) => ({ key: String(m.key || ""), value: m.value ?? null }))
    : [];

  return {
    id: li.id ?? null,
    product_id: li.product_id ?? null,
    variation_id: li.variation_id ?? null,
    name: li.name ?? null,
    quantity: li.quantity ?? null,
    subtotal: li.subtotal ?? null,
    total: li.total ?? null,
    meta_data: meta,
  };
}

/**
 * Simplify whole order object before saving to disk.
 * Keep only important fields so saved JSON is small and focused.
 */
function simplifyOrder(o) {
  if (!o || typeof o !== "object") return o;
  return {
    id: o.id ?? null,
    number: o.number ?? o.id ?? null,
    status: o.status ?? null,
    date_created: o.date_created ?? null,
    date_created_gmt: o.date_created_gmt ?? null,
    date_modified: o.date_modified ?? null,
    currency: o.currency ?? null,
    total: o.total ?? null,
    total_tax: o.total_tax ?? null,
    shipping_total: o.shipping_total ?? null,
    shipping_tax: o.shipping_tax ?? null,
    customer_id: o.customer_id ?? null,
    billing: {
      first_name: o.billing?.first_name ?? null,
      last_name: o.billing?.last_name ?? null,
      city: o.billing?.city ?? null,
      country: o.billing?.country ?? null,
      email: o.billing?.email ?? null,
      phone: o.billing?.phone ?? null,
    },
    
    // coupon_lines: Array.isArray(o.coupon_lines) ? o.coupon_lines.map(c => ({ code: c.code ?? null, discount: c.discount ?? null, discount_tax: c.discount_tax ?? null })) : [],
    // shipping_lines: Array.isArray(o.shipping_lines) ? o.shipping_lines.map(s => ({ method_id: s.method_id ?? null, method_title: s.method_title ?? null, total: s.total ?? null })) : [],
    line_items: Array.isArray(o.line_items) ? o.line_items.map(simplifyLineItem).filter(Boolean) : [],
    // small summary: useful for quick analytics
    // summary: {
    //   item_count: Array.isArray(o.line_items) ? o.line_items.reduce((acc, li) => acc + (Number(li.quantity || 0)), 0) : 0,
    // },
  };
}

export async function POST() {
  const siteUrl = process.env.WC_SITE_URL;
  const key = process.env.WC_CONSUMER_KEY;
  const secret = process.env.WC_CONSUMER_SECRET;
  if (!siteUrl || !key || !secret) {
    console.log("[sync-orders] Missing env vars.");
    return NextResponse.json({ ok: false, error: "Missing WC_SITE_URL, WC_CONSUMER_KEY, or WC_CONSUMER_SECRET." }, { status: 500 });
  }

  await mkdir(DATA_DIR, { recursive: true });

  // load existing orders map (id -> order) for dedupe (assumes file contains simplified orders)
  let existingMap = new Map();
  if (await fileExists(ORDERS_FILE)) {
    try {
      const raw = await readFile(ORDERS_FILE, "utf8");
      const arr = safeParseJSON(raw) || [];
      if (Array.isArray(arr)) {
        for (const o of arr) {
          if (o && typeof o.id !== "undefined") existingMap.set(String(o.id), o);
        }
      }
    } catch (e) {
      console.log("[sync-orders] Warning: failed parsing existing orders.json, starting fresh.", e?.message || e);
      existingMap = new Map();
    }
  }

  // compute afterISO (1 year ago or last saved date minus 1s)
  const afterIso = await computeAfterIso();

  // read previous progress to resume
  const progress = (await readProgress()) || {};
  let page = Number(progress.lastPageFetched) || 1;
  let skipIndex = Number(progress.lastIndexInPage) || 0; // number of items already processed in 'page'
  if (skipIndex >= PER_PAGE) { page = page + 1; skipIndex = 0; }

  console.log(`[sync-orders] START sync. after=${afterIso}`);
  console.log(`[sync-orders] Resuming from page=${page}, skipIndex=${skipIndex}`);
  console.log(`[sync-orders] Previously saved orders (deduped): ${existingMap.size}`);

  let fetchedTotalThisRun = 0;
  let retryCount = 0;
  let lastFetchedIso = progress.lastFetchedIso || null;

  try {
    while (true) {
      try {
        console.log(`[sync-orders] Fetching page ${page} (per_page=${PER_PAGE})...`);
        const result = await fetchOrdersPageAxios(siteUrl, key, secret, {
          page, per_page: PER_PAGE, after: afterIso, order: "asc", orderby: "date",
        });

        if (result.statusCode >= 400) {
          throw new Error(`WooCommerce API returned status ${result.statusCode}`);
        }

        const originalPageOrders = Array.isArray(result.orders) ? result.orders : [];

        if (originalPageOrders.length === 0) {
          console.log(`[sync-orders] Page ${page} empty — no more orders in range. Ending.`);
          break;
        }

        // If we have to skip some items (resume in middle of page)
        let pageOrders = originalPageOrders;
        if (skipIndex > 0) {
          if (skipIndex >= originalPageOrders.length) {
            // Entire page was already processed previously; move to next page
            console.log(`[sync-orders] Page ${page} already fully processed previously (skipIndex >= page length). Skipping page.`);
            const progressWrite = {
              updatedAt: new Date().toISOString(),
              lastPageFetched: page,
              lastIndexInPage: originalPageOrders.length,
              fetchedThisRun: fetchedTotalThisRun,
              totalSaved: existingMap.size,
              lastFetchedIso,
            };
            await writeFile(PROGRESS_FILE, JSON.stringify(progressWrite, null, 2), "utf8");
            page += 1;
            skipIndex = 0;
            continue;
          } else {
            console.log(`[sync-orders] Resuming inside page ${page}: skipping first ${skipIndex} items of ${originalPageOrders.length}.`);
            pageOrders = originalPageOrders.slice(skipIndex);
          }
        }

        // add orders to map (dedupe by id) BUT store simplified order only
        for (const rawOrder of pageOrders) {
          if (rawOrder && typeof rawOrder.id !== "undefined") {
            const simplified = simplifyOrder(rawOrder);
            existingMap.set(String(rawOrder.id), simplified);
          }
        }

        // update lastFetchedIso from the entire original page (not only processed slice)
        let pageMaxDate = null;
        for (const o of originalPageOrders) {
          for (const f of DATE_FIELD_PREFERENCE) {
            if (o && o[f]) {
              const d = new Date(o[f]);
              if (!isNaN(d) && (!pageMaxDate || d > pageMaxDate)) pageMaxDate = d;
              break;
            }
          }
        }
        if (pageMaxDate) lastFetchedIso = pageMaxDate.toISOString();

        const processedInThisPage = pageOrders.length;
        fetchedTotalThisRun += processedInThisPage;

        // atomic save: write temp then rename
        const merged = Array.from(existingMap.values());
        await writeFile(TEMP_FILE, JSON.stringify(merged, null, 2), "utf8");
        await rename(TEMP_FILE, ORDERS_FILE);

        // update progress: lastPageFetched = current page, lastIndexInPage = items processed in that page (cumulative)
        const lastIndexInPage = skipIndex + processedInThisPage; // after processing this page
        const progressWrite = {
          updatedAt: new Date().toISOString(),
          lastPageFetched: page,
          lastIndexInPage,
          fetchedThisRun: fetchedTotalThisRun,
          totalSaved: existingMap.size,
          lastFetchedIso,
          note: "Resumable by page+index. Orders saved as simplified objects (deduped by id).",
        };
        await writeFile(PROGRESS_FILE, JSON.stringify(progressWrite, null, 2), "utf8");

        // console visibility
        console.log(`[sync-orders] Page ${page} processed. Page items fetched: ${originalPageOrders.length}, processed this run from this page: ${processedInThisPage}`);
        console.log(`[sync-orders] Fetched this run: ${fetchedTotalThisRun}. Total saved (deduped): ${existingMap.size}. Last fetched date: ${lastFetchedIso}`);

        // prepare next page
        page += 1;
        skipIndex = 0; // subsequent pages start from 0
        retryCount = 0;

        // polite delay
        await sleep(200);
      } catch (err) {
        retryCount += 1;
        if (retryCount > MAX_RETRIES) {
          console.log(`[sync-orders] Failed after ${MAX_RETRIES} retries on page ${page}. Error: ${err?.message || err}`);
          throw new Error(`Failed after multiple retries: ${err?.message || err}`);
        } else {
          const wait = 1000 * Math.pow(2, retryCount);
          console.log(`[sync-orders] Error fetching page ${page}: ${err?.message || err}. Retrying ${retryCount}/${MAX_RETRIES} after ${wait}ms.`);
          await sleep(wait);
          continue; // retry same page
        }
      }
    }

    console.log(`[sync-orders] Sync complete. Total saved: ${existingMap.size}. Fetched this run: ${fetchedTotalThisRun}.`);
    return NextResponse.json({
      ok: true,
      message: "Orders fetched & saved (resumable, simplified).",
      count: existingMap.size,
      fetchedThisRun: fetchedTotalThisRun,
      file: "/data/orders.json",
      progressFile: "/data/orders_progress.json",
    });
  } catch (err) {
    console.log("[sync-orders] Fatal sync error:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error while syncing orders" }, { status: 500 });
  }
}
