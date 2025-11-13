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

    // Create Basic Auth header
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

    // Get total count from headers for pagination
    const totalReviews = Number.parseInt(response.headers.get("x-wp-total") || "0", 10)
    const totalPages = Math.ceil(totalReviews / perPage)

    let customerReviews = reviews.filter((review) => {
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

    return Response.json(
      {
        success: true,
        data: customerReviews,
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
