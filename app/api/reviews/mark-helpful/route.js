import { NextResponse } from "next/server"

function buildWcUrl(siteUrl, path, consumerKey, consumerSecret) {
  const base = siteUrl.replace(/\/$/, "")
  const sep = path.startsWith("/") ? "" : "/"
  return `${base}${sep}${path}?consumer_key=${encodeURIComponent(consumerKey)}&consumer_secret=${encodeURIComponent(consumerSecret)}`
}

export async function POST(request) {
  try {
    const body = await request.json()
    const { reviewId, mark } = body
    if (!reviewId || typeof mark === "undefined") {
      return NextResponse.json({ success: false, message: "Missing reviewId or mark" }, { status: 400 })
    }
    const booleanMark = mark === true || mark === "true" || mark === 1 || mark === "1"

    const siteUrl = process.env.WC_SITE_URL
    const consumerKey = process.env.WC_CONSUMER_KEY
    const consumerSecret = process.env.WC_CONSUMER_SECRET
    if (!siteUrl || !consumerKey || !consumerSecret) {
      return NextResponse.json({ success: false, message: "WooCommerce credentials missing" }, { status: 500 })
    }

    const reviewPath = `/wp-json/wc/v3/products/reviews/${encodeURIComponent(reviewId)}`
    const reviewUrl = buildWcUrl(siteUrl, reviewPath, consumerKey, consumerSecret)

    const getRes = await fetch(reviewUrl, { method: "GET", headers: { "Content-Type": "application/json" } })
    if (!getRes.ok) {
      const txt = await getRes.text()
      return NextResponse.json({ success: false, message: "Failed to fetch review", details: txt }, { status: getRes.status })
    }
    const review = await getRes.json()

    const metaData = Array.isArray(review.meta_data) ? review.meta_data.slice() : []
    const mostHelpfulIndex = metaData.findIndex(m => m.key === "mostHelpful")

    const mostHelpfulValue = booleanMark ? "1" : "0"
    if (mostHelpfulIndex >= 0) {
      metaData[mostHelpfulIndex].value = mostHelpfulValue
    } else {
      metaData.push({ key: "mostHelpful", value: mostHelpfulValue })
    }

    const updateRes = await fetch(reviewUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta_data: metaData }),
    })
    if (!updateRes.ok) {
      const txt = await updateRes.text()
      return NextResponse.json({ success: false, message: "Failed to update review meta", details: txt }, { status: updateRes.status })
    }
    const updated = await updateRes.json()
    return NextResponse.json({ success: true, updatedReview: updated }, { status: 200 })
  } catch (err) {
    return NextResponse.json({ success: false, message: "Server error", details: err?.message || String(err) }, { status: 500 })
  }
}
