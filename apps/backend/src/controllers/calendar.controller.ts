import type { Request, Response } from 'express';
import {
  getMonthAvailability,
  checkAvailabilityAtomic,
  getAvailabilityRanges,
} from '@/services/calendar.service.js';
import {
  calculateRangePrice,
  getSeasonalPricing,
  createSeasonalPricing as svcCreateSeasonalPricing,
  deleteSeasonalPricing as svcDeleteSeasonalPricing,
  createSpecialEvent as svcCreateSpecialEvent,
  deleteSpecialEvent as svcDeleteSpecialEvent,
  previewPricing,
  getPropertyQuote,
} from '@/services/pricing.service.js';

export async function getCalendarMonth(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { year, month } = req.query;

  if (!propertyId || !year || !month) {
    res.status(400).json({ error: 'propertyId, year, and month are required' });
    return;
  }

  const yearNum = Number(year);
  const monthNum = Number(month);

  if (!Number.isInteger(yearNum) || !Number.isFinite(yearNum)) {
    res.status(422).json({ error: 'year must be a valid integer' });
    return;
  }

  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
    res.status(422).json({ error: 'month must be an integer between 1 and 12' });
    return;
  }

  const result = await getMonthAvailability(propertyId, yearNum, monthNum);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function checkAvailability(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { checkIn, checkOut } = req.query;

  if (!propertyId || !checkIn || !checkOut) {
    res.status(400).json({ error: 'propertyId, checkIn, and checkOut are required' });
    return;
  }

  const result = await checkAvailabilityAtomic(
    propertyId,
    checkIn as string,
    checkOut as string,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getRangePrice(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { checkIn, checkOut } = req.query;

  if (!propertyId || !checkIn || !checkOut) {
    res.status(400).json({ error: 'propertyId, checkIn, and checkOut are required' });
    return;
  }

  const result = await calculateRangePrice(propertyId, checkIn as string, checkOut as string);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getAvailability(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  const result = await getAvailabilityRanges(propertyId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getSeasonalRates(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  const result = await getSeasonalPricing(propertyId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function createSeasonalRate(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId } = req.params;
  const { name, start_date, end_date, price_multiplier } = req.body;

  if (!name || !start_date || !end_date || !price_multiplier) {
    res.status(400).json({ error: 'name, start_date, end_date, and price_multiplier are required' });
    return;
  }

  const result = await svcCreateSeasonalPricing(propertyId, userId, {
    name,
    start_date,
    end_date,
    price_multiplier,
    id: '',
    property_id: propertyId,
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function deleteSeasonalRate(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId, pricingId } = req.params;

  const result = await svcDeleteSeasonalPricing(propertyId, pricingId, userId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId } = req.params;
  const { name, start_date, end_date, price_multiplier, is_blocked } = req.body;

  if (!name || !start_date || !end_date) {
    res.status(400).json({ error: 'name, start_date, and end_date are required' });
    return;
  }

  const result = await svcCreateSpecialEvent(propertyId, userId, {
    name,
    start_date,
    end_date,
    price_multiplier: price_multiplier || 1,
    is_blocked: is_blocked || false,
    id: '',
    property_id: propertyId,
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId, eventId } = req.params;

  const result = await svcDeleteSpecialEvent(propertyId, eventId, userId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

export async function previewPropertyPricing(req: Request, res: Response): Promise<void> {
  const { id: propertyId } = req.params;
  const { start, end } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: 'start and end query params are required' });
    return;
  }

  const result = await previewPricing(propertyId, start as string, end as string);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getPropertyQuoteHandler(req: Request, res: Response): Promise<void> {
  const { id: propertyId } = req.params;
  const { start, end, guests } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: 'start and end query params are required' });
    return;
  }

  let guestCount: number | undefined;
  if (guests !== undefined) {
    const parsed = Number(guests);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ error: 'guests must be a positive integer' });
      return;
    }
    guestCount = parsed;
  }

  const result = await getPropertyQuote(propertyId, start as string, end as string, guestCount);
  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
