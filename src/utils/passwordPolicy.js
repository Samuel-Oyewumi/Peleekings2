/**
 * Shared Password Policy Validator for Peleekings LMS
 * Enforces:
 * - Minimum 8 characters
 * - At least one numeric digit (0-9)
 * - Never logs or echoes the raw password in error messages
 */

export const PASSWORD_MIN_LENGTH = 8;

export function checkPasswordRequirements(password) {
  const value = typeof password === "string" ? password : "";
  const minLength = value.length >= PASSWORD_MIN_LENGTH;
  const hasNumber = /\d/.test(value);
  const isValid = minLength && hasNumber;

  let errorMessage = "";
  if (!value) {
    errorMessage = "Please enter a password.";
  } else if (!minLength && !hasNumber) {
    errorMessage = "Password must be at least 8 characters long and contain at least one number (0–9).";
  } else if (!minLength) {
    errorMessage = "Password must be at least 8 characters long.";
  } else if (!hasNumber) {
    errorMessage = "Password must contain at least one number (0–9).";
  }

  return {
    minLength,
    hasMinLength: minLength,
    hasNumber,
    isValid,
    errorMessage,
  };
}

export function validatePasswordOrThrow(password) {
  const result = checkPasswordRequirements(password);
  if (!result.isValid) {
    throw new Error(result.errorMessage);
  }
  return true;
}
