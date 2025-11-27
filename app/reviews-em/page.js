"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

export default function ReviewsWidget({ productId = null }) {
  const INITIAL_PAGE_SIZE = 50
  const MAX_STORE = 5000

  const PRODUCTS = [
    "Magic Mushroom Gummies",
    "ILLUMINATE Capsules",
    "FOCUS Capsules",
    "Microdosing Starter Pack – Capsules",
    "CREATE Capsules",
    "CALM Capsules",
    "ELEVATE Capsules",
    "The Ultimate Guide to Microdosing",
    "1 Hour Microdosing Coaching Call",
    "30 Minute Microdosing Coaching Call",
    "30 Day Experience Program",
  ]

  const [allReviews, setAllReviews] = useState([])
  const [loadedPages, setLoadedPages] = useState(0)
  const [totalPages, setTotalPages] = useState(null)
  const [totalReviewsCount, setTotalReviewsCount] = useState(null)
  const [isFetchingAll, setIsFetchingAll] = useState(false)
  const [fetchError, setFetchError] = useState(null)

  // product dropdown
  const [selectedProductName, setSelectedProductName] = useState("")

  // UI state
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [activeQuery, setActiveQuery] = useState("") // run-on-click or suggestion
  const [suggestionsVisible, setSuggestionsVisible] = useState(false)
  const [currentPageView, setCurrentPageView] = useState(1)
  const [perPageView, setPerPageView] = useState(10)

  // debounce typing for suggestions preview only
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 220)
    return () => clearTimeout(t)
  }, [query])

  // fetch helpers
  const fetchPageFromServer = useCallback(
    async (page, perPage) => {
      const params = new URLSearchParams()
      params.set("page", String(page))
      params.set("per_page", String(perPage))
      if (productId) params.set("product_id", String(productId))
      const url = `/api/reviews?${params.toString()}`
      const res = await fetch(url, { cache: "no-store" })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Fetch failed ${res.status} ${res.statusText} ${text}`)
      }
      return await res.json()
    },
    [productId],
  )

  // startup: first page then background fetch
  useEffect(() => {
    let cancelled = false
    async function startup() {
      try {
        setFetchError(null)
        setIsFetchingAll(true)

        const first = await fetchPageFromServer(1, INITIAL_PAGE_SIZE)
        if (cancelled) return
        if (!first || !first.success) throw new Error(first?.error || "Invalid server response")

        const firstData = Array.isArray(first.data) ? first.data : []
        setAllReviews((prev) => dedupeAppend(prev, firstData))
        setLoadedPages(1)
        if (first.pagination) {
          setTotalPages(first.pagination.totalPages)
          setTotalReviewsCount(first.pagination.totalReviews)
        } else if (first.totalMatched) {
          setTotalPages(Math.ceil((first.totalMatched || first.data.length) / INITIAL_PAGE_SIZE))
          setTotalReviewsCount(first.totalMatched || first.data.length)
        } else setTotalPages(null)

        // background fetch pages sequentially
        let page = 2
        const knownTotal = first.pagination?.totalPages ?? null
        while (!cancelled) {
          if (knownTotal && page > knownTotal) break
          if (allReviews.length >= MAX_STORE) break
          try {
            const body = await fetchPageFromServer(page, INITIAL_PAGE_SIZE)
            if (cancelled) break
            if (!body || !body.success) break
            const pageItems = Array.isArray(body.data) ? body.data : []
            if (pageItems.length === 0) break
            setAllReviews((prev) => {
              const appended = dedupeAppend(prev, pageItems)
              return appended.length > MAX_STORE ? appended.slice(0, MAX_STORE) : appended
            })
            setLoadedPages((p) => p + 1)
            if (body.pagination) {
              setTotalPages(body.pagination.totalPages)
              setTotalReviewsCount(body.pagination.totalReviews)
            }
            page++
          } catch (err) {
            console.error(`[reviews-widget] background fetch error at page ${page}:`, err)
            break
          }
        }
      } catch (err) {
        console.error("[reviews-widget] startup error:", err)
        setFetchError(String(err?.message || err))
      } finally {
        setIsFetchingAll(false)
      }
    }

    startup()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPageFromServer])

  function dedupeAppend(prev, items) {
    if (!Array.isArray(items) || items.length === 0) return prev
    const existingIds = new Set(prev.map((r) => r.id))
    const filtered = items.filter((r) => r && r.id != null && !existingIds.has(r.id))
    return prev.concat(filtered)
  }

  function stripHtml(input = "") {
    return String(input).replace(/<\/?[^>]+(>|$)/g, "").replace(/&nbsp;/g, " ").trim()
  }

  // scoring function for closeness ranking
  function scoreReviewForQuery(r, q) {
    if (!q) return 0
    const ql = q.toLowerCase()
    const text = `${stripHtml(r.review || "")} ${r.reviewer || r.name || ""}`.toLowerCase()
    let score = 0
    if (text === ql) score += 200
    const idx = text.indexOf(ql)
    if (idx === 0) score += 120
    if (idx > 0) score += Math.max(0, 80 - idx) // earlier position -> more score
    // occurrences
    let occ = 0
    let pos = 0
    while (true) {
      const i = text.indexOf(ql, pos)
      if (i === -1) break
      occ++
      pos = i + ql.length
    }
    score += occ * 30
    // reviewer match bonus
    const reviewer = (r.reviewer || "").toLowerCase()
    if (reviewer.includes(ql)) score += 40
    // rating slight bias to higher rating
    score += Number(r.rating || 0) * 2
    return score
  }

  // product-match helper
  function reviewMatchesProduct(r, productName) {
    if (!productName) return true
    const pn = productName.toLowerCase()
    // 1) common property names
    if (r.product_name && String(r.product_name).toLowerCase().includes(pn)) return true
    if (r.product_title && String(r.product_title).toLowerCase().includes(pn)) return true
    // 2) raw object 
    try {
      if (r.raw) {
        const rawText = JSON.stringify(r.raw).toLowerCase()
        if (rawText.includes(pn)) return true
      }
    } catch (e) {
      /* ignore stringify errors */
    }
    // 3) review text 
    if (String(r.review || "").toLowerCase().includes(pn)) return true
    // 4) fallback: reviewer 
    if (String(r.reviewer || r.name || "").toLowerCase().includes(pn)) return true
    return false
  }

  // filteredReviews (apply product filter first, then activeQuery)
  const filteredReviews = useMemo(() => {
    // apply product filter
    const productFiltered = selectedProductName
      ? allReviews.filter((r) => reviewMatchesProduct(r, selectedProductName))
      : allReviews

    if (!activeQuery) return productFiltered

    const ql = activeQuery.toLowerCase()
    const matches = productFiltered.filter((r) => {
      const text = `${stripHtml(r.review || "")} ${r.reviewer || ""} ${r.name || ""}`.toLowerCase()
      return text.includes(ql)
    })

    // sort by closeness score
    matches.sort((a, b) => scoreReviewForQuery(b, activeQuery) - scoreReviewForQuery(a, activeQuery))
    return matches
  }, [allReviews, activeQuery, selectedProductName])

  // suggestions
  const suggestions = useMemo(() => {
    const q = debouncedQuery.trim()
    if (!q) return []
    const ql = q.toLowerCase()
    const source = selectedProductName ? allReviews.filter((r) => reviewMatchesProduct(r, selectedProductName)) : allReviews
    const scored = []
    for (let i = 0; i < source.length; i++) {
      const r = source[i]
      const text = stripHtml(r.review || "")
      const textL = text.toLowerCase()
      const idx = textL.indexOf(ql)
      if (idx === -1) continue
      const score = scoreReviewForQuery(r, q)
      const start = Math.max(0, idx - 30)
      const snippet = text.slice(start, Math.min(start + 120, text.length)).trim()
      scored.push({ score, snippet, reviewer: r.reviewer || r.name || "Anonymous", date: r.date_created || r.date || "", id: r.id })
    }
    scored.sort((a, b) => b.score - a.score)
    const out = []
    const seen = new Set()
    for (let i = 0; i < scored.length && out.length < 6; i++) {
      const s = scored[i]
      if (!seen.has(s.snippet)) {
        out.push(s)
        seen.add(s.snippet)
      }
    }
    return out
  }, [allReviews, debouncedQuery, selectedProductName])

  // client-side pagination for UI
  const totalPagesClient = Math.max(1, Math.ceil(filteredReviews.length / perPageView))
  useEffect(() => {
    if (currentPageView > totalPagesClient) setCurrentPageView(1)
  }, [totalPagesClient, currentPageView])

  const pageSlice = useMemo(() => {
    const start = (currentPageView - 1) * perPageView
    return filteredReviews.slice(start, start + perPageView)
  }, [filteredReviews, currentPageView, perPageView])

  // Calculate Average Rating for UI Summary
  const averageRating = useMemo(() => {
    if (!filteredReviews.length) return 0
    const sum = filteredReviews.reduce((acc, curr) => acc + (Number(curr.rating) || 0), 0)
    return (sum / filteredReviews.length).toFixed(1)
  }, [filteredReviews])

  // handlers
  function handleSelectSuggestion(snippet) {
    setQuery(snippet)
    setDebouncedQuery(snippet)
    setActiveQuery(snippet)
    setSuggestionsVisible(false)
    setCurrentPageView(1)
  }

  function handleSearchButton() {
    const qToRun = debouncedQuery || query
    setActiveQuery(qToRun)
    setCurrentPageView(1)
    setSuggestionsVisible(false)
  }

  function handleClearSearch() {
    setQuery("")
    setDebouncedQuery("")
    setActiveQuery("")
    setSuggestionsVisible(false)
    setCurrentPageView(1)
    // NOTE: We do not reset selectedProductName here, allowing user to clear search but keep product filter
  }

  // --- FIXED LOGIC HERE ---
  function handleProductDropdownChange(e) {
    const val = e.target.value || ""
    setSelectedProductName(val)
    setCurrentPageView(1)
    // Removed setQuery/setActiveQuery to prevent search bar population
  }

  // --- UI RENDER HELPERS ---
  
  // SVG Star Icon
  function StarIcon({ className = "w-4 h-4", fill = false }) {
    return (
      <svg 
        className={className} 
        fill={fill ? "currentColor" : "none"} 
        viewBox="0 0 24 24" 
        stroke="currentColor" 
        strokeWidth="1.5"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.53.044.739.676.354 1.014l-4.182 3.69a.563.563 0 00-.182.557l1.285 5.385a.557.557 0 01-.81.613L12 17.147l-4.666 2.501a.557.557 0 01-.81-.613l1.285-5.385a.563.563 0 00-.182-.557l-4.182-3.69c-.385-.338-.176-.97.354-1.014l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
      </svg>
    )
  }

  function renderStars(rating, size = "sm") {
    const r = Math.max(0, Math.min(5, Number(rating || 0)))
    const stars = []
    for (let i = 0; i < 5; i++) {
        stars.push(
            <span key={i} className={`${i < r ? "text-amber-400" : "text-gray-200"}`}>
                <StarIcon className={size === "lg" ? "w-5 h-5" : "w-4 h-4"} fill={i < r} />
            </span>
        )
    }
    return <div className="flex gap-0.5">{stars}</div>
  }

  // Helper to render highlighted snippet element
  function highlightMatch(text, q) {
    if (!q) return text
    const ql = q.toString().trim()
    if (!ql) return text
    const parts = []
    const lower = text.toLowerCase()
    const needle = ql.toLowerCase()
    let pos = 0
    let idx = lower.indexOf(needle, pos)
    while (idx !== -1) {
      if (idx > pos) parts.push(<span key={pos + "-pre"}>{text.slice(pos, idx)}</span>)
      parts.push(<mark key={idx + "-match"} className="bg-yellow-200 rounded-sm">{text.slice(idx, idx + needle.length)}</mark>)
      pos = idx + needle.length
      idx = lower.indexOf(needle, pos)
    }
    if (pos < text.length) parts.push(<span key={pos + "-tail"}>{text.slice(pos)}</span>)
    return <>{parts}</>
  }

  // --- MAIN RENDER ---

  const loadedCount = allReviews.length
  const knownTotal = totalReviewsCount ?? (totalPages ? totalPages * INITIAL_PAGE_SIZE : null)
  const isLoadingInitial = isFetchingAll && loadedCount === 0

  return (
    <div className="w-full max-w-5xl mx-auto p-4 md:p-6 bg-white font-sans text-slate-800">
      
      {/* 1. Header Summary Section */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between border-b border-slate-100 pb-4">
        <div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">Customer Reviews</h2>
            <div className="flex items-center gap-2 mt-1">
                {renderStars(averageRating || 5, "lg")}
                <span className="text-sm font-medium text-slate-600">
                    {averageRating} based on {knownTotal || loadedCount} reviews
                </span>
            </div>
        </div>
        <div className="mt-4 md:mt-0 text-right">
             <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-700">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
                Verified Reviews
             </div>
        </div>
      </div>

      {/* 2. Controls & Search */}
      <div className="mb-6 grid grid-cols-1 md:grid-cols-12 gap-3">
        {/* Product Dropdown */}
        <div className="md:col-span-4 relative">
           <select 
             value={selectedProductName} 
             onChange={handleProductDropdownChange} 
             className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-700 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
           >
            <option value="">All Products</option>
            {PRODUCTS.map((p, i) => (
              <option key={i} value={p}>{p}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-500">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"/></svg>
          </div>
        </div>

        {/* Search Bar */}
        <div className="md:col-span-6 relative">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="search"
              aria-label="Search reviews"
              placeholder='Search keywords (e.g. "anxiety", "sleep")...'
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSuggestionsVisible(true)
              }}
              onFocus={() => setSuggestionsVisible(true)}
              onBlur={() => setTimeout(() => setSuggestionsVisible(false), 200)}
              className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm shadow-sm focus:border-[#e92727] focus:outline-none focus:ring-1 focus:ring-[#e92727]"
            />
          </div>

          {/* Suggestions Dropdown */}
          {suggestionsVisible && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white shadow-xl">
              {suggestions.map((s, i) => (
                <li key={i} className="border-b border-slate-50 last:border-none">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectSuggestion(s.snippet)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-semibold text-slate-500">{s.reviewer}</span>
                        <span className="text-xs text-slate-400">{s.date ? new Date(s.date).toLocaleDateString() : ""}</span>
                    </div>
                    <div className="text-sm text-slate-700 line-clamp-2 leading-snug">
                        {highlightMatch(s.snippet, debouncedQuery || query)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Action Buttons */}
        <div className="md:col-span-2 flex gap-2">
            <button onClick={handleSearchButton} className="flex-1 rounded-lg bg-[#e92727] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-teal-700 transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2">
                Search
            </button>
            {(activeQuery || selectedProductName) && (
                <button onClick={handleClearSearch} className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-slate-600 hover:bg-slate-50 hover:text-slate-800 transition-colors" title="Clear Search">
                    ✕
                </button>
            )}
        </div>
      </div>

      {/* 3. Info / Status Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between text-xs text-slate-500 border-b border-slate-100 pb-2">
        <div className="flex items-center gap-2">
             {fetchError && <span className="text-red-600 font-medium">⚠ {fetchError}</span>}
             {!fetchError && (
                 <>
                    <span>Showing <strong>{pageSlice.length}</strong> of <strong>{filteredReviews.length}</strong></span>
                    {activeQuery && <span className="bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">Query: {activeQuery}</span>}
                 </>
             )}
        </div>
        <div>
            <span>Fetch status: </span>
            {isFetchingAll ? (
                <span className="inline-flex items-center gap-1 text-teal-600 font-medium">
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    Updating...
                </span>
            ) : (
                <span className="text-slate-400">Up to date</span>
            )}
        </div>
      </div>

      {/* 4. Review List OR Loading State */}
      <div className="space-y-4 min-h-[300px]">
        
        {/* Skeleton Loader (if initial fetch) */}
        {isLoadingInitial && (
            Array.from({length: 3}).map((_, i) => (
                <div key={i} className="animate-pulse rounded-xl border border-slate-100 p-6">
                    <div className="flex justify-between">
                        <div className="h-4 bg-slate-200 rounded w-1/4 mb-2"></div>
                        <div className="h-4 bg-slate-200 rounded w-20"></div>
                    </div>
                    <div className="h-3 bg-slate-100 rounded w-full mb-2"></div>
                    <div className="h-3 bg-slate-100 rounded w-3/4"></div>
                </div>
            ))
        )}

        {/* Empty State */}
        {!isLoadingInitial && pageSlice.length === 0 && (
            <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                <p className="text-slate-500 text-sm">No reviews found matching your criteria.</p>
                <button onClick={handleClearSearch} className="mt-2 text-teal-600 text-sm font-medium hover:underline">Clear filters</button>
            </div>
        )}

        {/* Live Reviews */}
        {!isLoadingInitial && pageSlice.map((r) => (
          <article key={r.id ?? Math.random()} className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-3">
              <div>
                <h4 className="text-base font-bold text-slate-800">{r.reviewer || r.name || "Anonymous"}</h4>
                <div className="flex items-center gap-2 text-xs text-slate-500 mt-1">
                     <span>{new Date(r.date_created || r.date || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                     {r.verified && <span className="text-emerald-600 font-medium flex items-center gap-0.5">Verified Buyer</span>}
                </div>
              </div>
              <div className="flex-shrink-0">
                  {renderStars(r.rating)}
              </div>
            </div>
            
            <div className="text-sm text-slate-600 leading-relaxed">
                {stripHtml(r.review || r.content || "")}
            </div>

            {(r.product_title || r.product_name) && (
                <div className="mt-4 pt-3 border-t border-slate-50">
                    <span className="text-xs text-slate-400 font-medium uppercase tracking-wide">Product: </span>
                    <span className="text-xs text-slate-600">{r.product_title || r.product_name}</span>
                </div>
            )}
          </article>
        ))}
      </div>

      {/* 5. Pagination Footer */}
      {filteredReviews.length > 0 && (
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-100 pt-6">
            <div className="flex items-center gap-2">
                <span className="text-sm text-slate-600">Rows per page:</span>
                <select value={perPageView} onChange={(e) => setPerPageView(Number(e.target.value))} className="rounded border border-slate-200 py-1 px-2 text-sm focus:border-teal-500 focus:outline-none">
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                </select>
            </div>
            
            <div className="flex items-center gap-2">
            <button
                onClick={() => setCurrentPageView((p) => Math.max(1, p - 1))}
                disabled={currentPageView === 1}
                className={`rounded px-4 py-2 text-sm font-medium transition-colors ${currentPageView === 1 ? "cursor-not-allowed bg-slate-100 text-slate-400" : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-teal-600"}`}
            >
                Previous
            </button>
            <span className="text-sm font-medium text-slate-700">
                Page {currentPageView} of {totalPagesClient}
            </span>
            <button
                onClick={() => setCurrentPageView((p) => Math.min(totalPagesClient, p + 1))}
                disabled={currentPageView === totalPagesClient}
                className={`rounded px-4 py-2 text-sm font-medium transition-colors ${currentPageView === totalPagesClient ? "cursor-not-allowed bg-slate-100 text-slate-400" : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-teal-600"}`}
            >
                Next
            </button>
            </div>
        </div>
      )}
    </div>
  )
}