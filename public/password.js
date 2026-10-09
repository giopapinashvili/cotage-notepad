"use strict";
// The password never leaves the device. The browser stretches it into a key
// (slow on purpose) and only that key is sent; the server stretches it again.
window.passwordKey = async function passwordKey(email, password) {
  if (!window.crypto || !crypto.subtle) throw new Error("ეს ბრაუზერი უსაფრთხო შესვლას ვერ ახერხებს. გახსენი საიტი Chrome-ში ან Safari-ში.");
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const salt = encoder.encode("cottage-notebook-v1:" + email.trim().toLowerCase());
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 150000 }, material, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
