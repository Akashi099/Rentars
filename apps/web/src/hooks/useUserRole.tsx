'use client';

import type { User, UserRole } from '@/types/roles';
import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  logout: () => void;
  /** Re-reads identity and role from the server. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

/**
 * Role is never trusted from localStorage: anything stored there is editable
 * by the user. The role shown in the UI is whatever GET /api/auth/me returns
 * for the current token, so a tampered `user.role` has no effect (#916).
 */
function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    return { ...parsed, role: undefined as unknown as UserRole };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setUser(null);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        clearSession();
        return;
      }
      if (!res.ok) {
        // Unknown server state: keep the session but grant no role.
        setUser((prev) =>
          prev ? { ...prev, role: undefined as unknown as UserRole } : readStoredUser()
        );
        return;
      }
      const server = (await res.json()) as { id: string; role: UserRole };
      const stored = readStoredUser();
      const next: User = {
        ...(stored ?? ({} as User)),
        id: server.id,
        role: server.role as UserRole,
      };
      localStorage.setItem('user', JSON.stringify(next));
      setUser(next);
    } catch {
      setUser((prev) =>
        prev ? { ...prev, role: undefined as unknown as UserRole } : readStoredUser()
      );
    }
  }, [clearSession]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Show stored identity immediately, without its role, then confirm with the server.
      const stored = localStorage.getItem('token') ? readStoredUser() : null;
      if (!cancelled) setUser(stored);
      await refresh();
      if (!cancelled) setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const logout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  return (
    <AuthContext.Provider value={{ user, isLoading, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

export function useUserRole(): UserRole | null {
  const { user } = useAuth();
  return user?.role || null;
}
