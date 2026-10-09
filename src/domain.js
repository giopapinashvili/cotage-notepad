export const FIELDS = [
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "status",
  "guests",
  "price",
  "deposit",
  "guest_name",
  "phone",
  "notes"
];
const MAX_LENGTH = {
  start_date: 10,
  end_date: 10,
  start_time: 5,
  end_time: 5,
  status: 16,
  guests: 3,
  price: 14,
  deposit: 14,
  guest_name: 100,
  phone: 40,
  notes: 10000
};
export class AppError extends Error {
  constructor(message, code = "INVALID", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function validDate(value) {
  if (!/^20\d\d-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function addDays(value, days) {
  if (!validDate(value)) throw new AppError("თარიღი არასწორია.");
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function newDraft(date) {
  return {
    start_date: date,
    end_date: addDays(date, 1),
    start_time: "15:00",
    end_time: "12:00",
    status: "confirmed",
    guests: "",
    price: "",
    deposit: "0",
    guest_name: "",
    phone: "",
    notes: ""
  };
}
export function checkedPatch(patch) {
  if (!patch || Array.isArray(patch) || typeof patch !== "object")
    throw new AppError("ჩანაწერი არასწორია.");
  const entries = Object.entries(patch);
  if (!entries.length || entries.length > FIELDS.length)
    throw new AppError("ცვლილება არასწორია.");
  for (const [key, value] of entries) {
    if (
      !FIELDS.includes(key) ||
      typeof value !== "string" ||
      value.length > MAX_LENGTH[key]
    )
      throw new AppError("ველის მნიშვნელობა არასწორია.");
    if (key === "status" && !["confirmed", "hold", "blocked"].includes(value))
      throw new AppError("სტატუსი არასწორია.");
  }
  return Object.fromEntries(entries);
}
export function cents(value, label = "თანხა") {
  if (typeof value !== "string" || !/^\d+(?:\.\d{0,2})?$/.test(value.trim()))
    throw new AppError(
      `${label}: ჩაწერე არაუარყოფითი თანხა, მაქსიმუმ ორი ათწილადით.`
    );
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > 100000000)
    throw new AppError(`${label} მეტისმეტად დიდია.`);
  return amount;
}
export function timeStamp(date, time) {
  if (!validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new AppError("შესვლის ან გასვლის თარიღი/საათი არასწორია.");
  // Cottage times are always Georgia time; they do not shift with a guest's device timezone.
  return Date.parse(`${date}T${time}:00+04:00`);
}
export function validateBooking(input) {
  const data = checkedPatch(input);
  if (FIELDS.some((key) => !Object.hasOwn(data, key)))
    throw new AppError("შეავსე ყველა აუცილებელი ველი.");
  const start = timeStamp(data.start_date, data.start_time),
    end = timeStamp(data.end_date, data.end_time);
  if (end <= start) throw new AppError("გასვლა შესვლის შემდეგ უნდა იყოს.");
  if (end - start > 366 * 86400000)
    throw new AppError("ერთი ჯავშანი მაქსიმუმ ერთ წელს მოიცავს.");
  const blocked = data.status === "blocked";
  if (
    !blocked &&
    (!/^\d+$/.test(data.guests) || +data.guests < 1 || +data.guests > 100)
  )
    throw new AppError("მიუთითე სტუმრების რაოდენობა 1-დან 100-მდე.");
  if (blocked) {
    data.guests = "0";
    data.price = "0";
    data.deposit = "0";
  }
  const price = cents(data.price, "სრული ფასი"),
    deposit = cents(data.deposit || "0", "ავანსი");
  if (deposit > price)
    throw new AppError("ავანსი სრულ ფასს არ უნდა აღემატებოდეს.");
  data.price = (price / 100).toFixed(2);
  data.deposit = (deposit / 100).toFixed(2);
  data.guests = String(Number(data.guests));
  data.guest_name = data.guest_name.trim();
  data.phone = data.phone.trim();
  data.notes = data.notes.trim();
  return { data, start, end };
}
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
