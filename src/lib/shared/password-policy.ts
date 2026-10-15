/**
 * The shortest password the app accepts, one number for everything that
 * checks it: the server (admin user creation, password change) and the forms
 * that tell the person before the server has to (the Profile card's Save and
 * the admin's Create user dialog). Two copies drift: a form that lets a
 * password through that the server then refuses, or one that refuses what the
 * server would take, is the failure mode this file exists to prevent.
 *
 * The words that name the number (`admin.passwordPlaceholder`,
 * `profileTab.newPasswordPlaceholder` and `settings_passwordTooShort`, in
 * English and Hungarian) take it as `{count}` from here, so there is nothing
 * to change beside it.
 *
 * Client-safe: no server imports, no DB, no env.
 */
export const MIN_PASSWORD_LENGTH = 8;
