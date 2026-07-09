"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

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

  const [selectedProductName, setSelectedProductName] = useState("")
  const [filterStar, setFilterStar] = useState("all")
  const [sortBy, setSortBy] = useState("most_helpful")

  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [activeQuery, setActiveQuery] = useState("")
  const [suggestionsVisible, setSuggestionsVisible] = useState(false)
  const [currentPageView, setCurrentPageView] = useState(1)
  const [perPageView, setPerPageView] = useState(10)

  const [mostHelpful, setMostHelpful] = useState([])
  const mostHelpfulIdsRef = useRef(new Set())


  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 220)
    return () => clearTimeout(t)
  }, [query])

  function dedupeAppend(prev, items) {
    if (!Array.isArray(items) || items.length === 0) return prev
    const existingIds = new Set(prev.map((r) => String(r.id)))
    const blocked = mostHelpfulIdsRef.current
    const filtered = items.filter((r) => r && r.id != null && !existingIds.has(String(r.id)) && !blocked.has(String(r.id)))
    return prev.concat(filtered)
  }

  function stripHtml(input = "") {
    return String(input).replace(/<\/?[^>]+(>|$)/g, "").replace(/&nbsp;/g, " ").trim()
  }

  function getTokens(q) {
    if (!q) return []
    return q.toLowerCase().split(/\s+/).filter(t => t.length > 0)
  }

  function scoreReviewForQuery(r, q) {
    if (!q) return 0
    const text = `${stripHtml(r.review || "")} ${r.reviewer || r.name || ""}`.toLowerCase()
    const qLower = q.toLowerCase()
    let score = 0
    if (text.includes(qLower)) score += 100
    const tokens = getTokens(q)
    let matches = 0
    tokens.forEach(token => {
      if (text.includes(token)) {
        score += 10
        matches++
      }
    })
    if (matches === tokens.length && tokens.length > 1) score += 20
    score += (Number(r.rating) || 0) * 0.5
    return score
  }

  function reviewMatchesProduct(r, productName) {
    if (!productName) return true
    const pn = productName.toLowerCase()
    if (r.product_name && String(r.product_name).toLowerCase().includes(pn)) return true
    if (r.product_title && String(r.product_title).toLowerCase().includes(pn)) return true
    try {
      if (r.raw) {
        const rawText = JSON.stringify(r.raw).toLowerCase()
        if (rawText.includes(pn)) return true
      }
    } catch (e) { }
    if (String(r.review || "").toLowerCase().includes(pn)) return true
    if (String(r.reviewer || r.name || "").toLowerCase().includes(pn)) return true
    return false
  }

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
        let page = 2
        const knownTotal = first.pagination?.totalPages ?? null
        while (!cancelled) {
          if (knownTotal && page > knownTotal) break
          if (mostHelpfulIdsRef.current && Array.from(mostHelpfulIdsRef.current).length > 0 && allReviews.length >= MAX_STORE) break
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
  }, [fetchPageFromServer])

  useEffect(() => {
    let cancelled = false
    async function loadMostHelpful() {
      try {
        const res = await fetch("/reviews/most-helpful.json", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()
         if (cancelled) return
        if (!Array.isArray(data)) return
        const normalized = data.map(d => ({
          ...d,
          product_name: d.product_name ?? d.raw?.product_name ?? null,
          product_title: d.product_title ?? d.raw?.product_title ?? null,
        }))
        setMostHelpful(normalized)
        const ids = new Set(normalized.map(r => String(r.id)))
        mostHelpfulIdsRef.current = ids
        setAllReviews(prev => prev.filter(r => !ids.has(String(r.id))))
      } catch (e) {
        console.error("[reviews-widget] loadMostHelpful error:", e)
      }
    }
    loadMostHelpful()
    return () => { cancelled = true }
  }, [])


  const mostHelpfulIndex = useMemo(() => {
    const m = new Map()
    mostHelpful.forEach((r, i) => {
      m.set(String(r.id), i)
    })
    return m
  }, [mostHelpful])

  const filteredReviews = useMemo(() => {
    let combined = mostHelpful.concat(allReviews)
    let result = combined.slice()
    if (selectedProductName) {
      result = result.filter((r) => reviewMatchesProduct(r, selectedProductName))
    }
    if (filterStar !== "all") {
      const target = Number(filterStar)
      result = result.filter(r => Math.round(Number(r.rating || 0)) === target)
    }
    if (activeQuery) {
      const tokens = getTokens(activeQuery)
      if (tokens.length > 0) {
        result = result.filter((r) => {
          const text = `${stripHtml(r.review || "")} ${r.reviewer || ""} ${r.name || ""}`.toLowerCase()
          return tokens.some(token => text.includes(token))
        })
      }
    }
    result.sort((a, b) => {
      if (activeQuery) {
        const scoreA = scoreReviewForQuery(a, activeQuery)
        const scoreB = scoreReviewForQuery(b, activeQuery)
        if (scoreB !== scoreA) return scoreB - scoreA
      }
      const dateA = Number(new Date(a.date_created || a.date || 0)) || 0
      const dateB = Number(new Date(b.date_created || b.date || 0)) || 0
      const ratingA = Number(a.rating || 0)
      const ratingB = Number(b.rating || 0)
      if (sortBy === "most_helpful") {
        const idxA = mostHelpfulIndex.get(String(a.id))
        const idxB = mostHelpfulIndex.get(String(b.id))
        const aHas = idxA != null
        const bHas = idxB != null
        if (aHas && bHas) return idxA - idxB
        if (aHas) return -1
        if (bHas) return 1
        return dateB - dateA
      }
      switch (sortBy) {
        case "rating_desc":
          if (ratingB !== ratingA) return ratingB - ratingA
          return dateB - dateA
        case "rating_asc":
          if (ratingA !== ratingB) return ratingA - ratingB
          return dateB - dateA
        case "oldest":
          return dateA - dateB
        case "newest":
        default:
          return dateB - dateA
      }
    })
    return result
  }, [mostHelpful, allReviews, activeQuery, selectedProductName, filterStar, sortBy, mostHelpfulIndex])

  const suggestions = useMemo(() => {
    const q = debouncedQuery.trim()
    if (!q) return []
    let source = mostHelpful.concat(allReviews)
    if (selectedProductName) source = source.filter(r => reviewMatchesProduct(r, selectedProductName))
    if (filterStar !== "all") source = source.filter(r => Math.round(Number(r.rating || 0)) === Number(filterStar))
    const scored = []
    const tokens = getTokens(q)
    if (tokens.length === 0) return []
    for (let i = 0; i < source.length; i++) {
      const r = source[i]
      const text = stripHtml(r.review || "")
      const textL = text.toLowerCase()
      const firstMatchIndex = tokens.map(t => textL.indexOf(t)).find(idx => idx !== -1)
      if (firstMatchIndex === undefined) continue
      const score = scoreReviewForQuery(r, q)
      const start = Math.max(0, firstMatchIndex - 30)
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
  }, [mostHelpful, allReviews, debouncedQuery, selectedProductName, filterStar])

  const totalPagesClient = Math.max(1, Math.ceil(filteredReviews.length / perPageView))
  useEffect(() => {
    if (currentPageView > totalPagesClient) setCurrentPageView(1)
  }, [totalPagesClient, currentPageView])

  const pageSlice = useMemo(() => {
    const start = (currentPageView - 1) * perPageView
    return filteredReviews.slice(start, start + perPageView)
  }, [filteredReviews, currentPageView, perPageView])

  const averageRating = useMemo(() => {
    if (!filteredReviews.length) return 0
    const sum = filteredReviews.reduce((acc, curr) => acc + (Number(curr.rating) || 0), 0)
    return (sum / filteredReviews.length).toFixed(1)
  }, [filteredReviews])

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
  }

  function handleProductDropdownChange(e) {
    setSelectedProductName(e.target.value || "")
    setCurrentPageView(1)
  }

  function handleStarFilterChange(e) {
    setFilterStar(e.target.value)
    setCurrentPageView(1)
  }

  function handleSortChange(e) {
    setSortBy(e.target.value)
    setCurrentPageView(1)
  }

  function scrollToTop() {
    if (window.parent) {
      window.parent.postMessage({
        type: 'scrollToElement',
        selector: '#reviewsIframe'
      }, '*');
    }
  }

  function handleNextPage() {
    setCurrentPageView((p) => Math.min(totalPagesClient, p + 1));
    scrollToTop();
  }

  function handlePrevPage() {
    setCurrentPageView((p) => Math.max(1, p - 1));
    scrollToTop();
  }

  useEffect(() => {
    const sendHeight = () => {
      const height = document.body.scrollHeight;
      if (window.parent) {
        window.parent.postMessage({
          height: height,
          type: 'setIframeHeight'
        }, '*');
      }
    };
    sendHeight();
    window.addEventListener('resize', sendHeight);
    return () => window.removeEventListener('resize', sendHeight);
  }, [filteredReviews, activeQuery, selectedProductName, filterStar, sortBy, currentPageView, perPageView]);

  function StarIcon({ className = "w-4 h-4", fill = false }) {
    return (
      <svg className={className} fill={fill ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"> <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.53.044.739.676.354 1.014l-4.182 3.69a.563.563 0 00-.182.557l1.285 5.385a.557.557 0 01-.81.613L12 17.147l-4.666 2.501a.557.557 0 01-.81-.613l1.285-5.385a.563.563 0 00-.182-.557l-4.182-3.69c-.385-.338-.176-.97.354-1.014l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /> </svg>
    )
  }

  function renderStars(rating, size = "sm") {
    const r = Math.max(0, Math.min(5, Number(rating || 0)))
    const stars = []
    for (let i = 0; i < 5; i++) {
      stars.push(
        <span key={i} className={`${i < r ? "text-amber-400" : "text-gray-200"}`}>
          <StarIcon className={size === "lg" ? "w-5 h-5" : "w-4 h-4"} fill={i < r} /> </span>
      )
    }
    return <div className="flex gap-0.5">{stars}</div>
  }

  function highlightMatch(text, q) {
    if (!q) return text
    const tokens = getTokens(q)
    if (tokens.length === 0) return text
    const regex = new RegExp(`(${tokens.map(t => t.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')).join('|')})`, 'gi')
    const parts = text.split(regex)
    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (<mark key={i} className="bg-yellow-200 rounded-sm">{part}</mark>
          ) : (<span key={i}>{part}</span>
          )
        )}
      </>
    )
  }

  const loadedCount = allReviews.length
  const knownTotal = totalReviewsCount ?? (totalPages ? totalPages * INITIAL_PAGE_SIZE : null)
  const isLoadingInitial = isFetchingAll && loadedCount === 0
  return (<div className="w-full max-w-5xl mx-auto p-4 md:p-6 bg-[#fdf6ef] font-sans text-slate-800">

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
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
          Verified Reviews
        </div>
      </div>
    </div>

    <div className="mb-6 space-y-3">

      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <svg className="h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="Search reviews"
            placeholder='Search (e.g. "Depression", "Anxiety relief", "Productivity", "Stress", etc)'
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSuggestionsVisible(true)
            }}
            onFocus={() => setSuggestionsVisible(true)}
            onBlur={() => setTimeout(() => setSuggestionsVisible(false), 200)}
            className="w-full rounded-lg border border-slate-200 pl-10 pr-4 py-2.5 text-sm shadow-sm focus:border-[#e92727] focus:outline-none focus:ring-1 focus:ring-[#e92727] bg-[#fff]"
          />
          <button onClick={handleSearchButton} className="rounded-lg bg-[#e92727] px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 transition-colors">
            Search
          </button>
        </div>

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="relative">
          <select
            value={selectedProductName}
            onChange={handleProductDropdownChange}
            className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:border-[#e92727] focus:outline-none pr-8"
          >
            <option value="">All Products</option>
            {PRODUCTS.map((p, i) => <option key={i} value={p}>{p}</option>)}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <svg className="w-4 h-4 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6 8l4 4 4-4" /></svg>
          </div>
        </div>

        {/* <div className="relative">
          <select
            value={filterStar}
            onChange={handleStarFilterChange}
            className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:border-[#e92727] focus:outline-none pr-8"
          >
            <option value="all">All Star Ratings</option>
            <option value="5">★★★★★ (5 Stars Only)</option>
            <option value="4">★★★★☆ (4 Stars Only)</option>
            <option value="3">★★★☆☆ (3 Stars Only)</option>
            <option value="2">★★☆☆☆ (2 Stars Only)</option>
            <option value="1">★☆☆☆☆ (1 Star Only)</option>
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <svg className="w-4 h-4 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6 8l4 4 4-4" /></svg>
          </div>
        </div> */}

        <div className="relative">
          <select
            value={sortBy}
            onChange={handleSortChange}
            className="w-full appearance-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:border-[#e92727] focus:outline-none pr-8"
          >
            <option value="newest">Sort: Newest First</option>
            <option value="oldest">Sort: Oldest First</option>
            <option value="rating_desc">Sort: Highest Rating</option>
            <option value="rating_asc">Sort: Lowest Rating</option>
            <option value="most_helpful">Sort: Most Helpful</option>
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <svg className="w-4 h-4 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M6 8l4 4 4-4" /></svg>
          </div>
        </div>
      </div>

      {(activeQuery || selectedProductName || filterStar !== "all") && (
        <div className="flex flex-wrap gap-2 pt-2">
          {activeQuery && (
            <button onClick={handleClearSearch} className="inline-flex items-center gap-1 rounded bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-800 hover:bg-yellow-200">
              Query: {activeQuery} ✕
            </button>
          )}
          {selectedProductName && (
            <button onClick={() => setSelectedProductName("")} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">
              Product: {selectedProductName} ✕
            </button>
          )}
          {filterStar !== "all" && (
            <button onClick={() => setFilterStar("all")} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200">
              {filterStar} Stars ✕
            </button>
          )}
          <button onClick={() => { handleClearSearch(); setSelectedProductName(""); setFilterStar("all") }} className="text-xs text-[#e92727] underline ml-auto">
            Reset All
          </button>
        </div>
      )}
    </div>

    <div className="mb-4 flex flex-wrap items-center justify-between text-xs text-slate-500 border-b border-slate-100 pb-2">
      <div className="flex items-center gap-2">
        {fetchError && <span className="text-red-600 font-medium">⚠ {fetchError}</span>}
        {!fetchError && (
          <span>Showing <strong>{pageSlice.length}</strong> of <strong>{totalReviewsCount}</strong></span>
        )}
      </div>
      <div>
        {isFetchingAll ? (
          <span className="inline-flex items-center gap-1 text-teal-600 font-medium">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            Syncing...
          </span>
        ) : (
          <span className="text-slate-400">Up to date</span>
        )}
      </div>
    </div>

    <div className="space-y-4 min-h-[300px]">

      {isLoadingInitial && (
        Array.from({ length: 3 }).map((_, i) => (
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

      {!isLoadingInitial && pageSlice.length === 0 && (
        <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
          <p className="text-slate-500 text-sm">No reviews found matching your criteria.</p>
          <button onClick={() => { handleClearSearch(); setFilterStar("all"); setSelectedProductName("") }} className="mt-2 text-[#e92727] text-sm font-medium hover:underline">Clear all filters</button>
        </div>
      )}

      {!isLoadingInitial && pageSlice.map((r) => {
        const isHelpful = mostHelpfulIndex.has(String(r.id))
        return (
          <article key={r.id ?? Math.random()} className={`group rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md transition-shadow`}>
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
              {activeQuery ? highlightMatch(stripHtml(r.review || r.content || ""), activeQuery) : stripHtml(r.review || r.content || "")}
            </div>

            {(r.product_title || r.product_name) && (
              <div className="mt-4 pt-3 border-t border-slate-50">
                <span className="text-xs text-slate-400 font-medium uppercase tracking-wide">Product: </span>
                <span className="text-xs text-slate-600">{r.product_title || r.product_name}</span>
              </div>
            )}

            <div className="mt-4 flex flex-col gap-3">
              {r?.replies?.length > 0 && (
                <div className="space-y-2">
                  {(r?.replies).map((reply, idx) => (
                    <div key={idx} className="rounded-xl border border-slate-100 bg-[#f8ecd2] p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-[14px] font-bold text-slate-800">{reply.author_name || "Admin"}</div>
                        <div className="text-xs text-slate-500">
                          <span>{new Date(reply.date_created || reply.date || Date.now()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                        </div>
                      </div>
                      <div className="mt-2 text-sm text-slate-700">{stripHtml(reply.content)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        )
      })}
    </div>

    {filteredReviews.length > 0 && (
      <div className="mt-8 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-100 pt-6">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Rows per page:</span>
          <select value={perPageView} onChange={(e) => setPerPageView(Number(e.target.value))} className="rounded border border-slate-200 py-1 px-2 text-sm focus:border-[#e92727] focus:outline-none">
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePrevPage}
            disabled={currentPageView === 1}
            className={`rounded px-4 py-2 text-sm font-medium transition-colors ${currentPageView === 1 ? "cursor-not-allowed bg-slate-100 text-slate-400" : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-[#e92727]"}`}
          >
            Previous
          </button>
          <span className="text-sm font-medium text-slate-700">
            Page {currentPageView} of {totalPagesClient}
          </span>
          <button
            onClick={handleNextPage}
            disabled={currentPageView === totalPagesClient}
            className={`rounded px-4 py-2 text-sm font-medium transition-colors ${currentPageView === totalPagesClient ? "cursor-not-allowed bg-slate-100 text-slate-400" : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-[#e92727]"}`}
          >
            Next
          </button>
        </div>
      </div>
    )}
  </div>

  )
}
