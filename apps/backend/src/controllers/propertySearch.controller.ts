import type { Request, Response } from 'express';
import { searchPropertiesByQuery, searchPropertiesNearby } from '@/services/propertySearch.service.js';
import type { NearbySearchParams } from '@/services/propertySearch.service.js';
import { redactExactCoordinates } from '@/utils/locationPrivacy.js';

export async function searchPropertiesEndpoint(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(422).json({ error: 'q is required' });
    return;
  }

  const result = await searchPropertiesByQuery(q);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  // Search results are always public — redact exact coordinates.
  const redacted = Array.isArray(result.data)
    ? result.data.map((p) =>
        redactExactCoordinates(p as { id: string; latitude?: number; longitude?: number }) as unknown as Record<string, unknown>,
      )
    : result.data;

  res.json(redacted);
}

export async function searchNearbyEndpoint(req: Request, res: Response): Promise<void> {
  const params = (req as Request & { parsedQuery?: NearbySearchParams }).parsedQuery;
  if (!params) {
    res.status(422).json({ error: 'lat, lng, and radiusKm query params are required' });
    return;
  }

  const result = await searchPropertiesNearby(params);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  // Nearby results are public — redact exact coordinates.
  // The spatial query uses server-side exact coordinates; only the response is redacted.
  const items = Array.isArray(result.data) ? result.data : (result.data as { data?: unknown[] }).data ?? [];
  const redacted = items.map((p) =>
    redactExactCoordinates(p as { id: string; latitude?: number; longitude?: number }) as unknown as Record<string, unknown>,
  );

  const responsePayload = Array.isArray(result.data)
    ? redacted
    : { ...(result.data as object), data: redacted };

  res.json(responsePayload);
}

