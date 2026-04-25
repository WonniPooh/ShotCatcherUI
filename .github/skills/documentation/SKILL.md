---
name: documentation
description: Documentation standards for the UI project. Covers code comments, JSDoc, README structure, type documentation, and decision records. Apply when adding or updating documentation.
argument-hint: "Document the dashboard WS protocol and component API"
---

# Documentation

## Philosophy

- **Code should be self-documenting** — good names > comments. Don't comment what, comment why.
- **Types are documentation** — a well-typed interface tells you more than a paragraph.
- **Document decisions, not mechanics** — "we use Zustand because..." matters more than "this calls set()".
- **Keep docs near the code** — inline comments, JSDoc on exports, README in the feature folder.

## When to Write Comments

### DO comment:
- **Why** something is done a non-obvious way
- **Business rules** that aren't obvious from the code
- **Workarounds** with a link to the issue/limitation
- **Constants** that have domain meaning

```ts
// Worker can hold max ~200 strategies before memory pressure.
// We cap the UI at 100 to leave headroom.
const MAX_STRATEGIES = 100;

// Binance returns leverage as integer, but we need to handle
// the special value 0 which means "exchange maximum"
if (leverage === 0) { /* ... */ }
```

### Do NOT comment:
- What the code literally does (`// increment counter` before `count++`)
- Types that are already expressed in TypeScript
- Obvious function behavior (`// returns the sum` before `return a + b`)

## JSDoc — On Exported Functions and Hooks

```ts
/**
 * Persistent WebSocket connection to the worker control server.
 * Reconnects automatically with exponential backoff.
 * Routes incoming messages to the dashboard store.
 *
 * @returns send - function to send commands to the worker
 */
export function useWorkerStream(): { send: (msg: Record<string, unknown>) => void } {
```

```ts
/**
 * Validate a strategy config before sending to the worker.
 * Returns null if valid, or an error message string.
 */
export function validateStrategy(config: StrategyConfig): string | null {
```

### When to use JSDoc:
- Exported hooks (describe behavior + return value)
- Exported utility functions (describe purpose + params + return)
- Complex store actions (describe side effects)
- Types with non-obvious fields (use `/** */` on the field)

### When NOT to use JSDoc:
- Internal/private functions with obvious behavior
- Component props (the TypeScript interface IS the documentation)
- Simple getters/setters

## Type Documentation

Document non-obvious fields directly on the interface:

```ts
export interface StrategyConfig {
  /** Distance from market price to place entry order (%). E.g. 0.10 = 10 bps. */
  entry_distance_pct: number;

  /** Dead zone — order not adjusted unless price drifts more than this %. */
  buffer_pct: number;

  /** Force-close position after this many ms. null = hold indefinitely. */
  position_max_age_ms: number | null;

  /**
   * Sizing: set exactly ONE of these three.
   * - quantity: fixed base-asset units (e.g. 60 ADA)
   * - quantity_usdt: full notional in USDT
   * - quantity_margin_usdt: margin collateral in USDT
   */
  quantity?: number;
  quantity_usdt?: number;
  quantity_margin_usdt?: number;
}
```

## README Files

Each feature directory should have a brief README if it's non-trivial:

```
src/components/dashboard/
  README.md          ← what this feature does, key components, data flow
  DashboardPage.tsx
  StrategyCard.tsx
  StrategyForm.tsx
  GlobalControls.tsx
```

README template:
```markdown
# Dashboard

Strategy management UI — configure, start, stop, and monitor trading strategies.

## Components

- `DashboardPage` — top-level page, mounts WS hook, layout
- `StrategyCard` — per-symbol card with status + controls
- `StrategyForm` — config form for adding/editing strategies
- `GlobalControls` — engine controls, start/stop all, emergency

## Data Flow

Browser ←→ /ws/dashboard ←→ ui-server ←→ worker

## Store

`dashboardStore` — strategies list, engine state, worker connection status
```

## Commit Messages

Follow conventional commits for the UI work:

```
feat(dashboard): add strategy card component
fix(dashboard): handle WS reconnect on ticket expiry
refactor(store): split dashboardStore actions
test(dashboard): add store tests for strategy lifecycle
docs(dashboard): add README for dashboard components
```

## Decision Records

For non-obvious architectural decisions, add a brief note in `docs/`:

```markdown
## Why Zustand over Redux/Context

- Single-developer project — Redux ceremony isn't justified
- Zustand works outside React (stores callable from WS handlers)
- Minimal boilerplate, TypeScript-first
- Already adopted for chart stores
```

Keep it short — 3-5 bullet points explaining the tradeoff.

## Updating Documentation

When changing behavior:
1. Update JSDoc on changed functions
2. Update type comments if field semantics change
3. Update feature README if component structure changes
4. Update `docs/system-architecture.md` if data flow or protocol changes
5. Don't create separate change-log docs — git history serves that purpose
