// app/api/reviews/stream-json/route.js
import { TextEncoder } from "util" // Node4+ (if runtime provides, ok). If Edge, TextEncoder exists globally.

const PER_PAGE = 100
const MAX_PER_PAGE = 100
const REQUEST_TIMEOUT_MS = 15000
// reuse fetchPage and helpers from earlier — inline minimal version for streaming:

function base64Encode(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64")
  if (typeof btoa !== "undefined") return btoa(str)
  throw new Error("No base64 encoder")
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err) { clearTimeout(id); throw err }
}

async function fetchPage(url, headers, page, perPage) {
  const u = new URL(url); u.searchParams.set("page", String(page)); u.searchParams.set("per_page", String(perPage))
  const res = await fetchWithTimeout(u.toString(), { method: "GET", headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return { json, headers: res.headers }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url)
    const productId = searchParams.get("product_id") || null
    const siteUrl = process.env.WC_SITE_URL
    const consumerKey = process.env.WC_CONSUMER_KEY
    const consumerSecret = process.env.WC_CONSUMER_SECRET
    if (!siteUrl || !consumerKey || !consumerSecret) return new Response(JSON.stringify({ success: false, error: "Missing WC env" }), { status: 500 })

    const auth = base64Encode(`${consumerKey}:${consumerSecret}`)
    const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" }
    const baseApi = `${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3/products/reviews?status=approved${productId ? `&product=${encodeURIComponent(productId)}` : ""}`
    const perPage = Math.min(PER_PAGE, MAX_PER_PAGE)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let page = 1
          while (true) {
            console.info(`[stream-json] fetching page ${page}`)
            const { json: pageJson, headers: resHeaders } = await fetchPage(baseApi, headers, page, perPage)
            if (!Array.isArray(pageJson) || pageJson.length === 0) break
            // filter admin replies
            const customerReviews = pageJson.filter((r) => !r.parent_id || Number(r.parent_id) === 0)
            for (const r of customerReviews) {
              controller.enqueue(encoder.encode(JSON.stringify(r) + "\n"))
            }
            const xTotalPages = resHeaders.get("x-wp-total-pages")
            if (xTotalPages) {
              const totalPages = Number.parseInt(xTotalPages, 10)
              if (page >= totalPages) break
            } else if (pageJson.length < perPage) break
            page++
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*" } })
  } catch (err) {
    console.error("stream-json error:", err)
    return new Response(JSON.stringify({ success: false, error: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
}
