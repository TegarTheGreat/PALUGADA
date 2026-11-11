/**
 * A handle as the database shapes it (STATUS 2.209): what a handle field
 * accepts -- on the join page and in a person's profile -- before the server
 * is asked whether it can be used. Kept apart from both, so neither the
 * profile nor the join page reaches into the other for it (STATUS 2.218).
 */
export const HANDLE = /^[a-z][a-z0-9._-]{2,31}$/;
