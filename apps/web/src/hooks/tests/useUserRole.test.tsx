import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useUserRole } from '../useUserRole';

function RoleProbe() {
  const role = useUserRole();
  return <div data-testid="role">{role ?? 'none'}</div>;
}

const renderProbe = () =>
  render(
    <AuthProvider>
      <RoleProbe />
    </AuthProvider>
  );

describe('useUserRole (server-owned role, #916)', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'tok');
    localStorage.setItem('user', JSON.stringify({ id: 'u1', email: 'a@b.c', role: 'admin' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores a forged admin role in localStorage and shows the server role', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1', role: 'tenant' }), { status: 200 })
    );
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('role').textContent).toBe('tenant'));
    expect(JSON.parse(localStorage.getItem('user') ?? '{}').role).toBe('tenant');
  });

  it('grants no role while the server cannot be reached, even if storage says admin', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    renderProbe();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('role').textContent).toBe('none'));
  });

  it('clears the session when the server rejects the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    renderProbe();
    await waitFor(() => expect(localStorage.getItem('token')).toBeNull());
    expect(screen.getByTestId('role').textContent).toBe('none');
  });
});
