export const TIME_ZONE = process.env.TZ || "Europe/London";
export function today(now = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name) => parts.find((p) => p.type === name).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function isDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function addDays(date, count) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
export function nextMonday(date = today()) {
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  return addDays(date, (8 - weekday) % 7 || 7);
}
export const weekDates = (start) =>
  Array.from({ length: 7 }, (_, i) => addDays(start, i));
