import type { ChartState, TradeDot } from './types';
import { bisectLeft, chooseTickInterval, formatTimeLabel, formatPriceAxis, formatDuration } from './utils';
import { renderOrderTraces } from './orderRenderer';
import {
  GREEN, RED, BG, GRID_COLOR, TEXT_COLOR, DOT_RADIUS,
  X_AXIS_HEIGHT, Y_AXIS_WIDTH, STABLE_LAG_S, LIVE_Y_BUFFER,
} from './constants';

// DEBUG: module load proof — if you don't see this, Vite is serving a cached version
console.log('[canvasRenderer] MODULE LOADED — fresh version with markers');

/** Format time for crosshair: always H:M:S.mmm for ms-precision readout. */
function formatCrosshairTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const msec = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${msec}`;
}

export function renderDotsCanvas(state: ChartState, canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio ?? 1;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w === 0 || h === 0) return;

  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Whole-canvas clear + background (covers KlineCharts beneath)
  ctx.clearRect(0, 0, bw, bh);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, bw, bh);

  // `chartW` = area reserved for the dot plot; right side is Y-axis labels
  const chartW = w - Y_AXIS_WIDTH;
  const drawH  = h - X_AXIS_HEIGHT;
  if (chartW <= 0 || drawH <= 0) return;

  const all = state.tradeDots;

  // --- Viewport (ms) ---
  // When browsing (not live), clamp toTime to just past the latest dot so the
  // viewport does not extend into empty future space (prevents snake/drift).
  const rawFrom = state.viewport.fromTime;
  const rawTo   = state.viewport.toTime;
  const rawSpan = rawTo - rawFrom;
  const latestDotTime = all.length > 0 ? all[all.length - 1].time : rawTo;
  // When browsing, clamp the right edge so the viewport can't drift into empty future.
  // Allow up to 20% of the viewport span past the latest dot for forward space.
  const forwardMargin = rawSpan * 0.2;
  const toTime   = state.autoScroll ? rawTo : Math.min(rawTo, latestDotTime + forwardMargin);
  const fromTime = state.autoScroll ? rawFrom : toTime - rawSpan;
  const viewSpan = toTime - fromTime;
  if (viewSpan <= 0) return;

  // --- X mapping ---
  const toX = (t: number) => ((t - fromTime) / viewSpan) * chartW;

  // --- Viewport culling ---
  const startIdx = Math.max(0, bisectLeft(all, fromTime) - 1);
  const endIdx   = Math.min(all.length, bisectLeft(all, toTime) + 2);
  const visible  = all.slice(startIdx, endIdx);

  // --- Compute visible price range for Y-axis ---
  let priceMin: number, priceMax: number;
  if (visible.length === 0) {
    priceMin = 0; priceMax = 1;
  } else {
    let lo = visible[0].value, hi = lo;
    for (const d of visible) {
      if (d.value < lo) lo = d.value;
      if (d.value > hi) hi = d.value;
    }
    // Add vertical pan offset to priceMin/Max AFTER buffer calc so the
    // visible span stays constant while panning (not compressed by offset).
    // Apply vertZoomFactor: >1 = zoomed in (tighter range), <1 = zoomed out (wider range)
    const base = hi - lo || Math.abs(lo) * 0.01 || 1;
    const center = (hi + lo) / 2;
    const halfRange = (base * (1 + 2 * LIVE_Y_BUFFER)) / (2 * state.vertZoomFactor);
    priceMin = center - halfRange + state.vertPanOffset;
    priceMax = center + halfRange + state.vertPanOffset;
  }
  // Store for coordinate-conversion use outside this function (useDrawings)
  state.priceMin = priceMin;
  state.priceMax = priceMax;

  const priceSpan = priceMax - priceMin;
  const toY = (price: number): number =>
    drawH * (1 - (price - priceMin) / priceSpan);

  ctx.save();
  ctx.scale(dpr, dpr);

  // --- Vertical grid lines (time) ---
  const tickIntervalSec = chooseTickInterval(viewSpan / 1000);
  const tickIntervalMs  = tickIntervalSec * 1000;
  const firstTick = Math.ceil(fromTime / tickIntervalMs) * tickIntervalMs;

  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  for (let tick = firstTick; tick <= toTime; tick += tickIntervalMs) {
    const x = Math.round(toX(tick)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, drawH);
    ctx.stroke();
  }

  // --- Horizontal grid lines + Y-axis labels ---
  const numYTicks = 6;
  ctx.font = '11px monospace';
  for (let i = 0; i <= numYTicks; i++) {
    const frac  = i / numYTicks;
    const price = priceMin + frac * priceSpan;
    const y     = Math.round(drawH * (1 - frac)) + 0.5;
    // Horizontal gridline
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();
    // Y-axis label
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatPriceAxis(price, priceSpan), w - 4, y);
  }

  // --- Y-axis separator ---
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartW + 0.5, 0);
  ctx.lineTo(chartW + 0.5, drawH);
  ctx.stroke();

  // --- Draw trade dots with LOD ---
  if (visible.length > 0) {
    let displayDots: TradeDot[];
    const maxDots = Math.round(chartW * 2);

    if (visible.length > maxDots) {
      displayDots = [];
      const bucketCount = Math.ceil(chartW);
      const bucketTimeSpanRaw = viewSpan / bucketCount;
      const mag = Math.pow(10, Math.floor(Math.log10(bucketTimeSpanRaw)));
      const bucketTimeSpan = Math.max(0.1, Math.round(bucketTimeSpanRaw / mag) * mag);

      if (Math.abs(state.lodCacheBucketSpan - bucketTimeSpan) / bucketTimeSpan > 0.01) {
        state.lodCache.clear();
        state.lodCacheBucketSpan = bucketTimeSpan;
      }

      const latestTime = all.length > 0 ? all[all.length - 1].time : 0;
      const stableLODCutoffMs = latestTime - STABLE_LAG_S * 1000;
      const firstBucketStart = Math.floor(fromTime / bucketTimeSpan) * bucketTimeSpan;
      let vi = 0;

      for (let bStart = firstBucketStart; bStart < toTime; bStart += bucketTimeSpan) {
        const bEnd = bStart + bucketTimeSpan;
        const isStable = bEnd <= stableLODCutoffMs;

        if (isStable && state.lodCache.has(bStart)) {
          while (vi < visible.length && visible[vi].time < bEnd) vi++;
          displayDots.push(...state.lodCache.get(bStart)!);
          continue;
        }

        // Sample first, last, min-price, max-price per bucket.
        // Preserving extremums ensures order fill markers never float in "air"
        // when zoomed out — the candle-like OHLC shape is maintained.
        let firstDot: TradeDot | null = null;
        let lastDot: TradeDot | null = null;
        let minDot: TradeDot | null = null;
        let maxDot: TradeDot | null = null;
        let buyCnt = 0, sellCnt = 0;
        while (vi < visible.length && visible[vi].time < bEnd) {
          const dot = visible[vi];
          if (!firstDot) firstDot = dot;
          lastDot = dot;
          if (!minDot || dot.value < minDot.value) minDot = dot;
          if (!maxDot || dot.value > maxDot.value) maxDot = dot;
          if (dot.color === GREEN) buyCnt++; else sellCnt++;
          vi++;
        }

        if (!firstDot) continue;
        const bucketColor = buyCnt >= sellCnt ? GREEN : RED;
        // Collect unique dots (first, min, max, last) sorted by time
        const candidateSet = new Set<TradeDot>([firstDot]);
        if (minDot) candidateSet.add(minDot);
        if (maxDot) candidateSet.add(maxDot);
        if (lastDot) candidateSet.add(lastDot);
        const bucketDots: TradeDot[] = [...candidateSet]
          .sort((a, b) => a.time - b.time)
          .map(d => ({ ...d, color: bucketColor }));
        displayDots.push(...bucketDots);
        if (isStable) state.lodCache.set(bStart, bucketDots);
      }
    } else {
      displayDots = visible;
    }

    // Single-pass draw: connecting line then dots
    ctx.beginPath();
    ctx.strokeStyle = '#888888';
    ctx.lineWidth = 1;
    let lineStarted = false;
    for (const dot of displayDots) {
      const x = toX(dot.time);
      const y = toY(dot.value);
      if (!lineStarted) { ctx.moveTo(x, y); lineStarted = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (const dot of displayDots) {
      const x = toX(dot.time);
      const y = toY(dot.value);
      if (x < -DOT_RADIUS || x > chartW + DOT_RADIUS) continue;
      if (y < -DOT_RADIUS || y > drawH + DOT_RADIUS) continue;
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
    }
  }

  // --- X-axis separator ---
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, drawH + 0.5);
  ctx.lineTo(chartW, drawH + 0.5);
  ctx.stroke();

  // --- X-axis time labels ---
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let tick = firstTick; tick <= toTime; tick += tickIntervalMs) {
    const x = toX(tick);
    if (x < 0 || x > chartW) continue;
    ctx.fillText(formatTimeLabel(tick / 1000, tickIntervalSec), x, drawH + 4);
  }

  // --- Order trace overlays (dashed polylines + end markers) ---
  if (state.orderTraces && state.orderTraces.length > 0) {
    renderOrderTraces(
      { ctx, toX, toY, chartW, drawH, viewportFrom: fromTime, viewportTo: toTime },
      state.orderTraces,
    );
  }

  // --- Drawing overlays (hlines + ruler) ---
  if (state.drawings.length > 0) {
    const selId = state.selectedDrawingId;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    for (const drawing of state.drawings) {
      const isSel = drawing.id === selId;
      if (drawing.type === 'hline') {
        const y = toY(drawing.price);
        if (y < -2 || y > drawH + 2) continue;
        const drawY = Math.round(y) + 0.5;
        ctx.strokeStyle = isSel ? '#3b82f6' : '#eab308';
        ctx.beginPath();
        ctx.moveTo(0, drawY);
        ctx.lineTo(chartW, drawY);
        ctx.stroke();
        // Label tag on Y-axis
        ctx.setLineDash([]);
        ctx.fillStyle = '#b45309';
        const label = formatPriceAxis(drawing.price, priceSpan);
        const lw = ctx.measureText(label).width + 8;
        ctx.fillRect(chartW + 2, drawY - 9, lw, 18);
        ctx.fillStyle = '#fef3c7';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, chartW + 6, drawY);
        ctx.setLineDash([4, 4]);

        // "Del" badge on selected drawing
        if (isSel) {
          ctx.setLineDash([]);
          ctx.font = '10px monospace';
          const delLabel = 'Del ✕';
          const dlw = ctx.measureText(delLabel).width + 8;
          const dlx = chartW - dlw - 8;
          const dly = drawY - 18;
          ctx.fillStyle = 'rgba(59, 130, 246, 0.85)';
          ctx.beginPath();
          ctx.roundRect(dlx, dly, dlw, 16, 3);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(delLabel, dlx + 4, dly + 8);
          ctx.font = '11px monospace';
          ctx.setLineDash([4, 4]);
        }
      }
    }
    ctx.setLineDash([]);
  }

  // --- Markers (filled circles with arrow) ---
  // DEBUG: log once per second to prove this code runs
  if (!((window as any).__markerLogTs) || Date.now() - (window as any).__markerLogTs > 1000) {
    (window as any).__markerLogTs = Date.now();
  }
  if (state.markers.length > 0) {
    const MH = 14;   // triangle height
    const MW = 8;    // triangle half-width
    const MARKER_GREEN = '#16a34a';
    const MARKER_RED   = '#dc2626';
    for (const m of state.markers) {
      const mx = toX(m.time);
      const my = toY(m.price);
      if (mx < -MW || mx > chartW + MW || my < -MH || my > drawH + MH) continue;
      // Sharp triangle — tip points at the exact price
      ctx.beginPath();
      if (m.direction === 'up') {
        ctx.moveTo(mx, my);              // tip at price
        ctx.lineTo(mx - MW, my + MH);    // bottom-left
        ctx.lineTo(mx + MW, my + MH);    // bottom-right
      } else {
        ctx.moveTo(mx, my);              // tip at price
        ctx.lineTo(mx - MW, my - MH);    // top-left
        ctx.lineTo(mx + MW, my - MH);    // top-right
      }
      ctx.closePath();
      ctx.fillStyle = m.color === 'green' ? MARKER_GREEN : MARKER_RED;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // --- Ruler overlay (shift+drag measurement) ---
  if (state.ruler) {
    const { startPrice, startTime, endPrice, endTime } = state.ruler;
    const rx1 = toX(startTime);
    const ry1 = toY(startPrice);
    const rx2 = toX(endTime);
    const ry2 = toY(endPrice);
    ctx.save();
    ctx.fillStyle = 'rgba(234, 179, 8, 0.1)';
    ctx.fillRect(Math.min(rx1, rx2), Math.min(ry1, ry2), Math.abs(rx2 - rx1), Math.abs(ry2 - ry1));
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.min(rx1, rx2), Math.min(ry1, ry2), Math.abs(rx2 - rx1), Math.abs(ry2 - ry1));
    ctx.setLineDash([]);
    const pct = (endPrice - startPrice) / startPrice * 100;
    const tDiff = Math.abs(endTime - startTime);
    const rulerLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%  ${formatDuration(tDiff)}`;
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#fef08a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rulerLabel, (rx1 + rx2) / 2, (ry1 + ry2) / 2);
    ctx.restore();
  }
  const cx = state.cursorX;
  const cy = state.cursorY;
  if (cx != null && cy != null && cx >= 0 && cx <= chartW && cy >= 0 && cy <= drawH) {
    const cursorPrice = priceMin + (1 - cy / drawH) * priceSpan;
    const cursorMs    = fromTime + (cx / chartW) * viewSpan;
    const priceLabel  = formatPriceAxis(cursorPrice, priceSpan);
    const timeLabel   = formatCrosshairTime(cursorMs);

    ctx.save();
    ctx.strokeStyle = TEXT_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    // Vertical crosshair line
    const lineX = Math.round(cx) + 0.5;
    ctx.beginPath();
    ctx.moveTo(lineX, 0);
    ctx.lineTo(lineX, drawH);
    ctx.stroke();

    // Horizontal crosshair line
    const lineY = Math.round(cy) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, lineY);
    ctx.lineTo(chartW, lineY);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.font = '11px monospace';

    // Price badge on Y-axis strip
    const plw = ctx.measureText(priceLabel).width + 8;
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(chartW + 2, Math.round(cy) - 9, plw, 18);
    ctx.fillStyle = '#e0f2fe';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceLabel, chartW + 6, Math.round(cy));

    // Time badge on X-axis strip
    const tlw = ctx.measureText(timeLabel).width + 10;
    const tlx = Math.max(tlw / 2, Math.min(chartW - tlw / 2, Math.round(cx)));
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(tlx - tlw / 2, drawH + 2, tlw, 18);
    ctx.fillStyle = '#e0f2fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(timeLabel, tlx, drawH + 4);

    ctx.restore();
  }

  // --- Loading progress bar ---
  if (state.loadingProgress != null) {
    const pct = state.loadingProgress;
    const barW = Math.min(220, chartW * 0.4);
    const barH = 18;
    const barX = (chartW - barW) / 2;
    const barY = 12;
    const radius = 4;

    ctx.save();
    // Background
    ctx.fillStyle = 'rgba(30, 33, 48, 0.9)';
    ctx.beginPath();
    ctx.roundRect(barX - 6, barY - 4, barW + 12, barH + 8, radius + 2);
    ctx.fill();

    // Track
    ctx.fillStyle = 'rgba(55, 60, 80, 0.8)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, radius);
    ctx.fill();

    // Fill
    const fillW = Math.max(0, (pct / 100) * barW);
    if (fillW > 0) {
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.roundRect(barX, barY, fillW, barH, radius);
      ctx.fill();
    }

    // Label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = state.loadingLabel || 'Loading';
    ctx.fillText(`${label} ${pct}%`, chartW / 2, barY + barH / 2);
    ctx.restore();
  }

  ctx.restore();
}
