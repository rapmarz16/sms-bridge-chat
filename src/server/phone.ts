import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export function normalizePhone(value: string, defaultRegion = "CA"): string {
  const phone = parsePhoneNumberFromString(value.trim(), defaultRegion as CountryCode);
  if (!phone?.isValid()) throw new Error("Enter a valid Canadian or U.S. mobile number");
  return phone.number;
}

export function samePhone(left: string, right: string, defaultRegion = "CA"): boolean {
  try {
    return normalizePhone(left, defaultRegion) === normalizePhone(right, defaultRegion);
  } catch {
    return false;
  }
}
