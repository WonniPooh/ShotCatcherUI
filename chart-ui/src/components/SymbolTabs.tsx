import { useState, useRef, useEffect, useMemo } from "react";
import { useChartStore } from "../store/chartStore";

type SymbolEntry = { symbol: string; market: "spot" | "futures" };

async function fetchAllSymbols(): Promise<SymbolEntry[]> {
  const [spotRes, futRes] = await Promise.allSettled([
    fetch("https://api.binance.com/api/v3/exchangeInfo"),
    fetch("https://fapi.binance.com/fapi/v1/exchangeInfo"),
  ]);

  const spot: SymbolEntry[] = [];
  if (spotRes.status === "fulfilled" && spotRes.value.ok) {
    const data = await spotRes.value.json();
    for (const s of data.symbols ?? []) {
      if (s.status === "TRADING" && s.quoteAsset === "USDT")
        spot.push({ symbol: s.symbol as string, market: "spot" });
    }
  }

  const futuresSet = new Set<string>();
  const futures: SymbolEntry[] = [];
  if (futRes.status === "fulfilled" && futRes.value.ok) {
    const data = await futRes.value.json();
    for (const s of data.symbols ?? []) {
      if (s.status === "TRADING" && s.quoteAsset === "USDT") {
        futuresSet.add(s.symbol as string);
        futures.push({ symbol: s.symbol as string, market: "futures" });
      }
    }
  }

  const result: SymbolEntry[] = [...futures];
  for (const s of spot) {
    if (!futuresSet.has(s.symbol)) result.push(s);
  }
  result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return result;
}

type MarketFilter = "all" | "spot" | "futures";

export default function SymbolTabs() {
  const tabs          = useChartStore((s) => s.tabs);
  const activeSymbol  = useChartStore((s) => s.activeSymbol);
  const setActiveSymbol = useChartStore((s) => s.setActiveSymbol);
  const addTab        = useChartStore((s) => s.addTab);
  const removeTab     = useChartStore((s) => s.removeTab);

  const [searchOpen,   setSearchOpen]   = useState(false);
  const [query,        setQuery]        = useState("");
  const [allSymbols,   setAllSymbols]   = useState<SymbolEntry[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const inputRef   = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef   = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!searchOpen) return;
    // Compute button position for fixed dropdown placement
    if (buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    }
    setTimeout(() => inputRef.current?.focus(), 50);
    if (allSymbols.length === 0 && !loading) {
      setLoading(true);
      fetchAllSymbols()
        .then(setAllSymbols)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current  && !buttonRef.current.contains(e.target as Node)
      ) {
        setSearchOpen(false);
        setQuery("");
      }
    };
    const id = requestAnimationFrame(() => document.addEventListener("mousedown", handler));
    return () => { cancelAnimationFrame(id); document.removeEventListener("mousedown", handler); };
  }, [searchOpen]);

  const filtered = useMemo(() => {
    let list = marketFilter === "all" ? allSymbols : allSymbols.filter((s) => s.market === marketFilter);
    if (query) {
      const q = query.toUpperCase();
      const starts = list.filter((s) => s.symbol.startsWith(q));
      const rest   = list.filter((s) => !s.symbol.startsWith(q) && s.symbol.includes(q));
      list = [...starts, ...rest];
    }
    return list;
  }, [allSymbols, query, marketFilter]);

  function selectSymbol(sym: string) {
    addTab({ symbol: sym, label: sym.replace("USDT", "") });
    setActiveSymbol(sym);
    setSearchOpen(false);
    setQuery("");
  }

  return (
    <div className="flex items-center gap-0 bg-[#13151f] border-b border-[#2a2d3a] overflow-x-auto">
      <div className="relative flex-shrink-0">
        <button
          ref={buttonRef}
          onClick={() => setSearchOpen((v) => !v)}
          className="px-3 py-1.5 text-gray-500 hover:text-gray-300 text-lg border-r border-[#2a2d3a]"
          title="Add symbol"
        >
          +
        </button>

        {searchOpen && (
          <div
            ref={dropdownRef}
            style={{ position: "fixed", top: dropPos.top, left: dropPos.left, zIndex: 9999 }}
            className="bg-[#1a1d27] border border-[#2a2d3a] rounded shadow-2xl w-72 flex flex-col">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol…"
              className="px-3 py-2 bg-[#13151f] border-b border-[#2a2d3a] text-gray-200 text-sm outline-none placeholder-gray-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered.length > 0) selectSymbol(filtered[0].symbol);
                if (e.key === "Escape") { setSearchOpen(false); setQuery(""); }
              }}
            />
            <div className="flex border-b border-[#2a2d3a]">
              {(["all", "spot", "futures"] as MarketFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setMarketFilter(f)}
                  className={`flex-1 py-1.5 text-xs font-medium ${marketFilter === f ? "text-white border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-300"}`}
                >
                  {f === "futures" ? "USDT-M" : f === "all" ? "All" : "Spot"}
                </button>
              ))}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {loading && <div className="px-3 py-3 text-gray-500 text-sm text-center">Loading…</div>}
              {!loading && filtered.length === 0 && <div className="px-3 py-3 text-gray-500 text-sm text-center">No matches</div>}
              {filtered.map((entry) => (
                <button
                  key={entry.symbol}
                  onClick={() => selectSymbol(entry.symbol)}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm hover:bg-[#22253a] ${tabs.some((t) => t.symbol === entry.symbol) ? "text-blue-400" : "text-gray-200"}`}
                >
                  <span className={`text-[10px] font-bold px-1 rounded flex-shrink-0 ${entry.market === "futures" ? "bg-yellow-900 text-yellow-400" : "bg-blue-900 text-blue-300"}`}>
                    {entry.market === "futures" ? "U" : "S"}
                  </span>
                  {entry.symbol}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.symbol}
          className={`group flex items-center gap-1 px-3 py-1.5 cursor-pointer border-r border-[#2a2d3a] text-sm select-none flex-shrink-0 ${activeSymbol === tab.symbol ? "bg-[#1a1d27] text-white border-b-2 border-b-blue-500" : "text-gray-400 hover:text-gray-200 hover:bg-[#1a1d27]/50"}`}
          onClick={() => setActiveSymbol(tab.symbol)}
        >
          <span className="font-medium">{tab.label}</span>
          {tabs.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); removeTab(tab.symbol); }}
              className="ml-1 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
