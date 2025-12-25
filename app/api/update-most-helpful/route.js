import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const MOST_HELPFUL_PATH = path.join(process.cwd(), 'public', 'reviews', 'most-helpful.json')

export async function POST(request) {
  try {
    // Read the current most-helpful.json
    const fileContent = fs.readFileSync(MOST_HELPFUL_PATH, 'utf8')
    const reviews = JSON.parse(fileContent)

    // Fetch all reviews from the existing API
    const allReviewsUrl = new URL(`${request.nextUrl.origin}/api/reviews-em?all=true`)
    const allResponse = await fetch(allReviewsUrl.toString())
    if (!allResponse.ok) {
      throw new Error(`Failed to fetch all reviews: ${allResponse.statusText}`)
    }
    const allData = await allResponse.json()
    if (!allData.success || !allData.data) {
      throw new Error('Failed to get reviews data')
    }
    const allReviews = allData.data

    // For each review in most-helpful.json, find the matching full review
    const updatedReviews = []
    for (const item of reviews) {
      const reviewText = item.review
      if (!reviewText) {
        updatedReviews.push(item)
        continue
      }

      // Find the matching review in allReviews
      const matchingReview = allReviews.find(r => r.review === reviewText)
      if (matchingReview) {
        // Merge with original
        updatedReviews.push({ ...matchingReview, original_review: reviewText })
      } else {
        // If no match, keep original
        updatedReviews.push(item)
      }
    }

    // Write back to the file
    fs.writeFileSync(MOST_HELPFUL_PATH, JSON.stringify(updatedReviews, null, 2))

    return new Response(JSON.stringify({ success: true, message: 'Most helpful reviews updated with complete data' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('Error updating most helpful reviews:', err)
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}