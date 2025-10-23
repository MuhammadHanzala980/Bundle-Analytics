import  FetchOrdersCard  from "@/components/fetch-orders-button"

export const metadata = {
  title: "Orders Fetcher",
  description: "Fetch WooCommerce orders and save as JSON.",
}

export default function Page() {
  return (
    <main className="min-h-dvh flex items-center justify-center p-6">
      <div className="w-full max-w-3xl mx-auto flex flex-col items-center gap-6">
        <header className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-balance">{"Fetch and Save WooCommerce Orders"}</h1>
          <p className="mt-2 text-muted-foreground text-pretty">
            {"One-click to fetch your store orders and store them locally as JSON."}
          </p>
        </header>

        <FetchOrdersCard />

        <footer className="text-xs text-muted-foreground text-center">
          {"Light theme by default for clear readability."}
        </footer>
      </div>
    </main>
  )
}