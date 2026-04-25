---
name: react-component
description: Guidelines for creating React components in this project. Covers TypeScript props, Tailwind styling, Zustand store integration, accessibility, and file placement. Use when adding any new UI component.
argument-hint: "Add a strategy card component that shows symbol, status, and action buttons"
---

# React Component

## When to Use

- Adding a new UI component (page, panel, card, form, button group)
- Refactoring an existing component into smaller parts
- Adding a new route/page to the app

## Key Principles

- **TypeScript strict mode** — all props must have explicit interfaces. No `any`. Use `type` for unions, `interface` for component props.
- **Functional components only** — no class components. Use hooks for state/effects.
- **Tailwind CSS** — all styling via Tailwind utility classes. No CSS files, no inline `style={}` objects. Dark theme: bg `[#0f1117]` base, gray-400 text, borders `border-gray-700`.
- **Zustand for shared state** — never lift state to a parent just for sharing. If two components need the same data, put it in a store.
- **Local state for local concerns** — form inputs, hover states, expand/collapse — `useState` is fine.
- **No prop drilling** — if a prop passes through more than one intermediate component, use a store or context.
- **Default exports for components** — `export default function ComponentName()`. Named exports (`export function`) for hooks and utilities.

## Checklist

- [ ] 1. Define props interface in the same file (or `types/` if shared)
- [ ] 2. Create component file in `src/components/` (or subdirectory for feature groups)
- [ ] 3. Use Tailwind classes — follow existing dark-theme color conventions
- [ ] 4. Connect to Zustand stores via selector functions (narrow selectors, avoid full-store subscriptions)
- [ ] 5. Add to parent component or router
- [ ] 6. Verify TypeScript compiles: `tsc -b` from `chart-ui/`

## File Placement

| Component type | Location |
|---------------|----------|
| Page-level (route) | `src/components/` or `src/pages/` |
| Feature sub-component | `src/components/<feature>/` |
| Shared/reusable | `src/components/common/` |

## Props Pattern

```tsx
interface StrategyCardProps {
  symbol: string;
  status: 'on' | 'off' | 'paused';
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}

export default function StrategyCard({ symbol, status, onStart, onStop, onRemove }: StrategyCardProps) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
      {/* ... */}
    </div>
  );
}
```

## Zustand Store Integration

```tsx
// Narrow selector — component re-renders only when this slice changes
const strategies = useDashboardStore((s) => s.strategies);

// WRONG — subscribes to entire store, re-renders on any change
const store = useDashboardStore();
```

## Conditional Rendering

```tsx
// Prefer early return for auth/loading gates
if (loading) return <Spinner />;
if (!authenticated) return <LoginPage />;

// Inline ternary for small toggles
{isExpanded ? <Details /> : <Summary />}

// Logical AND for optional panels (existing pattern in App.tsx)
{sidebarPanel === 'openOrders' && <OpenOrdersPanel />}
```

## Common Pitfalls

1. **Don't import from `react` what you don't use** — `verbatimModuleSyntax` is enforced; unused imports cause build errors.
2. **Use `type` imports for type-only** — `import type { Foo } from './types'` not `import { Foo }`.
3. **Don't wrap in `React.memo` by default** — only when you've measured a re-render problem.
4. **Button handlers** — always `type="button"` to prevent accidental form submission.

## Reference Files

| What | Where |
|------|-------|
| Existing components | `chart-ui/src/components/` |
| Types | `chart-ui/src/types/` |
| Stores | `chart-ui/src/store/` |
| Tailwind entry | `chart-ui/src/index.css` |
| App shell | `chart-ui/src/App.tsx` |
