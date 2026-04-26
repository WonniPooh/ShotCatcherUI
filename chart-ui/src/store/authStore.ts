/**
 * Auth store — tracks login state and provides WS ticket fetching.
 */
import { create } from 'zustand';

interface AuthState {
  authenticated: boolean;
  username: string | null;
  role: string | null;
  checking: boolean;

  /** Check current auth state (calls /api/auth/me) */
  checkAuth: () => Promise<void>;
  /** Login with username/password */
  login: (username: string, password: string) => Promise<string | null>;
  /** Logout */
  logout: () => Promise<void>;
  /** Get a short-lived WS ticket for authenticated WS connections */
  getWsTicket: () => Promise<string>;
}

export const useAuthStore = create<AuthState>((set, _get) => ({
  authenticated: false,
  username: null,
  role: null,
  checking: true,

  checkAuth: async () => {
    set({ checking: true });
    try {
      const resp = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (resp.ok) {
        const data = await resp.json();
        set({
          authenticated: data.authenticated,
          username: data.username,
          role: data.role,
          checking: false,
        });
      } else {
        set({ authenticated: false, username: null, role: null, checking: false });
      }
    } catch {
      set({ authenticated: false, username: null, role: null, checking: false });
    }
  },

  login: async (username, password) => {
    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      if (resp.ok) {
        const data = await resp.json();
        set({ authenticated: true, username: data.username, role: data.role });
        return null;  // success
      }
      const err = await resp.json().catch(() => ({ detail: 'Login failed' }));
      return err.detail || 'Login failed';
    } catch {
      return 'Network error';
    }
  },

  logout: async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    set({ authenticated: false, username: null, role: null });
  },

  getWsTicket: async () => {
    try {
      const resp = await fetch('/api/auth/ws-ticket', { credentials: 'same-origin' });
      if (resp.ok) {
        const data = await resp.json();
        return data.ticket as string;
      }
    } catch { /* fall through */ }
    return '';
  },
}));
