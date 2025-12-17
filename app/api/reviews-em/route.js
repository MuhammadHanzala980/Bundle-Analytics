import { NextResponse } from 'next/server'

const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 100
const REQUEST_TIMEOUT_MS = 15000
const MAX_RETRIES = 3
const MAX_PAGES_SAFE = 2000
const MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES = 3
const MAX_RETURN = 5000

function base64Encode(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64")
  if (typeof btoa !== "undefined") return btoa(str)
  throw new Error("No base64 encoder available")
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

async function fetchJsonWithRetries(url, options = {}, retries = MAX_RETRIES) {
  let attempt = 0
  while (true) {
    attempt++
    try {
      const res = await fetchWithTimeout(url, options, REQUEST_TIMEOUT_MS)
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status} ${res.statusText} - ${body}`)
      }
      const json = await res.json().catch(async (e) => {
        const txt = await res.text().catch(() => "")
        throw new Error(`Failed parse JSON: ${e.message} - body: ${txt}`)
      })
      return { json, headers: res.headers }
    } catch (err) {
      if (attempt >= retries) throw err
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 200
      console.warn(`Retry ${attempt}/${retries} for ${url}. Waiting ${Math.round(backoff)}ms. Error: ${err.message}`)
      await sleep(backoff)
    }
  }
}

function normalizeCommentToReview(c) {
  const id = c.id ?? null
  const parent_id = c.parent || c.parent_id || 0
  const reviewer = c.reviewer || c.author_name || c.author || (c.name ? c.name : "Anonymous")
  const review = (c.content && c.content.rendered) ? c.content.rendered : (c.review || c.content || "")
  const date_created = c.date_created || c.date || c.date_gmt || null

  let rating = 0
  try {
    if (c.rating !== undefined && c.rating !== null && c.rating !== "") {
      rating = Number(c.rating)
    } else if (c.meta && (c.meta.rating !== undefined)) {
      rating = Array.isArray(c.meta.rating) ? Number(c.meta.rating[0] ?? 0) : Number(c.meta.rating ?? 0)
    } else if (c.meta && c.meta._rating !== undefined) {
      rating = Number(c.meta._rating ?? 0)
    } else if (c.author_meta && c.author_meta.rating !== undefined) {
      rating = Number(c.author_meta.rating ?? 0)
    }
  } catch (e) {
    rating = 0
  }
  if (!Number.isFinite(rating)) rating = 0
  rating = Math.max(0, Math.min(5, Math.round(rating)))

  let verified = false
  try {
    if (c.verified === true || c.verified === "true" || c.verified === 1) {
      verified = true
    } else if (c.meta) {
      const meta = c.meta
      if (meta.verified === "1" || meta.verified === 1 || meta.verified === true) verified = true
      else if (meta.verified_owner === "1" || meta.verified_owner === 1 || meta.verified_owner === true) verified = true
      else if (meta.is_verified === "1" || meta.is_verified === 1 || meta.is_verified === true) verified = true
    }
  } catch (e) {
    verified = false
  }

  return { id, parent_id, reviewer, review, date_created, rating, verified, raw: c }
}

function nestReviews(flatList) {
  if (!Array.isArray(flatList)) return []
  const roots = []
  const map = new Map()
  let replyCount = 0

  flatList.forEach(item => {
    item.replies = []
    map.set(item.id, item)
  })

  flatList.forEach(item => {
    if (item.parent_id && item.parent_id !== 0) {
      replyCount++
      const parent = map.get(item.parent_id)
      if (parent) {
        console.log(`[API DEBUG] Nesting reply ID ${item.id} under Parent ID ${item.parent_id}`)
        parent.replies.push(item)
        parent.replies.sort((a, b) => new Date(a.date_created) - new Date(b.date_created))
      } else {
        console.log(`[API DEBUG] Orphan Reply ID ${item.id} (Parent ${item.parent_id} missing from batch)`)
        roots.push(item)
      }
    } else {
      roots.push(item)
    }
  })

  console.log(`[API DEBUG] nestReviews complete. Total items: ${flatList.length}. Identified Replies: ${replyCount}. Roots: ${roots.length}`)
  return roots
}

function sortReviews(list = [], sort) {
  const arr = Array.isArray(list) ? [...list] : []
  if (sort === "rating" || sort === "rating_desc") arr.sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0))
  else if (sort === "rating_asc") arr.sort((a, b) => Number(a.rating || 0) - Number(b.rating || 0))
  else if (sort === "oldest") arr.sort((a, b) => new Date(a.date_created || a.date || 0) - new Date(b.date_created || b.date || 0))
  else arr.sort((a, b) => new Date(b.date_created || b.date || 0) - new Date(a.date_created || a.date || 0))
  return arr
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get("q") || "").trim()
    const sort = (searchParams.get("sort") || "rating").toLowerCase()
    const pageParam = Number.parseInt(searchParams.get("page") || "1", 10) || 1
    const perPage = Math.min(Number.parseInt(searchParams.get("per_page") || String(DEFAULT_PER_PAGE), 10) || DEFAULT_PER_PAGE, MAX_PER_PAGE)
    const productId = searchParams.get("product_id") || null
    const verifiedFilter = (searchParams.get("verified") || "all").toLowerCase()
    const all = searchParams.get("all") === "true"

    const siteUrl = process.env.WC_SITE_URL
    const wcKey = process.env.WC_CONSUMER_KEY
    const wcSecret = process.env.WC_CONSUMER_SECRET

    if (!siteUrl) {
      return new Response(JSON.stringify({ success: false, error: "Missing WC_SITE_URL environment variable" }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    }

    const useWpCommentsApi = !!q || (!!productId && !all)

    if (useWpCommentsApi) {
      try {
        const url = new URL(`${siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/comments`)

        if (q) url.searchParams.set("search", q)
        url.searchParams.set("page", String(pageParam))
        url.searchParams.set("per_page", String(perPage))
        url.searchParams.set("status", "approve")

        if (productId) {
          url.searchParams.set("post", String(productId))
        } else {
          url.searchParams.set("type", "review")
        }

        const headers = { Accept: "application/json", "Content-Type": "application/json" }
        if (wcKey && wcSecret) {
          try { headers.Authorization = `Basic ${base64Encode(`${wcKey}:${wcSecret}`)}` } catch (e) { }
        }

        const { json: comments, headers: resHeaders } = await fetchJsonWithRetries(url.toString(), { method: "GET", headers })

        const total = Number.parseInt(resHeaders.get("X-WP-Total") || resHeaders.get("x-wp-total") || "0", 10)
        const totalPages = Number.parseInt(resHeaders.get("X-WP-TotalPages") || resHeaders.get("x-wp-totalpages") || resHeaders.get("x-wp-total-pages") || "0", 10) || 1

        const mapped = (Array.isArray(comments) ? comments : []).map(normalizeCommentToReview)

        const repliesFound = mapped.filter(r => r.parent_id > 0)
        if (repliesFound.length > 0) {
          console.log(`[API DEBUG] Found ${repliesFound.length} replies in WP Comments fetch. Sample:`, repliesFound[0])
        }

        const nested = nestReviews(mapped)

        let filtered = nested
        if (verifiedFilter === "verified") filtered = filtered.filter((r) => r.verified)
        else if (verifiedFilter === "unverified") filtered = filtered.filter((r) => !r.verified)

        const sorted = sortReviews(filtered, sort)
        const returned = sorted.slice(0, MAX_RETURN)

        return new Response(JSON.stringify({
          success: true,
          data: returned,
          pagination: { currentPage: pageParam, perPage, totalPages, totalReviews: total }
        }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      } catch (err) {
        console.error("WP comments endpoint fetch failed:", err && err.stack ? err.stack : err)
        return new Response(JSON.stringify({ success: false, error: "Fetch failed", details: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      }
    }

    const wcBase = `${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3/products/reviews?status=approved${productId ? `&product=${encodeURIComponent(productId)}` : ""}`
    const headers = { Accept: "application/json", "Content-Type": "application/json" }
    if (wcKey && wcSecret) headers.Authorization = `Basic ${base64Encode(`${wcKey}:${wcSecret}`)}`

    if (!all) {
      try {
        const page = pageParam > 0 ? pageParam : 1
        const url = new URL(wcBase)
        url.searchParams.set("page", String(page))
        url.searchParams.set("per_page", String(perPage))

        const { json: reviewsOnPage, headers: resHeaders } = await fetchJsonWithRetries(url.toString(), { method: "GET", headers })
        const rawReviews = Array.isArray(reviewsOnPage) ? reviewsOnPage : []

        const mappedReviews = rawReviews.map(normalizeCommentToReview)

        const repliesFound = mappedReviews.filter(r => r.parent_id > 0)
        if (repliesFound.length > 0) {
          console.log(`[API DEBUG] Found ${repliesFound.length} replies in WC Reviews fetch.`)
        }

        const nestedReviews = nestReviews(mappedReviews)

        let filtered = nestedReviews
        if (verifiedFilter === "verified") filtered = filtered.filter((r) => !!r.verified)
        else if (verifiedFilter === "unverified") filtered = filtered.filter((r) => !r.verified)

        const sorted = sortReviews(filtered, sort)
        const totalReviews = Number.parseInt(resHeaders.get("x-wp-total") || resHeaders.get("X-WP-Total") || "0", 10)
        const totalPages = Math.max(1, Math.ceil(totalReviews / perPage) || 1)

        const returned = sorted.slice(0, MAX_RETURN)

        return new Response(JSON.stringify({
          success: true,
          data: returned,
          pagination: { currentPage: page, perPage, totalPages, totalReviews }
        }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      } catch (err) {
        console.error("WC single-page fetch failed:", err && err.stack ? err.stack : err)
        return new Response(JSON.stringify({ success: false, error: "Failed to fetch reviews", details: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      }
    }

    try {
      let page = 1
      let totalPages = Infinity
      let totalPagesKnown = false
      let allReviews = []
      let consecutiveEmptyCustomerPages = 0

      while (page <= totalPages && page <= MAX_PAGES_SAFE) {
        console.info(`Fetching WC reviews page ${page} ... collected so far: ${allReviews.length}`)
        const url = new URL(wcBase)
        url.searchParams.set("page", String(page))
        url.searchParams.set("per_page", String(Math.min(perPage, MAX_PER_PAGE)))

        const { json: pageJson, headers: resHeaders } = await fetchJsonWithRetries(url.toString(), { method: "GET", headers })
        if (!Array.isArray(pageJson) || pageJson.length === 0) {
          console.info(`Page ${page} returned zero items — stopping full fetch`)
          break
        }

        const mappedPage = pageJson.map(normalizeCommentToReview)

        if (mappedPage.length === 0) consecutiveEmptyCustomerPages++
        else consecutiveEmptyCustomerPages = 0

        allReviews = allReviews.concat(mappedPage)

        const xTotalPages = resHeaders.get("x-wp-total-pages") || resHeaders.get("X-WP-TotalPages")
        if (xTotalPages) { totalPages = Math.max(1, Number.parseInt(xTotalPages, 10)); totalPagesKnown = true }
        else {
          const link = resHeaders.get("link")
          if (link) {
            const m = link.match(/<([^>]+)>;\s*rel="last"/)
            if (m) {
              try { const lastUrl = new URL(m[1]); const lp = Number.parseInt(lastUrl.searchParams.get("page") || "1", 10); if (!Number.isNaN(lp)) { totalPages = lp; totalPagesKnown = true } } catch { }
            }
          } else {
            if (pageJson.length < perPage) totalPages = page
          }
        }

        if (totalPagesKnown && page >= totalPages) break
        if (!totalPagesKnown && consecutiveEmptyCustomerPages >= MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES) {
          break
        }

        page++
      }

      const nestedAll = nestReviews(allReviews)

      let matched = nestedAll
      if (verifiedFilter === "verified") matched = matched.filter((r) => !!r.verified)
      else if (verifiedFilter === "unverified") matched = matched.filter((r) => !r.verified)

      const sorted = sortReviews(matched, sort)
      const totalMatched = sorted.length
      const returned = sorted.slice(0, MAX_RETURN)

      return new Response(JSON.stringify({ success: true, totalMatched, returned: returned.length, data: returned }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    } catch (err) {
      console.error("WC full-fetch failed:", err && err.stack ? err.stack : err)
      return new Response(JSON.stringify({ success: false, error: "Failed to fetch all reviews", details: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    }
  } catch (err) {
    console.error("Reviews route fatal error:", err && err.stack ? err.stack : err)
    return new Response(JSON.stringify({ success: false, error: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
  }
}
