"use client"

import { useState, useEffect } from "react"

export default function ReviewsPage() {
  const [reviews, setReviews] = useState([])
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sort, setSort] = useState("latest")
  const [verified, setVerified] = useState("all")
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    fetchReviews(currentPage, sort, verified)
  }, [currentPage, sort, verified])

  const fetchReviews = async (page, sortBy, verifiedFilter) => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/reviews?page=${page}&sort=${sortBy}&verified=${verifiedFilter}`)

      if (!response.ok) {
        throw new Error("Failed to fetch reviews")
      }

      const result = await response.json()

      if (result.success) {
        setReviews(result.data)
        setTotalPages(result.pagination.totalPages)
        window.scrollTo({ top: 0, behavior: "smooth" })
      } else {
        setError("No reviews available")
      }
    } catch (err) {
      console.error("Error fetching reviews:", err)
      setError("Error loading reviews. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1)
    }
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1)
    }
  }

  const handleDownloadAllReviews = async () => {
    setDownloading(true)
    try {
      const response = await fetch("/api/reviews/download")
      if (!response.ok) {
        throw new Error("Failed to download reviews")
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `reviews-${new Date().toISOString().split("T")[0]}.doc`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (err) {
      console.error("Error downloading reviews:", err)
      alert("Failed to download reviews. Please try again.")
    } finally {
      setDownloading(false)
    }
  }

  const parseReviewContent = (html) => {
    const div = document.createElement("div")
    div.innerHTML = html
    return div.textContent || div.innerText || ""
  }

  const renderStars = (rating) => {
    return Array.from({ length: 5 }).map((_, i) => (
      <span key={i} className={`text-lg ${i < rating ? "text-amber-400" : "text-gray-300"}`}>
        ★
      </span>
    ))
  }

  const formatDate = (dateString) => {
    const options = {
      year: "numeric",
      month: "long",
      day: "numeric",
    }
    return new Date(dateString).toLocaleDateString("en-US", options)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Header Section */}
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-slate-900 sm:text-4xl">Customer Reviews</h1>
          <p className="mt-2 text-slate-600">See what customers think about our products</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {!loading && !error && reviews.length > 0 && (
          <div className="mb-6 flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">Sort By</label>
                <select
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value)
                    setCurrentPage(1)
                  }}
                  className="mt-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                >
                  <option value="latest">Latest</option>
                  <option value="oldest">Oldest</option>
                  <option value="highest">Highest Rating</option>
                  <option value="lowest">Lowest Rating</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Verification</label>
                <select
                  value={verified}
                  onChange={(e) => {
                    setVerified(e.target.value)
                    setCurrentPage(1)
                  }}
                  className="mt-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                >
                  <option value="all">All Reviews</option>
                  <option value="verified">Verified Only</option>
                  <option value="unverified">Unverified Only</option>
                </select>
              </div>
            </div>

            <button
              onClick={handleDownloadAllReviews}
              disabled={downloading}
              className="rounded bg-green-600 px-4 py-2 font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-400"
            >
              {downloading ? "Downloading..." : "Download All Reviews"}
            </button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-blue-600"></div>
            <p className="mt-4 text-slate-600">Loading reviews...</p>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-red-800">{error}</p>
          </div>
        )}

        {!loading && !error && reviews.length === 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-12 text-center">
            <p className="text-slate-600">No reviews available</p>
          </div>
        )}

        {!loading && !error && reviews.length > 0 && (
          <>
            <div className="space-y-4">
              {reviews.map((review) => (
                <div
                  key={review.id}
                  className="rounded-lg border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md"
                >
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-900">{review.reviewer}</h3>
                        {review.verified && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                            <span>✓</span>
                            <span>Verified</span>
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-500">{formatDate(review.date_created)}</p>
                    </div>
                    <div className="flex gap-1">{renderStars(review.rating)}</div>
                  </div>
                  <p className="mt-4 text-slate-700">{parseReviewContent(review.review)}</p>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-6">
                <button
                  onClick={handlePreviousPage}
                  disabled={currentPage === 1}
                  className={`rounded px-4 py-2 font-medium ${
                    currentPage === 1
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  ← Previous
                </button>
                <span className="text-sm text-slate-600">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={handleNextPage}
                  disabled={currentPage === totalPages}
                  className={`rounded px-4 py-2 font-medium ${
                    currentPage === totalPages
                      ? "cursor-not-allowed bg-slate-100 text-slate-400"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
