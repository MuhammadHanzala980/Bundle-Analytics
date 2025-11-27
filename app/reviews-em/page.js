"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

export default function ReviewsWidget({ productId = null }) {
  const INITIAL_PAGE_SIZE = 50
  const MAX_STORE = 5000

  // Replace this list with real product names from microdosify.com/shop/ when available.
  // If you want me to auto-populate this from the site, tell me and I'll add a small fetch/scrape (but you said no extra APIs).
  const PRODUCTS = [
    "CALM ",
    "Focus",
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

  // product-match helper:
  // tries different places to find product name inside a review object.
  function reviewMatchesProduct(r, productName) {
    if (!productName) return true
    const pn = productName.toLowerCase()
    // 1) common property names: product_name, product_title
    if (r.product_name && String(r.product_name).toLowerCase().includes(pn)) return true
    if (r.product_title && String(r.product_title).toLowerCase().includes(pn)) return true
    // 2) raw object (server returns raw review sometimes) — stringify and search
    try {
      if (r.raw) {
        const rawText = JSON.stringify(r.raw).toLowerCase()
        if (rawText.includes(pn)) return true
      }
    } catch (e) {
      /* ignore stringify errors */
    }
    // 3) review text may mention the product name
    if (String(r.review || "").toLowerCase().includes(pn)) return true
    // 4) fallback: reviewer or author fields
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

  // suggestions: show top 6 snippets ranked by score using debouncedQuery (live typing)
  const suggestions = useMemo(() => {
    const q = debouncedQuery.trim()
    if (!q) return []
    const ql = q.toLowerCase()
    // compute score and snippet — search inside product-filtered set so suggestions are relevant to selected product
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
    // unique snippets by snippet text
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
    setSelectedProductName("")
  }

  // when product is selected from dropdown: set as product filter and also use as query
  function handleProductDropdownChange(e) {
    const val = e.target.value || ""
    setSelectedProductName(val)
    if (!val) {
      // show all reviews
      setActiveQuery("") // optional: keep user's typed query if you prefer; spec asked to consider product as query
      setQuery("")
      setDebouncedQuery("")
    } else {
      // set product name as the search phrase so reviews for that product show up
      setQuery(val)
      setDebouncedQuery(val)
      setActiveQuery(val)
      setSuggestionsVisible(false)
      setCurrentPageView(1)
    }
  }

  // render helpers
  function renderStars(rating) {
    const r = Math.max(0, Math.min(5, Number(rating || 0)))
    return Array.from({ length: 5 }).map((_, i) => (
      <span key={i} className={`text-sm ${i < r ? "text-amber-400" : "text-gray-200"}`}>★</span>
    ))
  }

  // UI
  const loadedCount = allReviews.length
  const knownTotal = totalReviewsCount ?? (totalPages ? totalPages * INITIAL_PAGE_SIZE : null)

  return (
    <div className="mx-auto max-w-4xl px-4 py-4">
      {/* Controls */}
      <div className="mb-4 flex gap-3 items-center">
        {/* Product dropdown (local array) */}
        <div>
          <label className="block text-xs text-slate-600">Products</label>
          <select value={selectedProductName} onChange={handleProductDropdownChange} className="rounded border px-3 py-2 text-sm">
            <option value="">All products</option>
            {PRODUCTS.map((p, i) => (
              <option key={i} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="relative flex-1">
          <input
            type="search"
            aria-label="Search reviews"
            placeholder='Type to get suggestions, then click Search or a suggestion'
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSuggestionsVisible(true)
            }}
            onFocus={() => setSuggestionsVisible(true)}
            onBlur={() => setTimeout(() => setSuggestionsVisible(false), 140)}
            className="w-full rounded border border-slate-200 px-3 py-2 text-sm shadow-sm focus:outline-none"
          />

          {/* suggestions dropdown */}
          {suggestionsVisible && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded border bg-white shadow-lg">
              {suggestions.map((s, i) => (
                <li key={i} className="px-2">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleSelectSuggestion(s.snippet)}
                    className="w-full text-left py-2 hover:bg-slate-50"
                  >
                    <div className="text-xs text-slate-500">
                      {s.reviewer} • {s.date ? new Date(s.date).toLocaleDateString() : ""}
                    </div>
                    <div className="mt-1 text-sm text-slate-800">{highlightMatch(s.snippet, debouncedQuery || query)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button onClick={handleSearchButton} className="rounded bg-teal-600 px-4 py-2 text-sm text-white hover:bg-teal-700">
          Search
        </button>

        <select value={perPageView} onChange={(e) => setPerPageView(Number(e.target.value))} className="rounded border px-2 py-2 text-sm">
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>

        <button onClick={handleClearSearch} className="rounded border px-3 py-2 text-sm">
          Clear
        </button>
      </div>

      {/* Progress */}
      <div className="mb-4 text-xs text-slate-600">
        {fetchError ? (
          <span className="text-red-600">Fetch error: {fetchError}</span>
        ) : (
          <>
            Loaded: <strong>{loadedCount}</strong>
            {knownTotal ? (
              <>
                {" "}
                of <strong>{knownTotal}</strong>
              </>
            ) : (
              <> reviews (total unknown)</>
            )}
            {" • "}Pages fetched: <strong>{loadedPages}</strong>
            {totalPages ? <> / {totalPages}</> : null}
            {isFetchingAll ? <> • background fetch…</> : <> • background fetch finished</>}
            {activeQuery ? (
              <>
                {" "}
                • Showing results for: <strong>{activeQuery}</strong>
              </>
            ) : null}
          </>
        )}
      </div>

      {/* Reviews list */}
      <div className="space-y-4">
        {pageSlice.map((r) => (
          <article key={r.id ?? Math.random()} className="rounded-lg border p-4 bg-white shadow-sm">
            <div className="flex justify-between items-start">
              <div>
                <h4 className="text-sm font-semibold">{r.reviewer || r.name || "Anonymous"}</h4>
                <div className="text-xs text-slate-500">{new Date(r.date_created || r.date || Date.now()).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center">{renderStars(r.rating)}</div>
            </div>
            <p className="mt-3 text-slate-700">{stripHtml(r.review || r.content || "")}</p>
            {r.verified ? (
              <div className="mt-2 inline-block rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">✓ Verified</div>
            ) : null}
          </article>
        ))}
      </div>

      {/* Pagination controls */}
      <div className="mt-6 flex items-center justify-between">
        <div className="text-sm text-slate-600">
          Showing {pageSlice.length} of {filteredReviews.length} matched reviews
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentPageView((p) => Math.max(1, p - 1))}
            disabled={currentPageView === 1}
            className={`rounded px-3 py-2 text-sm ${currentPageView === 1 ? "bg-slate-100 text-slate-400" : "bg-teal-600 text-white"}`}
          >
            ← Prev
          </button>
          <div className="text-sm text-slate-600">Page {currentPageView} / {totalPagesClient}</div>
          <button
            onClick={() => setCurrentPageView((p) => Math.min(totalPagesClient, p + 1))}
            disabled={currentPageView === totalPagesClient}
            className={`rounded px-3 py-2 text-sm ${currentPageView === totalPagesClient ? "bg-slate-100 text-slate-400" : "bg-teal-600 text-white"}`}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  )

  // helper to render highlighted snippet element (returns React nodes)
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
      parts.push(<mark key={idx + "-match"} className="bg-yellow-200">{text.slice(idx, idx + needle.length)}</mark>)
      pos = idx + needle.length
      idx = lower.indexOf(needle, pos)
    }
    if (pos < text.length) parts.push(<span key={pos + "-tail"}>{text.slice(pos)}</span>)
    return <>{parts}</>
  }
}
