/**
 * OpenOrdersPanel — sidebar showing live open orders across all symbols.
 * Click a card to navigate the chart to that order's symbol.
 */
import { useChartStore } from '../store/chartStore';
import { useOpenOrderStore } from '../store/openOrderStore';
import type { OpenOrder } from '../store/openOrderStore';
import { ORDER_TYPE_COLORS, ORDER_COLOR_DEFAULT } from '../types/orders';

/** Format price with appropriate precision. */
function formatPrice(price: number): string {
  if (price === 0) return '—';
  if (price >= 1000) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/** Format time ago: e.g. "2h 15m ago", "3m ago". */
function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

/** Display name for order type. */
function shortType(type: string): string {
  const map: Record<string, string> = {
    LIMIT: 'LMT',
    MARKET: 'MKT',
    STOP_MARKET: 'STOP',
    TAKE_PROFIT_MARKET: 'TP',
    STOP: 'STP-LMT',
    TAKE_PROFIT: 'TP-LMT',
    TRAILING_STOP_MARKET: 'TRAIL',
  };
  return map[type] ?? type;
}

function OrderCard({ order, onNavigate, isActiveSymbol, currentPrice }: {
  order: OpenOrder;
  onNavigate: (order: OpenOrder) => void;
  isActiveSymbol: boolean;
  currentPrice: number;
}) {
  const sideColor = order.side === 'BUY' ? 'text-green-400' : 'text-red-400';
  const sideBg = order.side === 'BUY' ? 'bg-green-500/10' : 'bg-red-500/10';
  const typeColor = ORDER_TYPE_COLORS[order.order_type] ?? ORDER_COLOR_DEFAULT;
  const displayPrice = order.order_type.includes('STOP') || order.order_type.includes('TAKE_PROFIT')
    ? order.stop_price
    : order.order_price;

  // Price delta: how far the order is from current price (order perspective)
  // Negative = order below market, positive = order above market
  let deltaStr = '';
  let deltaColor = 'text-gray-500';
  if (isActiveSymbol && currentPrice > 0 && displayPrice > 0) {
    const deltaPct = ((displayPrice - currentPrice) / currentPrice) * 100;
    deltaStr = `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`;
    // For BUY: order below market is favorable; for SELL: order above is favorable
    const favorable = order.side === 'BUY'
      ? displayPrice <= currentPrice
      : displayPrice >= currentPrice;
    deltaColor = favorable ? 'text-green-400' : 'text-yellow-500';
  }

  return (
    <button
      onClick={() => onNavigate(order)}
      className="w-full text-left px-3 py-2.5 border-b border-[#2a2d3a] hover:bg-[#1e2130] transition-colors cursor-pointer"
    >
      {/* Header: symbol + side badge */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-200">{order.symbol}</span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${sideBg} ${sideColor}`}>
          {order.side}
        </span>
      </div>

      {/* Type + price */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium" style={{ color: typeColor }}>
          {shortType(order.order_type)}
        </span>
        <span className="text-sm font-medium text-gray-200">
          {formatPrice(displayPrice)}
        </span>
      </div>

      {/* Qty + delta */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] text-gray-400">
          Qty: {order.order_qty}
          {order.filled_qty_accumulated > 0 && (
            <span className="text-gray-500"> ({order.filled_qty_accumulated} filled)</span>
          )}
        </span>
        {deltaStr && (
          <span className={`text-[10px] font-medium ${deltaColor}`}>{deltaStr}</span>
        )}
      </div>

      {/* Time placed + reduce-only flag */}
      <div className="flex items-center justify-between text-[10px] text-gray-500">
        <span>{formatTimeAgo(order.transaction_time_ms)}</span>
        {order.is_reduce_only === 1 && (
          <span className="text-yellow-600">reduce</span>
        )}
      </div>
    </button>
  );
}

export default function OpenOrdersPanel() {
  const { orders, loaded } = useOpenOrderStore();
  const activeSymbol = useChartStore((s) => s.activeSymbol);
  const currentPrice = useChartStore((s) => s.currentPrice);
  const setActiveSymbol = useChartStore((s) => s.setActiveSymbol);
  const tabs = useChartStore((s) => s.tabs);
  const addTab = useChartStore((s) => s.addTab);

  const handleNavigate = (order: OpenOrder) => {
    if (order.symbol !== activeSymbol) {
      if (!tabs.some((t) => t.symbol === order.symbol)) {
        addTab({ symbol: order.symbol, label: order.symbol.replace('USDT', '') });
      }
      setActiveSymbol(order.symbol);
    }
  };

  // Group by symbol for display
  const activeOrders = orders.filter((o) => o.symbol === activeSymbol);
  const otherOrders = orders.filter((o) => o.symbol !== activeSymbol);

  return (
    <div className="flex flex-col h-full bg-[#13151f] border-l border-[#2a2d3a] overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#2a2d3a]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-300">Open Orders</span>
          <span className="text-[10px] text-gray-500">{orders.length} orders</span>
        </div>
      </div>

      {/* Order list */}
      <div className="flex-1 overflow-y-auto">
        {!loaded && (
          <div className="p-4 text-center text-xs text-gray-500">Loading...</div>
        )}
        {loaded && orders.length === 0 && (
          <div className="p-4 text-center text-xs text-gray-500">No open orders</div>
        )}

        {/* Active symbol orders first */}
        {activeOrders.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-gray-500 bg-[#1a1d27] border-b border-[#2a2d3a] font-medium">
              {activeSymbol}
            </div>
            {activeOrders.map((o) => (
              <OrderCard
                key={o.order_id}
                order={o}
                onNavigate={handleNavigate}
                isActiveSymbol={true}
                currentPrice={currentPrice}
              />
            ))}
          </>
        )}

        {/* Other symbols */}
        {otherOrders.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] text-gray-500 bg-[#1a1d27] border-b border-[#2a2d3a] font-medium">
              Other symbols
            </div>
            {otherOrders.map((o) => (
              <OrderCard
                key={o.order_id}
                order={o}
                onNavigate={handleNavigate}
                isActiveSymbol={false}
                currentPrice={0}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
