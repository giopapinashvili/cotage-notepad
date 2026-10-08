import test from "node:test";
import assert from "node:assert/strict";
import {
  newDraft,
  validDate,
  addDays,
  validateBooking,
  checkedPatch,
  cents,
  timeStamp,
  overlaps
} from "../src/domain.js";
import { checkOrigin } from "../src/security.js";

function booking(extra = {}) {
  return {
    ...newDraft("2027-06-12"),
    guests: "8",
    price: "450",
    deposit: "100",
    ...extra
  };
}
test("Real calendar dates, leap years and month transitions", () => {
  assert.equal(validDate("2028-02-29"), true);
  for (const date of ["2027-02-29", "2027-02-31", "2027-13-01", "not-a-date"])
    assert.equal(validDate(date), false);
  assert.equal(addDays("2027-12-31", 1), "2028-01-01");
});
test("Prices use exact cents and deposits cannot exceed full price", () => {
  assert.equal(cents("10.01"), 1001);
  assert.equal(validateBooking(booking()).data.price, "450.00");
  for (const value of ["-1", "1.001", "NaN", "", "1000000.01"])
    assert.throws(() => cents(value));
  assert.throws(() => validateBooking(booking({ deposit: "451" })));
});
test("Guest counts and required fields are checked on commit", () => {
  for (const guests of ["", "0", "101", "2.5"])
    assert.throws(() => validateBooking(booking({ guests })));
  assert.throws(() => validateBooking(newDraft("2027-06-12")));
});
test("Incomplete text may be shared, unknown fields cannot be patched", () => {
  assert.deepEqual(checkedPatch({ price: "", notes: "სტუმარი წერს…" }), {
    price: "",
    notes: "სტუმარი წერს…"
  });
  assert.throws(() => checkedPatch({ role: "admin" }));
  assert.throws(() => checkedPatch({ notes: "ა".repeat(10001) }));
  assert.throws(() => checkedPatch({ guests: 5 }));
});
test("Georgia time is stable; same-day stays are supported", () => {
  assert.equal(
    timeStamp("2027-06-12", "15:00"),
    Date.parse("2027-06-12T11:00:00Z")
  );
  const sameDay = validateBooking(
    booking({ end_date: "2027-06-12", end_time: "22:00" })
  );
  assert.equal(sameDay.end - sameDay.start, 7 * 3600000);
  assert.throws(() =>
    validateBooking(booking({ end_date: "2027-06-12", end_time: "14:00" }))
  );
});
test("Adjacent check-out/check-in are allowed; genuine overlap is blocked", () => {
  assert.equal(overlaps(10, 20, 20, 30), false);
  assert.equal(overlaps(10, 20, 19, 30), true);
  assert.equal(overlaps(10, 30, 15, 20), true);
});
test("Family-only blocked time zeroes monetary and guest fields", () => {
  const result = validateBooking(
    booking({ status: "blocked", guests: "", price: "", deposit: "" })
  );
  assert.equal(result.data.guests, "0");
  assert.equal(result.data.price, "0.00");
  assert.equal(result.data.deposit, "0.00");
});
test("Cross-site WebSocket origins are rejected", () => {
  const req = new Request("https://cottage.example/api/ws", {
    headers: { Origin: "https://cottage.example" }
  });
  assert.doesNotThrow(() => checkOrigin(req));
  assert.throws(() =>
    checkOrigin(
      new Request(req.url, { headers: { Origin: "https://foreign.example" } })
    )
  );
});
