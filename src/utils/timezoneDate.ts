/** Calendar date YYYY-MM-DD in an IANA timezone (e.g. Asia/Kolkata). */
export function calendarDateInTimezone(timezone: string, date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
