import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import ProfileManagement from '../ProfileManagement';

const profile = {
  user_id: 'u1',
  name: 'Alice',
  phone: '+14155552671',
  stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
  avatar_url: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  completeness: { score: 50, maxScore: 100, missingFields: [] },
};

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ProfileManagement save behaviour (#918)', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'tok');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('sends only the edited field plus the concurrency token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ ...profile, name: 'Bob' }));
    render(<ProfileManagement profile={profile} />);

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ name: 'Bob', expected_updated_at: '2026-01-01T00:00:00.000Z' });
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('stellar_address');
  });

  it('does not call the API when nothing changed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<ProfileManagement profile={profile} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/no changes to save/i)).toBeTruthy();
  });

  it('blocks a blank name locally and marks the field invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<ProfileManagement profile={profile} />);

    const name = screen.getByLabelText(/full name/i);
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(name.getAttribute('aria-invalid')).toBe('true');
  });

  it('on a conflict, adopts the server values instead of overwriting them', async () => {
    const current = { ...profile, name: 'Carol', updated_at: '2026-02-02T00:00:00.000Z' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ error: 'conflict', current }, 409));
    render(<ProfileManagement profile={profile} />);

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/updated elsewhere/i)).toBeTruthy();
    expect((screen.getByLabelText(/full name/i) as HTMLInputElement).value).toBe('Carol');
  });

  it('does not show a private address field the API cannot store', () => {
    render(<ProfileManagement profile={profile} />);
    expect(screen.queryByLabelText(/^address$/i)).toBeNull();
  });
});
