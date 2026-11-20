import { describe, expect, it } from 'vitest';
import { type ProfileDraft, type SavedProfileFields, buildProfilePatch } from '../profilePatch';

const saved: SavedProfileFields = {
  name: 'Alice',
  phone: '+14155552671',
  stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
  avatar_url: 'https://cdn.example.com/a.jpg',
};

const draftFrom = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: saved.name ?? '',
  phone: saved.phone ?? '',
  stellarAddress: saved.stellar_address ?? '',
  avatarUrl: saved.avatar_url ?? null,
  ...over,
});

describe('buildProfilePatch', () => {
  it('sends nothing when the user changed nothing', () => {
    expect(buildProfilePatch(saved, draftFrom())).toEqual({ ok: true, changed: false });
  });

  it('sends only the changed field, so unrelated values are not overwritten', () => {
    const r = buildProfilePatch(saved, draftFrom({ name: 'Bob' }));
    expect(r).toEqual({ ok: true, changed: true, body: { name: 'Bob' } });
  });

  it('treats an untouched optional field as absent, not as an empty string', () => {
    const r = buildProfilePatch(
      { name: 'A' },
      { name: 'B', phone: '', stellarAddress: '', avatarUrl: null }
    );
    expect(r).toEqual({ ok: true, changed: true, body: { name: 'B' } });
  });

  it('clears a previously set optional field with an explicit null', () => {
    const r = buildProfilePatch(saved, draftFrom({ phone: '  ' }));
    expect(r).toEqual({ ok: true, changed: true, body: { phone: null } });
  });

  it('rejects a blank name rather than sending an empty one', () => {
    const r = buildProfilePatch(saved, draftFrom({ name: '   ' }));
    expect(r).toEqual({ ok: false, errors: { name: 'Name is required.' } });
  });

  it('validates phone and Stellar address with the API rules', () => {
    const r = buildProfilePatch(saved, draftFrom({ phone: '123', stellarAddress: 'GABC' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['phone', 'stellarAddress']);
  });

  it('accepts a valid wallet change', () => {
    const next = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const r = buildProfilePatch(saved, draftFrom({ stellarAddress: next }));
    expect(r).toEqual({ ok: true, changed: true, body: { stellar_address: next } });
  });

  it('refuses local image data instead of sending a data URL the server cannot store', () => {
    const r = buildProfilePatch(saved, draftFrom({ avatarUrl: 'data:image/jpeg;base64,AAAA' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.avatarUrl).toBeDefined();
  });

  it('includes the concurrency token only when there is a change', () => {
    const none = buildProfilePatch(saved, draftFrom(), '2026-01-01T00:00:00Z');
    expect(none).toEqual({ ok: true, changed: false });
    const some = buildProfilePatch(saved, draftFrom({ name: 'Bob' }), '2026-01-01T00:00:00Z');
    expect(some).toEqual({
      ok: true,
      changed: true,
      body: { name: 'Bob', expected_updated_at: '2026-01-01T00:00:00Z' },
    });
  });
});
