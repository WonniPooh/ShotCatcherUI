import { describe, it, expect, beforeEach } from 'vitest';
import { useChartStore } from '../store/chartStore';

describe('chartStore sidebar', () => {
  beforeEach(() => {
    useChartStore.setState({
      sidebarPanel: null,
      pendingNavigation: null,
    });
  });

  it('sidebarPanel defaults to null', () => {
    expect(useChartStore.getState().sidebarPanel).toBeNull();
  });

  it('setSidebarPanel sets panel', () => {
    useChartStore.getState().setSidebarPanel('closedTrades');
    expect(useChartStore.getState().sidebarPanel).toBe('closedTrades');
  });

  it('toggleSidebarPanel opens panel', () => {
    useChartStore.getState().toggleSidebarPanel('closedTrades');
    expect(useChartStore.getState().sidebarPanel).toBe('closedTrades');
  });

  it('toggleSidebarPanel closes same panel', () => {
    useChartStore.getState().toggleSidebarPanel('closedTrades');
    useChartStore.getState().toggleSidebarPanel('closedTrades');
    expect(useChartStore.getState().sidebarPanel).toBeNull();
  });

  it('toggleSidebarPanel switches between panels (mutually exclusive)', () => {
    useChartStore.getState().toggleSidebarPanel('closedTrades');
    expect(useChartStore.getState().sidebarPanel).toBe('closedTrades');
    useChartStore.getState().toggleSidebarPanel('openOrders');
    expect(useChartStore.getState().sidebarPanel).toBe('openOrders');
  });

  it('pendingNavigation can be set and cleared', () => {
    useChartStore.getState().setPendingNavigation({ ts: 1234567890 });
    expect(useChartStore.getState().pendingNavigation).toEqual({ ts: 1234567890 });
    useChartStore.getState().setPendingNavigation(null);
    expect(useChartStore.getState().pendingNavigation).toBeNull();
  });
});
