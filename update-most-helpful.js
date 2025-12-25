const fs = require('fs')
const path = require('path')

// Load .env.local
const envPath = path.join(__dirname, '.env.local')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8')
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=')
    if (key && valueParts.length) {
      process.env[key.trim()] = valueParts.join('=').trim()
    }
  })
}

const MOST_HELPFUL_PATH = path.join(__dirname, 'public', 'reviews', 'most-helpful.json')

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

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').trim()
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
        parent.replies.push(item)
        parent.replies.sort((a, b) => new Date(a.date_created) - new Date(b.date_created))
      } else {
        roots.push(item)
      }
    } else {
      roots.push(item)
    }
  })

  return roots
}

async function fetchAllReviews() {
  const siteUrl = process.env.WC_SITE_URL
  const wcKey = process.env.WC_CONSUMER_KEY
  const wcSecret = process.env.WC_CONSUMER_SECRET

  if (!siteUrl) {
    throw new Error("Missing WC_SITE_URL")
  }

  const wcBase = `${siteUrl.replace(/\/$/, "")}/wp-json/wc/v3/products/reviews?status=approved`
  const headers = { Accept: "application/json", "Content-Type": "application/json" }
  if (wcKey && wcSecret) headers.Authorization = `Basic ${base64Encode(`${wcKey}:${wcSecret}`)}`

  let page = 1
  let totalPages = Infinity
  let totalPagesKnown = false
  let allReviews = []
  let consecutiveEmptyCustomerPages = 0

  while (page <= totalPages && page <= MAX_PAGES_SAFE) {
    console.info(`Fetching WC reviews page ${page} ... collected so far: ${allReviews.length}`)
    const url = new URL(wcBase)
    url.searchParams.set("page", String(page))
    url.searchParams.set("per_page", String(Math.min(100, MAX_PER_PAGE)))

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
        if (pageJson.length < 100) totalPages = page
      }
    }

    if (totalPagesKnown && page >= totalPages) break
    if (!totalPagesKnown && consecutiveEmptyCustomerPages >= MAX_CONSECUTIVE_EMPTY_CUSTOMER_PAGES) {
      break
    }

    page++
  }

  const nestedAll = nestReviews(allReviews)
  return nestedAll.slice(0, MAX_RETURN)
}

async function main() {
  try {
    console.log('Fetching all reviews...')
    const allReviews = await fetchAllReviews()
    console.log(`Fetched ${allReviews.length} reviews`)

    console.log('Reading most-helpful.json...')
    const fileContent = fs.readFileSync(MOST_HELPFUL_PATH, 'utf8')
    const reviews = JSON.parse(fileContent)

    console.log('Updating reviews...')
    const updatedReviews = []
    for (const item of reviews) {
      const reviewText = item.review
      if (!reviewText) {
        updatedReviews.push(item)
        continue
      }

      // Find the matching review
      const matchingReview = allReviews.find(r => stripHtml(r.review) === reviewText)
      if (matchingReview) {
        updatedReviews.push({ ...matchingReview, original_review: reviewText })
      } else {
        updatedReviews.push(item)
      }
    }

    console.log('Writing back to file...')
    fs.writeFileSync(MOST_HELPFUL_PATH, JSON.stringify(updatedReviews, null, 2))

    console.log('Done!')
  } catch (err) {
    console.error('Error:', err)
  }
}

main()