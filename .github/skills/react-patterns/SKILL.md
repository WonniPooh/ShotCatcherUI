---
name: react-patterns
description: General React patterns and anti-patterns for this project. Covers hooks rules, rendering performance, effect usage, event handling, forms, and common mistakes. Apply to all React code.
argument-hint: "Review this component for React best practices"
---

# React Patterns

## Hooks Rules (enforced by eslint-plugin-react-hooks)

1. **Only call hooks at the top level** — never inside conditions, loops, or nested functions.
2. **Only call hooks from React functions** — components or custom hooks, not plain functions.
3. **Exhaustive deps** — always list all dependencies in `useEffect` / `useCallback` / `useMemo` arrays. If the linter warns, fix the code, don't suppress.

## Effects — When to Use and When Not To

### Use `useEffect` for:
- WebSocket connections (connect on mount, close on unmount)
- Event listeners (`window.addEventListener`)
- Subscriptions to external data sources
- One-time initialization (auth check on mount)

### Do NOT use `useEffect` for:
- **Derived state** — compute in render or in a selector:
  ```tsx
  // WRONG
  const [filtered, setFiltered] = useState([]);
  useEffect(() => { setFiltered(items.filter(predicate)); }, [items]);

  // RIGHT — compute during render
  const filtered = items.filter(predicate);

  // RIGHT — compute in Zustand selector
  const filtered = useStore((s) => s.items.filter(predicate));
  ```
- **Responding to events** — handle in the event handler, not in an effect:
  ```tsx
  // WRONG
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (submitted) doSomething(); }, [submitted]);

  // RIGHT
  const handleSubmit = () => { doSomething(); };
  ```
- **Transforming data for rendering** — use `useMemo` if expensive, or just compute inline.

## Component Patterns

### Keep components small
- If a component is > 150 lines, split it.
- Extract sub-components for repeated patterns.
- Extract custom hooks for complex logic.

### Conditional rendering
```tsx
// Loading/error/data pattern
if (loading) return <Spinner />;
if (error) return <ErrorBanner message={error} />;
return <Content data={data} />;

// Toggle — use logical AND
{isOpen && <Modal />}

// Ternary for small swaps
{isEditing ? <Input /> : <Display />}
```

### Event handlers
```tsx
// Name handlers with 'handle' prefix
const handleClick = () => { /* ... */ };
const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  // ...
};

// Always type="button" for non-submit buttons
<button type="button" onClick={handleClick}>Cancel</button>
```

### Keys in lists
```tsx
// Use stable, unique IDs — NEVER array index
{strategies.map((s) => (
  <StrategyCard key={s.symbol} strategy={s} />
))}
```

## Forms

### Controlled inputs
```tsx
const [value, setValue] = useState('');
<input
  type="text"
  value={value}
  onChange={(e) => setValue(e.target.value)}
  className="bg-gray-800 text-white border border-gray-600 rounded px-3 py-2"
/>
```

### Number inputs
```tsx
// Always parse — input value is string
const [leverage, setLeverage] = useState(10);
<input
  type="number"
  min={1}
  max={125}
  value={leverage}
  onChange={(e) => setLeverage(Number(e.target.value))}
/>
```

### Form submission
```tsx
<form onSubmit={handleSubmit}>
  {/* inputs */}
  <button type="submit">Add Strategy</button>
</form>

const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
  // validate, then submit
};
```

### Select / dropdown
```tsx
<select
  value={direction}
  onChange={(e) => setDirection(e.target.value as 'LONG' | 'SHORT')}
  className="bg-gray-800 text-white border border-gray-600 rounded px-3 py-2"
>
  <option value="LONG">LONG</option>
  <option value="SHORT">SHORT</option>
</select>
```

## Performance — When to Optimize

### Don't optimize prematurely
- React 19 is fast. Don't add `useMemo`/`useCallback` everywhere.
- Use narrow Zustand selectors (already avoids most unnecessary re-renders).

### Optimize when:
- A list renders 50+ items and re-renders frequently → `useMemo` on the list
- A callback is passed to many child components → `useCallback`
- A computation is visibly slow (>16ms) → `useMemo`
- Profile first with React DevTools Profiler before adding optimization.

### Lazy loading
```tsx
// For route-level components (dashboard page, chart page)
import { lazy, Suspense } from 'react';
const DashboardPage = lazy(() => import('./components/DashboardPage'));

<Suspense fallback={<div className="text-gray-400">Loading...</div>}>
  <DashboardPage />
</Suspense>
```

## Anti-Patterns

1. **State for derived data** — if you can compute it from other state, don't store it separately.
2. **Effect chains** — effect A sets state → triggers effect B → sets state → triggers effect C. Restructure.
3. **Stale closures** — if an effect uses a value that changes, it must be in the dep array.
4. **God components** — 500-line components that do everything. Split into composition.
5. **Prop drilling past 2 levels** — use Zustand or context instead.
6. **`useEffect` for event responses** — handle events in event handlers, not effects.
7. **Fetching in effects without cleanup** — use AbortController or a flag to prevent stale responses.

## Accessibility Basics

- All interactive elements must be keyboard-accessible (buttons, not divs with onClick).
- Use semantic HTML: `<button>`, `<input>`, `<select>`, `<form>`, `<label>`.
- Labels on all form inputs: `<label>` element or `aria-label` attribute.
- Status indicators should have text, not just color (e.g., "ON" badge, not just green dot).
