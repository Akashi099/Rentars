/**
 * Minimal RFC 5545-compliant iCalendar (.ics) generator.
 *
 * Produces single-event and multi-event calendar files. No external
 * dependencies — the format is simple enough to build as a string.
 */

export interface IcsEventInput {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /** ISO-8601 date string, e.g. "2026-07-01" or "2026-07-01T14:00:00" */
  dtStart: string;
  /** ISO-8601 date string */
  dtEnd: string;
  /** ISO-8601 date-time when the event was created */
  created?: string;
  /**
   * RFC 5545 STATUS value. CONFIRMED is the default when omitted.
   * Set to CANCELLED for cancelled bookings so calendar clients remove the event.
   */
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
  /**
   * SEQUENCE number — increment on each modification so clients replace
   * the old event rather than creating a duplicate. Defaults to 0.
   */
  sequence?: number;
}

function toIcsDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function toIcsDate(iso: string): string {
  const datePart = iso.split('T')[0];
  return datePart.replace(/-/g, '');
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Fold long iCalendar lines at 75 octets (RFC 5545 §3.1).
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, 75));
  let i = 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

/**
 * Escape text values per RFC 5545 §3.3.11.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Build VEVENT lines for a single event (without VCALENDAR wrapper).
 */
function buildVEvent(event: IcsEventInput): string[] {
  const hasTime = (iso: string) => iso.includes('T');

  const dtStart = hasTime(event.dtStart)
    ? `DTSTART:${toIcsDateTime(event.dtStart)}`
    : `DTSTART;VALUE=DATE:${toIcsDate(event.dtStart)}`;

  const dtEnd = hasTime(event.dtEnd)
    ? `DTEND:${toIcsDateTime(event.dtEnd)}`
    : (() => {
        const d = new Date(event.dtEnd + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + 1);
        return `DTEND;VALUE=DATE:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
      })();

  const stamp = toIcsDateTime(event.created ?? new Date().toISOString());
  const status = event.status ?? 'CONFIRMED';
  const sequence = event.sequence ?? 0;

  return [
    'BEGIN:VEVENT',
    foldLine(`UID:${escapeText(event.uid)}`),
    `DTSTAMP:${stamp}`,
    dtStart,
    dtEnd,
    `STATUS:${status}`,
    `SEQUENCE:${sequence}`,
    foldLine(`SUMMARY:${escapeText(event.summary)}`),
    foldLine(`DESCRIPTION:${escapeText(event.description)}`),
    foldLine(`LOCATION:${escapeText(event.location)}`),
    'END:VEVENT',
  ];
}

/**
 * Generate a full iCalendar string for a single event.
 */
export function generateIcs(event: IcsEventInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rentars//Rentars Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...buildVEvent(event),
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate a full iCalendar string containing multiple events.
 * Cancelled events are included with STATUS:CANCELLED so calendar clients
 * remove them rather than leaving stale entries.
 */
export function generateIcsFeed(events: IcsEventInput[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rentars//Rentars Booking Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Rentars Bookings',
    'X-WR-CALDESC:Your Rentars booking calendar',
  ];

  for (const event of events) {
    lines.push(...buildVEvent(event));
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
