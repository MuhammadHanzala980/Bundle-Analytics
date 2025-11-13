// app/api/reviews/download/route.js
const DEFAULT_PER_PAGE = 100
const MAX_RETRIES = 3
const REQUEST_TIMEOUT_MS = 15_000
const MAX_PAGES_SAFE = 5000
const MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES = 3 // configurable threshold

function base64Encode(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str).toString("base64")
  if (typeof btoa !== "undefined") return btoa(str)
  throw new Error("No base64 encoder available")
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
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

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {}
  return linkHeader.split(",").reduce((acc, part) => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/)
    if (match) acc[match[2]] = match[1]
    return acc
  }, {})
}

async function fetchPage(apiUrl, headers, page, retries = MAX_RETRIES) {
  const url = new URL(apiUrl)
  url.searchParams.set("page", String(page))

  let attempt = 0
  while (true) {
    attempt++
    try {
      const res = await fetchWithTimeout(url.toString(), { method: "GET", headers }, REQUEST_TIMEOUT_MS)
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status} ${res.statusText} - ${body}`)
      }
      const json = await res.json().catch(async (err) => {
        const txt = await res.text().catch(() => "")
        throw new Error(`Failed to parse JSON: ${err.message} - body: ${txt}`)
      })
      return { json, headers: res.headers }
    } catch (err) {
      if (attempt >= retries) throw err
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 200
      console.warn(`Fetch failed for page ${page} (attempt ${attempt}). Retrying after ${Math.round(backoff)}ms. Error: ${err.message}`)
      await sleep(backoff)
    }
  }
}

function parseHtmlContent(html) {
  if (!html) return ""
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
}

function generateDocContent(reviews) {
  const list = Array.isArray(reviews) ? reviews : []
  let content = ""
  content += `CUSTOMER REVIEWS REPORT\r\n`
  content += `Generated: ${new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}\r\n`
  content += `Total Reviews: ${list.length}\r\n`
  content += `${"=".repeat(80)}\r\n\r\n`

  list.forEach((review, idx) => {
    const reviewer = review.reviewer || review.name || "Anonymous"
    const rating = Number.isFinite(Number(review.rating)) ? Number(review.rating) : 0
    const created = new Date(review.date_created || review.date || Date.now())
    const dateStr = isNaN(created.getTime())
      ? "Unknown"
      : created.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    const verified = !!review.verified
    const reviewText = parseHtmlContent(review.review || review.content || "")

    content += `${idx + 1}. ${reviewer}\r\n`
    content += `   Rating: ${"★".repeat(Math.max(0, Math.min(5, rating)))}${"☆".repeat(5 - Math.max(0, Math.min(5, rating)))} (${rating}/5)\r\n`
    content += `   Date: ${dateStr}\r\n`
    content += `   Verified: ${verified ? "Yes" : "No"}\r\n`
    content += `   Review: ${reviewText}\r\n`
    content += `${"-".repeat(80)}\r\n\r\n`
  })

  return content
}

export async function GET() {
  try {
    const siteUrl = process.env.WC_SITE_URL
    const consumerKey = process.env.WC_CONSUMER_KEY
    const consumerSecret = process.env.WC_CONSUMER_SECRET

    if (!siteUrl || !consumerKey || !consumerSecret) {
      return new Response(JSON.stringify({ error: "Missing WooCommerce credentials (WC_SITE_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET)" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    const auth = base64Encode(`${consumerKey}:${consumerSecret}`)
    const headers = {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    }

    const baseApi = `${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3/products/reviews`
    let perPage = Math.min(DEFAULT_PER_PAGE, 100)

    let page = 1
    let totalPages = Infinity
    let totalPagesKnown = false
    let allReviews = []
    let pagesFetched = 0
    let consecutiveEmptyCustomerPages = 0

    console.info(`Starting reviews fetch from ${siteUrl} (per_page=${perPage})`)

    while (page <= totalPages && page <= MAX_PAGES_SAFE) {
      pagesFetched++
      console.info(`Fetching page ${page} ... (pages fetched so far: ${pagesFetched})`)

      const apiUrl = `${baseApi}?page=${page}&per_page=${perPage}&status=approved`
      const { json: reviewsOnPage, headers: resHeaders } = await fetchPage(apiUrl, headers, page)

      // If API returns an empty array for this page, assume we've reached the end
      if (!Array.isArray(reviewsOnPage) || reviewsOnPage.length === 0) {
        console.info(`Page ${page} returned no items (reviewsOnPage.length === 0). Assuming end of dataset.`)
        break
      }

      // Filter out admin replies / threaded replies
      const customerReviews = reviewsOnPage.filter((r) => !r.parent_id || Number(r.parent_id) === 0)
      allReviews = allReviews.concat(customerReviews)

      // Check for x-wp-total-pages header
      const xTotalPages = resHeaders.get("x-wp-total-pages")
      if (xTotalPages) {
        totalPages = Math.max(1, Number.parseInt(xTotalPages, 10))
        totalPagesKnown = true
      } else {
        // try Link header fallback
        const link = resHeaders.get("link")
        if (link) {
          const parsed = parseLinkHeader(link)
          if (parsed.last) {
            try {
              const lastUrl = new URL(parsed.last)
              const lp = Number.parseInt(lastUrl.searchParams.get("page") || "1", 10)
              if (!Number.isNaN(lp)) {
                totalPages = lp
                totalPagesKnown = true
              }
            } catch (_) {}
          }
        }
      }

      // consecutive empty customer-pages heuristic (only applies if totalPages unknown)
      if (customerReviews.length === 0) {
        consecutiveEmptyCustomerPages++
      } else {
        consecutiveEmptyCustomerPages = 0
      }

      console.info(
        `Fetched page ${page}. reviewsOnPage: ${Array.isArray(reviewsOnPage) ? reviewsOnPage.length : 0}. Customer reviews on this page: ${customerReviews.length}. Consecutive empty-customer-pages: ${consecutiveEmptyCustomerPages}. Total collected: ${allReviews.length}. totalPages known: ${totalPagesKnown ? totalPages : "unknown"}`
      )

      // If totalPages known, stop when reached
      if (totalPagesKnown && page >= totalPages) break

      // If totalPages unknown and we have seen N consecutive pages with zero customer reviews, stop
      if (!totalPagesKnown && consecutiveEmptyCustomerPages >= MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES) {
        console.info(
          `No customer reviews found on ${consecutiveEmptyCustomerPages} consecutive pages and totalPages header is missing. Assuming no further customer reviews; stopping fetch.`
        )
        break
      }

      page++
    }

    if (page > MAX_PAGES_SAFE) {
      console.warn(`Reached MAX_PAGES_SAFE (${MAX_PAGES_SAFE}). Stopping to avoid runaway loop.`)
    }

    console.info(`Finished fetching reviews. Total customer reviews fetched: ${allReviews.length}`)

    const docContent = generateDocContent(allReviews)

    return new Response(docContent, {
      status: 200,
      headers: {
        "Content-Type": "application/msword",
        "Content-Disposition": `attachment; filename="reviews-${new Date().toISOString().split("T")[0]}.doc"`,
      },
    })
  } catch (err) {
    console.error("Download Reviews Fatal Error:", err && err.stack ? err.stack : err)
    return new Response(JSON.stringify({ error: "Failed to download reviews", details: String(err?.message || err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
