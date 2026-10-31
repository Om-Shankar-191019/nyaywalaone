import bcrypt from 'bcryptjs';
import { randomToken } from '../lib/hash.js';

export const BCRYPT_COST = 12;

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/**
 * Comparing against a real hash on the "user not found" path keeps login
 * timing roughly constant, so a missing account is not distinguishable from a
 * wrong password by latency alone. Generated once, lazily, because a hardcoded
 * hash in source is the same secret on every deployment.
 */
let dummyHash;
export async function burnPasswordTime(plain) {
  dummyHash ??= await bcrypt.hash(randomToken(32), BCRYPT_COST);
  await bcrypt.compare(plain, dummyHash);
}
