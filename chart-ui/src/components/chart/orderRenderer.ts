/**
 * Order Trace Renderer — draws order polylines and end markers on canvas.
 *
 * Pure rendering functions: take canvas context + coordinate mappers,
 * draw order traces. No state management.
 */
import type { OrderTrace, OrderEndMarker } from '../../types/orders';
import { ORDER_TYPE_COLORS, ORDER_COLOR_DEFAULT } from '../../types/orders';

/** Coordinate mapper: time (ms) → x pixel */
type ToX = (time: number) => number;
/** Coordinate mapper: price → y pixel */
type ToY = (price: number) => number;

interface RenderContext {
  ctx: CanvasRenderingContext2D;
  toX: ToX;
  toY: ToY;
  chartW: number;   // drawable width (excluding Y-axis)
  drawH: number;    // drawable height (excluding X-axis)
  viewportFrom: number;  // ms
  viewportTo: number;    // ms
}

function getTraceColor(orderType: string): string {
  return ORDER_TYPE_COLORS[orderType] ?? ORDER_COLOR_DEFAULT;
}

/**
 * Render all order traces on the canvas.
 */
export function renderOrderTraces(
  rc: RenderContext,
  traces: OrderTrace[],
): void {
  if (traces.length === 0) return;

  const { ctx } = rc;
  ctx.save();

  for (const trace of traces) {
    renderSingleTrace(rc, trace);
  }

  ctx.restore();
}

/**
 * Render a single order trace: dashed polyline segments + end marker.
 */
function renderSingleTrace(rc: RenderContext, trace: OrderTrace): void {
  const { ctx, toX, toY, chartW, drawH, viewportFrom, viewportTo } = rc;
  const color = getTraceColor(trace.orderType);

  if (trace.segments.length === 0) return;

  // Draw dashed horizontal segments with vertical connectors
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.globalAlpha = 0.8;

  let prevEndX: number | null = null;
  let prevEndY: number | null = null;

  for (const seg of trace.segments) {
    // Clamp segment to viewport
    const segStart = Math.max(seg.startTime, viewportFrom);
    const segEnd = seg.endTime === Infinity
      ? viewportTo + (viewportTo - viewportFrom) * 0.05
      : Math.min(seg.endTime, viewportTo);

    if (segStart > viewportTo || segEnd < viewportFrom) {
      // Segment is outside viewport, but track position for connectors
      prevEndX = toX(seg.endTime === Infinity ? viewportTo : seg.endTime);
      prevEndY = toY(seg.price);
      continue;
    }

    const x1 = Math.max(0, Math.min(chartW, toX(segStart)));
    const x2 = Math.max(0, Math.min(chartW, toX(segEnd)));
    const y = toY(seg.price);

    // Vertical connector from previous segment
    if (prevEndX !== null && prevEndY !== null && Math.abs(prevEndY - y) > 0.5) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x1, prevEndY);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.8;
    }

    // Horizontal dashed segment
    if (y >= -2 && y <= drawH + 2) {
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
    }

    prevEndX = x2;
    prevEndY = y;
  }

  ctx.setLineDash([]);
  ctx.globalAlpha = 1.0;

  // Draw end marker
  if (trace.endMarker) {
    renderEndMarker(rc, trace.endMarker, color);
  }
}

/**
 * Render an end marker (fill triangle or cancel X).
 */
function renderEndMarker(
  rc: RenderContext,
  marker: OrderEndMarker,
  traceColor: string,
): void {
  const { ctx, toX, toY, chartW, drawH, viewportFrom, viewportTo } = rc;

  if (marker.time < viewportFrom || marker.time > viewportTo) return;

  const mx = toX(marker.time);
  const my = toY(marker.price);

  if (mx < -20 || mx > chartW + 20 || my < -20 || my > drawH + 20) return;

  const MH = 12;  // triangle height
  const MW = 7;   // triangle half-width

  if (marker.type === 'cancel') {
    // Draw X marker
    const size = 6;
    ctx.strokeStyle = '#6b7280';  // gray
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - size, my - size);
    ctx.lineTo(mx + size, my + size);
    ctx.moveTo(mx + size, my - size);
    ctx.lineTo(mx - size, my + size);
    ctx.stroke();
  } else {
    // Draw fill triangle
    const isBuy = marker.side === 'BUY';
    const fillColor = marker.type === 'entry_fill' ? '#16a34a' : '#dc2626';

    ctx.beginPath();
    if (isBuy) {
      // Up triangle — tip points up
      ctx.moveTo(mx, my - MH / 2);
      ctx.lineTo(mx - MW, my + MH / 2);
      ctx.lineTo(mx + MW, my + MH / 2);
    } else {
      // Down triangle — tip points down
      ctx.moveTo(mx, my + MH / 2);
      ctx.lineTo(mx - MW, my - MH / 2);
      ctx.lineTo(mx + MW, my - MH / 2);
    }
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}
