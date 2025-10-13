"use client"

import { useState } from "react"

function FetchOrdersButton() {
  const [loading, setLoading] = useState(false)
  const [count, setCount] = useState(null)
  const [error, setError] = useState(null)
  const [filePath, setFilePath] = useState(null)

  const handleFetch = async () => {
    setLoading(true)
    setError(null)
    setCount(null)
    setFilePath(null)
    try {
      const res = await fetch("/api/fetch-orders", { method: "POST" })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data?.error || "Failed to fetch orders.")
      }
      setCount(data.count ?? null)
      setFilePath(data.file ?? null)
    } catch (e) {
      setError(e?.message || "Something went wrong.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-xl rounded-lg border border-border bg-background p-6 shadow-sm">
      <div className="mb-4">
        <h2 className="text-balance text-lg font-semibold text-foreground">WooCommerce Orders</h2>
        <p className="text-pretty text-sm text-muted-foreground">
          Fetch orders from your store and save them to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/public/data/orders.json</code>.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleFetch}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Fetching orders..." : "Fetch Orders"}
        </button>
      </div>

      {typeof count === "number" && (
        <div className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          Successfully saved {count} orders.
        </div>
      )}

      {filePath && (
        <a
          href={filePath}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-2 text-sm underline hover:no-underline"
        >
          View orders.json
        </a>
      )}

      {error && <div className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <p className="mt-3 text-xs text-muted-foreground">
        Tip: Set WC_SITE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET in Vars to enable the API.
      </p>
    </div>
  )
}

export default FetchOrdersButton
