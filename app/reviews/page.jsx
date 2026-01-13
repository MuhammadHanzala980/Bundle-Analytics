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
  const [replyOpen, setReplyOpen] = useState({})
  const [replyText, setReplyText] = useState({})
  const [actionLoading, setActionLoading] = useState({})
  function stripHtml(input = "") {
    return String(input).replace(/<\/?[^>]+(>|$)/g, "").replace(/&nbsp;/g, " ").trim()
  }
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
      console.log(result)
      if (result.success) {
        const data = result.data.map(r => {
           if (!r.id && r._id) r.id = r._id
          return r
        })
        setReviews(data)
        setTotalPages(result.pagination?.totalPages || 1)
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

  const toggleReplyBox = (id) => {
    setReplyOpen(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleReplyChange = (id, value) => {
    setReplyText(prev => ({ ...prev, [id]: value }))
  }

  const postReply = async (reviewId) => {
    if (!replyText[reviewId] || replyText[reviewId].trim() === "") {
      return
    }
    setActionLoading(prev => ({ ...prev, [reviewId]: true }))
    try {
      const res = await fetch("/api/reviews/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, reply: replyText[reviewId], adminName: "Admin" }),
      })
       const json = await res.json()
       console.log(json)
      if (!res.ok || !json.success) {
        throw new Error(json.message || "Failed to post reply")
      }
      const updated = json.updatedReview
      setReviews(prev =>
        prev.map(r => {
          if (String(r.id) === String(updated.id || updated.ID)) {
            return { ...r, metadata: { ...(r.metadata || {}), replies: updated.meta?.replies || [], mostHelpful: updated.meta?.mostHelpful } }
          }
          return r
        })
      )
      setReplyText(prev => ({ ...prev, [reviewId]: "" }))
      setReplyOpen(prev => ({ ...prev, [reviewId]: false }))
    } catch (err) {
      console.log("Reply error:", err)
    } finally {
      setActionLoading(prev => ({ ...prev, [reviewId]: false }))
    }
  }

  const toggleMostHelpful = async (reviewId, currentValue) => {
    setActionLoading(prev => ({ ...prev, [reviewId]: true }))
    try {
      const res = await fetch("/api/reviews/mark-helpful", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, mark: !currentValue }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || "Failed to update")
      }
      const updated = json.updatedReview
      setReviews(prev =>
        prev.map(r => {
          if (String(r.id) === String(updated.id || updated.ID)) {
            return { ...r, metadata: { ...(r.metadata || {}), replies: updated.meta?.replies || [], mostHelpful: updated.meta?.mostHelpful } }
          }
          return r
        })
      )
    } catch (err) {
      console.error("Most helpful error:", err)
      alert("Failed to update. Try again.")
    } finally {
      setActionLoading(prev => ({ ...prev, [reviewId]: false }))
    }
  }

  const RenderReplies = ({ replies = [], level = 0 }) => {
    if (!replies.length) return null
    return (
      <div className={`space-y-2 ${level ? "pl-4" : ""}`}>
        {replies.map((r, i) => {
          const author = r.admin || r.author_name || "Admin"
          const date = r.date || r.date_gmt
          const content = parseReviewContent(
            r.text ||
            r.content?.rendered ||
            r.content ||
            r.raw?.content?.rendered ||
            ""
          )
          return (
            <div key={r.id || i} className="rounded border border-slate-100 bg-slate-50 p-3">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-slate-800">{author}</span>
                <span className="text-slate-500">{date ? formatDate(date) : ""}</span>
              </div>
              <div className="mt-1 text-sm text-slate-700">{content}</div>
              {r.replies && <RenderReplies replies={r.replies} level={level + 1} />}
            </div>
          )
        })}
      </div>
    )
  }
  const cleanText = (html) => {
    return new DOMParser().parseFromString(html, "text/html").body.textContent || ""
  }


  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-slate-900 sm:text-4xl">Customer Reviews</h1>
          <p className="mt-2 text-slate-600">See what customers think about our products</p>
        </div>
      </header>

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
                <div key={review.id} className="rounded-lg border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md">
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-900">{review.reviewer || review.author_name || review.name || "Customer"}</h3>
                        {review.verified && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                            <span>✓</span>
                            <span>Verified</span>
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-500">{formatDate(review.date_created || review.date || review.date_gmt)}</p>
                    </div>
                    <div className="flex gap-1">{renderStars(review.rating || review.meta?.rating || 0)}</div>
                  </div>
                  <p className="mt-4 text-slate-700">{parseReviewContent(review.review || review.content?.rendered || review.content)}</p>

                  <div className="mt-4 flex flex-col gap-3">
                    {review?.replies.length > 0 && (
                      <div className="space-y-2">
                        {(review?.replies).map((r, idx) => (
                          <div key={idx} className="rounded border border-slate-100 bg-slate-50 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-[14px] font-bold text-slate-800">{r.author_name || "Admin"}</div>
                              <div className="text-xs text-slate-500">{formatDate(r.date)}</div>
                            </div>
                            <div className="mt-2 text-sm text-slate-700">{cleanText(r.content)}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => toggleReplyBox(review.id)}
                          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          Reply
                        </button>

                        <button
                          onClick={() => toggleMostHelpful(review.id, (review.meta?.mostHelpful ?? review.metadata?.mostHelpful) || false)}
                          disabled={actionLoading[review.id]}
                          className={`rounded px-3 py-1 text-sm font-medium ${(review.meta?.mostHelpful ?? review.metadata?.mostHelpful) ? "bg-amber-400 text-slate-900" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                            }`}
                        >
                          {actionLoading[review.id] ? "Updating..." : (review.meta?.mostHelpful ?? review.metadata?.mostHelpful) ? "Most Helpful" : "Mark Most Helpful"}
                        </button>
                      </div>

                      {replyOpen[review.id] && (
                        <div className="mt-3 w-full sm:mt-0 sm:w-2/3">
                          <textarea
                            value={replyText[review.id] || ""}
                            onChange={(e) => handleReplyChange(review.id, e.target.value)}
                            rows={3}
                            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
                          />
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => postReply(review.id)}
                              disabled={actionLoading[review.id]}
                              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
                            >
                              {actionLoading[review.id] ? "Posting..." : "Post Reply"}
                            </button>
                            <button
                              onClick={() => setReplyOpen(prev => ({ ...prev, [review.id]: false }))}
                              className="rounded border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="mt-8 flex items-center justify-between border-t border-slate-200 pt-6">
                <button
                  onClick={handlePreviousPage}
                  disabled={currentPage === 1}
                  className={`rounded px-4 py-2 font-medium ${currentPage === 1
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
                  className={`rounded px-4 py-2 font-medium ${currentPage === totalPages
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
