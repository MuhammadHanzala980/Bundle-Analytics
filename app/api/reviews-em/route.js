// app/api/reviews/route.js
// Next.js app route - Server-side fast search using WP Comments endpoint (no Redis).
// - If `q` is present -> use WP REST Comments search: /wp-json/wp/v2/comments?search=...&post=<productId>&page=&per_page=
// - If `q` is absent and `all=true` -> falls back to paginated full fetch from WooCommerce reviews (safe, but expensive)
// - If `q` is absent and not `all` -> fetch a single page using WooCommerce reviews endpoint (fast paginated)
// - Supports query params: q, page, per_page, sort, product_id, verified (all|verified|unverified), all=true
// - Returns JSON: { success:true, data: [...], pagination: { currentPage, perPage, totalPages, totalReviews } }

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
  // c is WP comment object returned by /wp/v2/comments
  // normalize to shape used by widget: { id, reviewer, review, date_created, rating, verified, raw }
  const id = c.id ?? null
  const reviewer = c.author_name || c.author || (c.name ? c.name : "Anonymous")
  // comment content: WP may return content.rendered
  const review = (c.content && c.content.rendered) ? c.content.rendered : (c.content || "")
  const date_created = c.date || c.date_gmt || null

  // rating can be stored in comment meta or in other fields depending on site
  let rating = 0
  try {
    if (c.meta && (c.meta.rating !== undefined)) {
      rating = Array.isArray(c.meta.rating) ? Number(c.meta.rating[0] ?? 0) : Number(c.meta.rating ?? 0)
    } else if (c.meta && c.meta._rating !== undefined) {
      rating = Number(c.meta._rating ?? 0)
    } else if (c.rating !== undefined) {
      rating = Number(c.rating ?? 0)
    } else if (c.author_meta && c.author_meta.rating !== undefined) {
      rating = Number(c.author_meta.rating ?? 0)
    }
  } catch (e) {
    rating = 0
  }
  if (!Number.isFinite(rating)) rating = 0
  rating = Math.max(0, Math.min(5, Math.round(rating)))

  // verified may be stored in meta keys like 'verified' or 'verified_owner' or 'is_verified'
  let verified = false
  try {
    if (c.meta) {
      const meta = c.meta
      if (meta.verified === "1" || meta.verified === 1 || meta.verified === true) verified = true
      else if (meta.verified_owner === "1" || meta.verified_owner === 1 || meta.verified_owner === true) verified = true
      else if (meta.is_verified === "1" || meta.is_verified === 1 || meta.is_verified === true) verified = true
    }
  } catch (e) {
    verified = false
  }

  return { id, reviewer, review, date_created, rating, verified, raw: c }
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
    const verifiedFilter = (searchParams.get("verified") || "all").toLowerCase() // all|verified|unverified
    const all = searchParams.get("all") === "true"

    const siteUrl = process.env.WC_SITE_URL
    const wcKey = process.env.WC_CONSUMER_KEY
    const wcSecret = process.env.WC_CONSUMER_SECRET

    if (!siteUrl) {
      return new Response(JSON.stringify({ success: false, error: "Missing WC_SITE_URL environment variable" }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    }

    // If query present -> use WP Comments search endpoint (fast)
    if (q) {
      // Use WP Comments REST endpoint which is optimized to search DB (no fetching all pages)
      // public endpoint: /wp-json/wp/v2/comments?search=...&post=<productId>&page=&per_page=
      try {
        const url = new URL(`${siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/comments`)
        url.searchParams.set("search", q)
        url.searchParams.set("page", String(pageParam))
        url.searchParams.set("per_page", String(perPage))
        url.searchParams.set("status", "approve")
        url.searchParams.set("type", "review") // WooCommerce comments are type "review"
        if (productId) url.searchParams.set("post", String(productId))

        // No auth required for public approved comments usually; but allow Basic auth fallback if needed
        const headers = { Accept: "application/json", "Content-Type": "application/json" }
        // If user has WC keys and WP requires authentication for comments endpoint, attempt Basic auth
        if (wcKey && wcSecret) {
          try { headers.Authorization = `Basic ${base64Encode(`${wcKey}:${wcSecret}`)}` } catch (e) {}
        }

        const { json: comments, headers: resHeaders } = await fetchJsonWithRetries(url.toString(), { method: "GET", headers })

        const total = Number.parseInt(resHeaders.get("X-WP-Total") || resHeaders.get("x-wp-total") || "0", 10)
        const totalPages = Number.parseInt(resHeaders.get("X-WP-TotalPages") || resHeaders.get("x-wp-totalpages") || resHeaders.get("x-wp-total-pages") || "0", 10) || 1

        const mapped = (Array.isArray(comments) ? comments : []).map(normalizeCommentToReview)

        // verified filter (on page results)
        let filtered = mapped
        if (verifiedFilter === "verified") filtered = filtered.filter((r) => r.verified)
        else if (verifiedFilter === "unverified") filtered = filtered.filter((r) => !r.verified)

        const sorted = sortReviews(filtered, sort)
        // cap returned items just in case
        const returned = sorted.slice(0, MAX_RETURN)

        return new Response(JSON.stringify({
          success: true,
          data: returned,
          pagination: { currentPage: pageParam, perPage, totalPages, totalReviews: total }
        }), { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      } catch (err) {
        console.error("Search via WP comments endpoint failed:", err && err.stack ? err.stack : err)
        return new Response(JSON.stringify({ success: false, error: "Search failed", details: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
      }
    }

    // If q absent:
    // - if not all and not product-specific search, fetch single page from WooCommerce reviews endpoint (fast)
    // - if all=true -> full fetch across pages (keeps previous robust implementation)
    // Build WC reviews endpoint base
    const wcBase = `${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3/products/reviews?status=approved${productId ? `&product=${encodeURIComponent(productId)}` : ""}`
    const headers = { Accept: "application/json", "Content-Type": "application/json" }
    if (wcKey && wcSecret) headers.Authorization = `Basic ${base64Encode(`${wcKey}:${wcSecret}`)}`

    // If caller requested a single page (normal widget pagination)
    if (!all) {
      try {
        const page = pageParam > 0 ? pageParam : 1
        const url = new URL(wcBase)
        url.searchParams.set("page", String(page))
        url.searchParams.set("per_page", String(perPage))

        const { json: reviewsOnPage, headers: resHeaders } = await fetchJsonWithRetries(url.toString(), { method: "GET", headers })
        const customerReviews = (Array.isArray(reviewsOnPage) ? reviewsOnPage : []).filter((r) => !r.parent_id || Number(r.parent_id) === 0)

        // verified filter
        let filtered = customerReviews
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

    // all=true branch: full fetch across pages (kept for admin exports). This can be slow for very large datasets.
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

        const customerReviews = pageJson.filter((r) => !r.parent_id || Number(r.parent_id) === 0)
        if (customerReviews.length === 0) consecutiveEmptyCustomerPages++
        else consecutiveEmptyCustomerPages = 0

        allReviews = allReviews.concat(customerReviews)

        const xTotalPages = resHeaders.get("x-wp-total-pages") || resHeaders.get("X-WP-TotalPages")
        if (xTotalPages) { totalPages = Math.max(1, Number.parseInt(xTotalPages, 10)); totalPagesKnown = true }
        else {
          const link = resHeaders.get("link")
          if (link) {
            const m = link.match(/<([^>]+)>;\s*rel="last"/)
            if (m) {
              try { const lastUrl = new URL(m[1]); const lp = Number.parseInt(lastUrl.searchParams.get("page") || "1", 10); if (!Number.isNaN(lp)) { totalPages = lp; totalPagesKnown = true } } catch {}
            }
          } else {
            if (pageJson.length < perPage) totalPages = page
          }
        }

        console.info(`Fetched page ${page}. pageItems=${pageJson.length}. customerReviews=${customerReviews.length}. consecutiveEmpty=${consecutiveEmptyCustomerPages}. totalCollected=${allReviews.length}. totalPagesKnown=${totalPagesKnown ? totalPages : "unknown"}`)

        if (totalPagesKnown && page >= totalPages) break
        if (!totalPagesKnown && consecutiveEmptyCustomerPages >= MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES) {
          console.info(`Stopping: ${consecutiveEmptyCustomerPages} consecutive empty-customer pages and total unknown.`)
          break
        }

        page++
      }

      console.info(`Full fetch finished. Collected ${allReviews.length} customer reviews.`)

      // apply verified filter/sort and cap
      let matched = allReviews
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
