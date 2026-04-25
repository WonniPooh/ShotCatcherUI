---
name: vitest-testing
description: Guidelines for writing tests with Vitest and React Testing Library. Covers unit tests for stores/hooks, component tests with user interactions, WS mocking, and test organization. Use when writing any test for the UI.
argument-hint: "Write tests for the dashboardStore — add/remove/update strategies and WS event handling"
---

# Vitest Testing

## When to Use

- Writing tests for Zustand stores (state logic, WS event handling)
- Writing tests for React components (rendering, user interaction)
- Writing tests for utility functions
- Writing tests for WS hooks (connection, reconnect, message routing)

## Prerequisites

Vitest (`^4.1.2`) is installed. For component testing, also install:
```bash
npm i -D @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Add test script to `package.json` if missing:
```json
"scripts": {
  "test": "vitest",
  "test:run": "vitest run"
}
```

Vitest auto-discovers `vite.config.ts` — no separate vitest config file needed.

## Key Principles

- **Test behavior, not implementation** — test what the user sees and what the store produces, not internal method calls.
- **Zustand stores are pure functions** — test them without React. Call actions directly, assert state.
- **React Testing Library for components** — query by role, text, label. Never query by class name or test ID unless no semantic alternative exists.
- **Mock WebSocket, not stores** — when testing WS hooks, mock the WebSocket class. When testing components, mock the store if needed.
- **Each test file mirrors its source** — `src/store/dashboardStore.ts` → `src/__tests__/dashboardStore.test.ts`.
- **Fast and isolated** — no network calls, no timers (use `vi.useFakeTimers()`), reset stores between tests.

## Checklist

- [ ] 1. Create test file in `src/__tests__/` (matches existing convention)
- [ ] 2. Import from `vitest` (`describe`, `it`, `expect`, `vi`, `beforeEach`)
- [ ] 3. Reset store state before each test
- [ ] 4. Test each action and edge case
- [ ] 5. Run: `npx vitest run` from `chart-ui/`
- [ ] 6. Verify no type errors: `tsc -b`

## Store Testing

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardStore } from '../store/dashboardStore';

describe('dashboardStore', () => {
  beforeEach(() => {
    // Reset to initial state between tests
    useDashboardStore.setState({
      strategies: [],
      engineState: 'idle',
      workerConnected: false,
    });
  });

  it('adds a strategy', () => {
    const { addStrategy } = useDashboardStore.getState();
    addStrategy({ symbol: 'BTCUSDT', direction: 'LONG', /* ... */ });

    const { strategies } = useDashboardStore.getState();
    expect(strategies).toHaveLength(1);
    expect(strategies[0].symbol).toBe('BTCUSDT');
    expect(strategies[0].status).toBe('off');
  });

  it('removes a strategy', () => {
    useDashboardStore.setState({
      strategies: [{ symbol: 'BTCUSDT', status: 'off', config: {} as any }],
    });

    useDashboardStore.getState().removeStrategy('BTCUSDT');
    expect(useDashboardStore.getState().strategies).toHaveLength(0);
  });

  it('handles strategy_update event', () => {
    useDashboardStore.setState({
      strategies: [{ symbol: 'ADAUSDT', status: 'off', config: {} as any }],
    });

    useDashboardStore.getState().applyWorkerEvent({
      type: 'strategy_update',
      symbol: 'ADAUSDT',
      status: 'on',
    });

    expect(useDashboardStore.getState().strategies[0].status).toBe('on');
  });
});
```

## Component Testing

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StrategyCard from '../components/dashboard/StrategyCard';

describe('StrategyCard', () => {
  it('renders symbol and status', () => {
    render(
      <StrategyCard
        symbol="BTCUSDT"
        status="on"
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getByText(/on/i)).toBeInTheDocument();
  });

  it('calls onStop when stop button clicked', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <StrategyCard
        symbol="BTCUSDT"
        status="on"
        onStart={vi.fn()}
        onStop={onStop}
        onRemove={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
```

## WebSocket Mocking

```ts
import { vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket globally
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = WebSocket.CONNECTING;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();
  close = vi.fn();

  // Test helper: simulate server message
  simulateMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  // Test helper: simulate connection open
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
```

## Timer Testing (reconnect logic)

```ts
import { vi } from 'vitest';

vi.useFakeTimers();

// ... trigger disconnect ...

// Advance past reconnect delay
vi.advanceTimersByTime(1000);

// Assert reconnection attempted
expect(MockWebSocket.instances).toHaveLength(2);

vi.useRealTimers();
```

## Test Organization

```
src/__tests__/
  dashboardStore.test.ts     ← store logic
  StrategyCard.test.tsx      ← component rendering + interaction
  useWorkerStream.test.ts    ← WS hook
  strategyValidation.test.ts ← utility functions
```

## Running Tests

```bash
# From chart-ui directory
npx vitest run              # single run
npx vitest                  # watch mode
npx vitest run --coverage   # with coverage
```

## Common Pitfalls

1. **Don't forget to reset stores** — Zustand stores persist across tests. Always reset in `beforeEach`.
2. **Don't test Zustand internals** — test `getState()` results, not the internal `set()` calls.
3. **Don't use `getByTestId` as first choice** — prefer `getByRole`, `getByText`, `getByLabelText`.
4. **Don't forget `@testing-library/jest-dom`** — needed for `toBeInTheDocument()` matcher. Install it and import in test setup.
5. **Async actions** — use `await` or `waitFor` for store actions that do fetches.
6. **Prefer `userEvent` over `fireEvent`** — `@testing-library/user-event` simulates real browser behavior (focus, blur, typing). `fireEvent` is low-level.

## Reference Files

| What | Where |
|------|-------|
| Existing tests | `chart-ui/src/__tests__/` |
| Vitest config | Inherits from `chart-ui/vite.config.ts` |
| Package scripts | `chart-ui/package.json` → `"test": "vitest"` (add if missing) |
