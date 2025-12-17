export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url)
    const page = Number.parseInt(searchParams.get("page") || "1", 10)
    const sort = searchParams.get("sort") || "latest"
    const verified = searchParams.get("verified") || "all"
    const perPage = 100

    const siteUrl = process.env.WC_SITE_URL
    const consumerKey = process.env.WC_CONSUMER_KEY
    const consumerSecret = process.env.WC_CONSUMER_SECRET

    if (!siteUrl || !consumerKey || !consumerSecret) {
      return Response.json({ error: "WooCommerce credentials are missing" }, { status: 500 })
    }

    // Construct WooCommerce API URL with pagination
    const apiUrl = `${siteUrl}/wp-json/wc/v3/products/reviews?page=${page}&per_page=${perPage}&status=approved`

    // Create Basic Auth header for WooCommerce
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    })

    if (!response.ok) {
      throw new Error(`WooCommerce API error: ${response.status}`)
    }

    const reviews = await response.json()
    console.log(JSON.stringify(reviews[1], null, 1))
    // Get total count from headers for pagination
    const totalReviews = Number.parseInt(response.headers.get("x-wp-total") || "0", 10)
    const totalPages = Math.ceil(totalReviews / perPage)
    let repliesC
    let customerReviews = reviews.filter((review) => {
      // keep existing behavior: top-level reviews only
      return !review.parent_id || review.parent_id === 0
    })

    if (verified === "verified") {
      customerReviews = customerReviews.filter((review) => review.verified === true)
    } else if (verified === "unverified") {
      customerReviews = customerReviews.filter((review) => review.verified === false)
    }

    if (sort === "highest") {
      customerReviews.sort((a, b) => b.rating - a.rating)
    } else if (sort === "lowest") {
      customerReviews.sort((a, b) => a.rating - b.rating)
    } else if (sort === "latest") {
      customerReviews.sort((a, b) => new Date(b.date_created) - new Date(a.date_created))
    } else if (sort === "oldest") {
      customerReviews.sort((a, b) => new Date(a.date_created) - new Date(b.date_created))
    }

    // ---------- GROUPING FEATURE START ----------
    // Prepare a map of top-level reviews (preserve original review objects)
    const reviewMap = new Map()
    customerReviews.forEach((r) => {
      // ensure a replies array is present
      r.replies = r.replies || []
      reviewMap.set(Number(r.id || r.review_id || r.comment_id), r)
    })

    // 1) Attach any replies that already exist in the WooCommerce `reviews` payload
    // (those with parent_id != 0). This prevents duplicates and keeps replies from same source.
    for (const r of reviews) {
      const parentId = Number(r.parent_id || 0)
      const id = Number(r.id || r.review_id || r.comment_id)
      if (parentId && reviewMap.has(parentId)) {
        const parent = reviewMap.get(parentId)
        // avoid duplicate replies by id
        if (!parent.replies.some((x) => Number(x.id || x.review_id || x.comment_id) === id)) {
          parent.replies.push(r)
        }
      }
    }

    // 2) Try to fetch WordPress comments (which often include admin replies) and attach them.
    // If WP comments fetch fails, continue silently and return grouped reviews we already have.
    try {
      // Use the provided WP comments endpoint (page/per_page from same query)
      // NOTE: update these if you prefer env vars. Using provided credentials inline per user's instruction.
      const wpCommentsUrl = `${siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/comments?per_page=${perPage}`
      const wpUsername = "hanzala"
      const wpPassword = "HetJ QF8J Q6Xe UL1N 1c1w VVgf"
      const wpAuth = Buffer.from(`${wpUsername}:${wpPassword}`).toString("base64")

      const wpResp = await fetch(wpCommentsUrl, {
        method: "GET",
        headers: {
          Authorization: `Basic ${wpAuth}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      })

      if (wpResp.ok) {
        const wpComments = await wpResp.json()
        repliesC = wpComments
        // Attach WP comment replies to matching top-level reviews by parent id.
        for (const c of wpComments) {
          const parent = Number(c.parent || 0)
          const cid = Number(c.id)
          if (parent && reviewMap.has(parent)) {
            const parentReview = reviewMap.get(parent)
            // avoid duplicate replies (check by id)
            if (!parentReview.replies.some((x) => Number(x.id || x.comment_id || x.review_id) === cid)) {
              // normalize minimal fields but keep the original object as well
              const replyObj = {
                id: c.id,
                parent: c.parent,
                author_name: c.author_name || (c.author ? c.author : undefined),
                content: c.content ? (c.content.rendered || c.content) : undefined,
                date: c.date,
                raw: c, // keep original for any extra fields
              }
              parentReview.replies.push(replyObj)
            }
          }
        }
      } else {
        // If WP comments call fails, log but don't break the main response
        console.warn("WP comments fetch failed:", wpResp.status)
      }
    } catch (wpErr) {
      console.warn("WP comments fetch error:", wpErr)
    }
    // ---------- GROUPING FEATURE END ----------

    return Response.json(
      {
        success: true,
        data: customerReviews,
        replies: repliesC,
        pagination: {
          currentPage: page,
          totalPages: totalPages,
          perPage: perPage,
          totalReviews: totalReviews,
        },
      },
      { status: 200 },
    )
  } catch (error) {
    console.error("Reviews API Error:", error)
    return Response.json({ error: "Failed to fetch reviews", details: error.message }, { status: 500 })
  }
}
