/**
 * Booking authorization policy tests (#739).
 *
 * Covers the operation-to-role matrix and the service boundary that enforces it:
 * tenants and hosts reach only their own bookings, only admins change or delete
 * bookings, denied privileged actions are audited, and role or identity values
 * that do not come from the signed JWT cannot grant access.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  BOOKING_OPERATION_POLICY,
  bookingAuthorizationService,
  type BookingActor,
} from '../../src/services/bookingAuthorization.service.js';
import { BookingService } from '../../src/services/booking.service.js';
import { auditLogger } from '../../src/services/auditLogger.service.js';
import { supabase } from '../../src/config/supabase.js';

const BOOKING_ID = '00000000-0000-4000-8000-000000000201';
const tenant: BookingActor = { id: 'tenant-1', role: 'user' };
const host: BookingActor = { id: 'host-1', role: 'user' };
const stranger: BookingActor = { id: 'stranger-1', role: 'user' };
const admin: BookingActor = { id: 'admin-1', role: 'admin' };

describe('BOOKING_OPERATION_POLICY', () => {
  it('limits update and delete to the admin role, regardless of ownership', () => {
    expect(BOOKING_OPERATION_POLICY.update).toEqual({ elevatedRoles: ['admin'], participants: false });
    expect(BOOKING_OPERATION_POLICY.delete).toEqual({ elevatedRoles: ['admin'], participants: false });
  });

  it('lets tenants and hosts read their own bookings and gives read-only roles read access', () => {
    for (const operation of ['read', 'read_status_history'] as const) {
      expect(BOOKING_OPERATION_POLICY[operation].participants).toBe(true);
      expect(BOOKING_OPERATION_POLICY[operation].elevatedRoles).toEqual([
        'admin',
        'moderator',
        'support',
        'finance',
      ]);
    }
  });
});

describe('bookingAuthorizationService.authorize', () => {
  let isTenant: ReturnType<typeof spyOn>;
  let isHost: ReturnType<typeof spyOn>;

  beforeEach(() => {
    isTenant = spyOn(bookingAuthorizationService, 'isTenant').mockResolvedValue(false);
    isHost = spyOn(bookingAuthorizationService, 'isHost').mockResolvedValue(false);
  });

  afterEach(() => {
    isTenant.mockRestore();
    isHost.mockRestore();
  });

  it('lets an admin read any booking without a database ownership lookup', async () => {
    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, admin);

    expect(decision).toEqual({ allowed: true });
    expect(isTenant).not.toHaveBeenCalled();
    expect(isHost).not.toHaveBeenCalled();
  });

  it.each(['moderator', 'support', 'finance'])('lets the %s role read any booking', async (role) => {
    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, {
      id: 'staff-1',
      role,
    });

    expect(decision).toEqual({ allowed: true });
  });

  it('lets the tenant read their own booking', async () => {
    isTenant.mockResolvedValue(true);

    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, tenant);

    expect(decision).toEqual({ allowed: true });
    expect(isTenant).toHaveBeenCalledWith(BOOKING_ID, tenant.id);
  });

  it('lets the host read a booking on their property', async () => {
    isHost.mockResolvedValue(true);

    const decision = await bookingAuthorizationService.authorize('read_status_history', BOOKING_ID, host);

    expect(decision).toEqual({ allowed: true });
  });

  it('returns 404 for a stranger reading a booking, so IDs cannot be probed', async () => {
    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, stranger);

    expect(decision).toEqual({ allowed: false, status: 404, reason: 'Booking not found' });
  });

  it.each([
    ['tenant', tenant],
    ['host', host],
    ['moderator', { id: 'mod-1', role: 'moderator' }],
    ['support', { id: 'support-1', role: 'support' }],
    ['finance', { id: 'finance-1', role: 'finance' }],
  ] as const)('denies the %s role an update, with 403 and no ownership lookup', async (_name, actor) => {
    isTenant.mockResolvedValue(true);
    isHost.mockResolvedValue(true);

    const decision = await bookingAuthorizationService.authorize('update', BOOKING_ID, actor);

    expect(decision).toEqual({
      allowed: false,
      status: 403,
      reason: 'Forbidden: requires one of [admin]',
    });
    expect(isTenant).not.toHaveBeenCalled();
    expect(isHost).not.toHaveBeenCalled();
  });

  it('denies a tenant a delete even on their own booking', async () => {
    isTenant.mockResolvedValue(true);

    const decision = await bookingAuthorizationService.authorize('delete', BOOKING_ID, tenant);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? undefined : decision.status).toBe(403);
  });

  it('lets an admin update and delete any booking', async () => {
    expect(await bookingAuthorizationService.authorize('update', BOOKING_ID, admin)).toEqual({
      allowed: true,
    });
    expect(await bookingAuthorizationService.authorize('delete', BOOKING_ID, admin)).toEqual({
      allowed: true,
    });
  });

  it('does not treat a role with different casing as elevated', async () => {
    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, {
      id: 'user-9',
      role: 'ADMIN',
    });

    expect(decision.allowed).toBe(false);
  });

  it('does not treat an unknown role as elevated', async () => {
    const decision = await bookingAuthorizationService.authorize('update', BOOKING_ID, {
      id: 'user-9',
      role: 'superuser',
    });

    expect(decision.allowed).toBe(false);
  });

  it('denies an actor with no identity', async () => {
    const decision = await bookingAuthorizationService.authorize('read', BOOKING_ID, {
      id: '',
      role: 'admin',
    });

    expect(decision.allowed).toBe(false);
  });
});

describe('BookingService privileged actions', () => {
  let service: BookingService;
  let audit: ReturnType<typeof spyOn>;
  let isTenant: ReturnType<typeof spyOn>;
  let isHost: ReturnType<typeof spyOn>;
  let fromSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    service = new BookingService();
    audit = spyOn(auditLogger, 'log').mockResolvedValue(undefined);
    isTenant = spyOn(bookingAuthorizationService, 'isTenant').mockResolvedValue(false);
    isHost = spyOn(bookingAuthorizationService, 'isHost').mockResolvedValue(false);
  });

  afterEach(() => {
    audit.mockRestore();
    isTenant.mockRestore();
    isHost.mockRestore();
    fromSpy?.mockRestore();
    fromSpy = undefined;
  });

  it('denies a tenant an update, returns 403, and audits the attempt without touching the row', async () => {
    fromSpy = spyOn(supabase, 'from');
    isTenant.mockResolvedValue(true);

    const result = await service.updateBooking(BOOKING_ID, { status: 'Confirmed' }, tenant);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(fromSpy).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: tenant.id,
        action: 'booking.modify',
        resourceType: 'booking',
        resourceId: BOOKING_ID,
        success: false,
      }),
    );
  });

  it('denies a host a delete, returns 403, and audits the attempt', async () => {
    fromSpy = spyOn(supabase, 'from');
    isHost.mockResolvedValue(true);

    const result = await service.deleteBooking(BOOKING_ID, host);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(fromSpy).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: host.id, action: 'booking.delete', success: false }),
    );
  });

  it('audits a successful admin delete', async () => {
    fromSpy = spyOn(supabase, 'from').mockImplementation(
      () =>
        ({
          delete: () => ({ eq: async () => ({ error: null }) }),
        }) as never,
    );

    const result = await service.deleteBooking(BOOKING_ID, admin);

    expect(result.success).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: admin.id,
        action: 'booking.delete',
        resourceId: BOOKING_ID,
        success: true,
        meta: { actor_role: 'admin' },
      }),
    );
  });

  it('returns 404 for a stranger reading a booking without loading it', async () => {
    const load = spyOn(service, 'getBookingById');

    const result = await service.getBookingForActor(BOOKING_ID, stranger);

    expect(result).toEqual({ success: false, error: 'Booking not found', statusCode: 404 });
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  it('returns the booking to its tenant', async () => {
    isTenant.mockResolvedValue(true);
    const booking = { id: BOOKING_ID, tenant_id: tenant.id, status: 'Pending' };
    const load = spyOn(service, 'getBookingById').mockResolvedValue({ success: true, data: booking as never });

    const result = await service.getBookingForActor(BOOKING_ID, tenant);

    expect(result).toEqual({ success: true, data: booking });
    load.mockRestore();
  });

  it('returns 404 for a stranger reading status history', async () => {
    const history = spyOn(service, 'getBookingStatusHistory');

    const result = await service.getBookingStatusHistoryForActor(BOOKING_ID, stranger);

    expect(result.statusCode).toBe(404);
    expect(history).not.toHaveBeenCalled();
    history.mockRestore();
  });
});
