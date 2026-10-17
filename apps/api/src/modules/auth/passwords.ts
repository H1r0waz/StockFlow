import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`;
}

// Unknown users incur the same expensive derivation as an existing account.
const dummyHash = `scrypt$32768$8$3$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export async function verifyPassword(password: string, encoded = dummyHash) {
  const parts = encoded.split('$');
  const salt = parts[4];
  const expected = parts[5];
  if (
    parts.length !== 6 ||
    parts.slice(0, 4).join('$') !== 'scrypt$32768$8$3' ||
    !salt ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !expected ||
    !/^[a-f0-9]{128}$/.test(expected)
  )
    return false;
  const hash = await derive(password, salt);
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
