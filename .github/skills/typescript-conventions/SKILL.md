---
name: typescript-conventions
description: TypeScript coding conventions for this project. Covers strict mode rules, type vs interface, imports, generics, error handling, and common patterns. Apply to ALL TypeScript code in the React frontend.
argument-hint: "Review this code for TypeScript best practices"
---

# TypeScript Conventions

## Strict Mode

This project runs `"strict": true` with additional flags:
- `noUnusedLocals` — no declared-but-unused variables
- `noUnusedParameters` — no unused function params (prefix with `_` to suppress)
- `verbatimModuleSyntax` — must use `import type` for type-only imports
- `noFallthroughCasesInSwitch` — every `case` must `break` or `return`
- `erasableSyntaxOnly` — no `enum`, no `namespace`, no parameter properties
- `noUncheckedSideEffectImports` — side-effect imports (`import './foo'`) must resolve to a real module

## Rules

1. **No `any`** — use `unknown` and narrow, or define a proper type. Only exception: test mocks where full typing adds no value (`as any` with a comment).
2. **`import type` for types** — enforced by `verbatimModuleSyntax`. Wrong: `import { Strategy } from './types'`. Right: `import type { Strategy } from './types'`.
3. **`interface` for object shapes, `type` for unions/aliases** — 
   ```ts
   interface StrategyCardProps { symbol: string; status: Status; }  // object shape
   type Status = 'on' | 'off' | 'paused';                          // union
   type Handler = (symbol: string) => void;                         // function alias
   ```
4. **No `enum`** — use union types or `as const` objects:
   ```ts
   // WRONG (enum not allowed with erasableSyntaxOnly)
   enum Direction { LONG, SHORT }
   
   // RIGHT
   type Direction = 'LONG' | 'SHORT';
   
   // RIGHT (if you need runtime values + exhaustive checking)
   const DIRECTIONS = ['LONG', 'SHORT'] as const;
   type Direction = (typeof DIRECTIONS)[number];
   ```
5. **Prefer `const` over `let`** — only use `let` when reassignment is needed.
6. **No non-null assertions (`!`)** — except `document.getElementById('root')!` in `main.tsx`. Everywhere else, handle null properly.
7. **Explicit return types on exported functions** — optional for components, required for utilities and store actions that return values.
8. **Nullability** — use `T | null` not `T | undefined` for intentional absence. `undefined` is for "not provided" (optional params).

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Components | PascalCase | `StrategyCard` |
| Hooks | camelCase, `use` prefix | `useWorkerStream` |
| Store hooks | camelCase, `use` + domain + `Store` | `useDashboardStore` |
| Types/Interfaces | PascalCase | `StrategyConfig`, `WorkerEvent` |
| Constants | SCREAMING_SNAKE or camelCase | `MAX_RECONNECT_DELAY`, `defaultConfig` |
| Files: components | PascalCase.tsx | `StrategyCard.tsx` |
| Files: hooks | camelCase.ts | `useWorkerStream.ts` |
| Files: stores | camelCase.ts | `dashboardStore.ts` |
| Files: types | camelCase.ts | `dashboard.ts` |
| Files: utils | camelCase.ts | `validation.ts` |

## Patterns

### Discriminated Unions for Messages

```ts
// Worker events use discriminated union on 'type' field
type WorkerEvent =
  | { type: 'strategy_update'; symbol: string; status: StrategyStatus }
  | { type: 'engine_ready' }
  | { type: 'engine_stopped'; reason?: string }
  | { type: 'error'; msg: string };

function handleEvent(event: WorkerEvent) {
  switch (event.type) {
    case 'strategy_update':
      // TypeScript knows event.symbol exists here
      break;
    case 'engine_ready':
      break;
    // ... exhaustive
  }
}
```

### Narrowing Unknown Data (WS messages)

```ts
function isStrategyUpdate(msg: unknown): msg is StrategyUpdateEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as Record<string, unknown>).type === 'strategy_update'
  );
}
```

### Optional Fields vs Nullable

```ts
interface StrategyConfig {
  position_max_age_ms: number | null;   // explicitly "no timeout" when null
  leverage_limit?: number;              // optional — may not be provided at all
}
```

### Record Types for Maps

```ts
// Status → CSS class mapping
const STATUS_COLORS: Record<StrategyStatus, string> = {
  on: 'text-green-400',
  off: 'text-gray-400',
  paused: 'text-yellow-400',
  stopped: 'text-red-400',
  removed: 'text-gray-600',
  error: 'text-red-500',
};
```

## Common Pitfalls

1. **Don't use `Object`** — use `Record<string, unknown>` or a specific interface.
2. **Don't use `Function`** — type the signature: `(symbol: string) => void`.
3. **Don't cast with `as` to bypass errors** — fix the type instead. `as` hides bugs.
4. **Don't use `@ts-ignore`** — use `@ts-expect-error` with a comment if truly needed (test mocks only).
5. **Don't mix `null` and `undefined`** — pick one per field and be consistent. JSON uses `null`.
6. **Don't forget `satisfies`** — use it for config objects to get both inference and checking:
   ```ts
   const defaults = {
     leverage: 10,
     direction: 'LONG',
   } satisfies Partial<StrategyConfig>;
   ```
