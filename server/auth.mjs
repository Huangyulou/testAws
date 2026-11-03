import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/** An error that can be answered with a status code by the HTTP layer. */
export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

function characterCount(value) {
  return Array.from(value).length;
}

function usernameKey(username) {
  return username.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Validate and normalize a username, throwing a user-facing error when it is
 * not acceptable.
 */
export function normalizeUsername(username) {
  if (typeof username !== 'string') {
    throw new AuthError('invalid_username', '请输入用户名');
  }

  const value = username.trim().normalize('NFC');
  if (
    characterCount(value) < USERNAME_MIN_LENGTH ||
    characterCount(value) > USERNAME_MAX_LENGTH ||
    !USERNAME_PATTERN.test(value)
  ) {
    throw new AuthError(
      'invalid_username',
      `用户名需为 ${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} 个字符，可使用中英文、数字、下划线或短横线`,
    );
  }

  return value;
}

/** Validate a registration payload and return its normalized form. */
export function validateRegistration({ username, password } = {}) {
  const name = normalizeUsername(username);
  validatePassword(password);
  return { username: name, password };
}

function validatePassword(password) {
  if (typeof password !== 'string') {
    throw new AuthError('invalid_password', '请输入密码');
  }

  const length = characterCount(password);
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new AuthError(
      'invalid_password',
      `密码需为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`,
    );
  }
}

/** Validate a login payload. Login errors stay deliberately unspecific. */
export function validateLogin({ username, password } = {}) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new AuthError('invalid_input', '请输入用户名和密码');
  }

  const name = username.trim().normalize('NFC');
  if (
    name.length === 0 ||
    password.length === 0 ||
    characterCount(name) > USERNAME_MAX_LENGTH ||
    characterCount(password) > PASSWORD_MAX_LENGTH
  ) {
    throw new AuthError('invalid_credentials', '用户名或密码错误', 401);
  }

  return { username: name, password };
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(
    password.normalize('NFKC'),
    salt,
    PASSWORD_KEY_LENGTH,
    PASSWORD_PARAMS,
  );

  return {
    algorithm: 'scrypt',
    salt,
    hash: Buffer.from(key).toString('base64url'),
    keyLength: PASSWORD_KEY_LENGTH,
    N: PASSWORD_PARAMS.N,
    r: PASSWORD_PARAMS.r,
    p: PASSWORD_PARAMS.p,
  };
}

export async function verifyPassword(password, record) {
  const expected = Buffer.from(record.hash, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), record.salt, expected.length, {
    N: record.N,
    r: record.r,
    p: record.p,
    maxmem: PASSWORD_PARAMS.maxmem,
  });

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function publicUser(user) {
  return { id: user.id, username: user.username };
}

function isStoredUser(user) {
  return (
    user !== null &&
    typeof user === 'object' &&
    typeof user.id === 'string' &&
    typeof user.username === 'string' &&
    typeof user.usernameKey === 'string' &&
    typeof user.salt === 'string' &&
    typeof user.hash === 'string' &&
    typeof user.N === 'number' &&
    typeof user.r === 'number' &&
    typeof user.p === 'number'
  );
}

/**
 * A small JSON-file user store. Writes are serialized and atomic so two
 * requests cannot create the same account or leave a half-written file.
 */
export class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = null;
    this.loading = null;
    this.writeChain = Promise.resolve();
  }

  async ready() {
    if (this.users) return this.users;
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.users = [];
      return this.users;
    }

    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new Error(`用户数据文件已损坏：${this.filePath}`);
    }

    if (!document || !Array.isArray(document.users) || !document.users.every(isStoredUser)) {
      throw new Error(`用户数据文件格式不正确：${this.filePath}`);
    }

    this.users = document.users;
    return this.users;
  }

  async findByUsername(username) {
    const users = await this.ready();
    const key = usernameKey(username);
    return users.find((user) => user.usernameKey === key) ?? null;
  }

  async findById(id) {
    const users = await this.ready();
    return users.find((user) => user.id === id) ?? null;
  }

  async create({ username, password }) {
    const task = this.writeChain.then(async () => {
      const users = await this.ready();
      const key = usernameKey(username);
      if (users.some((user) => user.usernameKey === key)) {
        throw new AuthError('username_taken', '该用户名已被注册', 409);
      }

      const passwordRecord = await hashPassword(password);
      const user = {
        id: randomUUID(),
        username,
        usernameKey: key,
        ...passwordRecord,
        createdAt: new Date().toISOString(),
      };

      users.push(user);
      try {
        await this.persist();
      } catch (error) {
        users.pop();
        throw error;
      }
      return user;
    });

    // Keep the queue alive even when this particular write fails.
    this.writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async persist() {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const temporaryPath = join(
      directory,
      `.users.${randomBytes(6).toString('hex')}.tmp`,
    );
    const contents = `${JSON.stringify({ version: 1, users: this.users }, null, 2)}\n`;

    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

/** In-memory session tokens. Restarting the server signs every player out. */
export class SessionStore {
  constructor({ ttlMs = SESSION_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create(userId) {
    this.cleanup();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(token, { userId, expiresAt });
    return { token, expiresAt, maxAgeSeconds: Math.floor(this.ttlMs / 1000) };
  }

  get(token) {
    if (typeof token !== 'string' || token.length === 0) return null;

    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    return this.sessions.delete(token);
  }

  cleanup() {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  get size() {
    return this.sessions.size;
  }
}

const INVALID_CREDENTIALS = () =>
  new AuthError('invalid_credentials', '用户名或密码错误', 401);

/**
 * Glue around the user store and session store. The returned methods are what
 * the HTTP layer and tests use.
 */
export function createAuthService({
  dataDir,
  sessionTtlMs = SESSION_TTL_MS,
  now = Date.now,
} = {}) {
  if (!dataDir) throw new Error('createAuthService requires a dataDir');

  const users = new UserStore(join(dataDir, 'users.json'));
  const sessions = new SessionStore({ ttlMs: sessionTtlMs, now });
  let dummyRecord = null;

  async function verifyAgainstDummy(password) {
    // Hashing a password for a missing account keeps login timing comparable
    // to a real failed attempt instead of revealing which usernames exist.
    if (!dummyRecord) {
      dummyRecord = hashPassword(randomBytes(16).toString('hex'));
    }
    await verifyPassword(password, await dummyRecord);
  }

  return {
    userStore: users,
    sessionStore: sessions,

    async register({ username, password }) {
      const values = validateRegistration({ username, password });
      const user = await users.create(values);
      const session = sessions.create(user.id);
      return { user: publicUser(user), session };
    },

    async login({ username, password }) {
      const values = validateLogin({ username, password });
      const user = await users.findByUsername(values.username);

      if (!user) {
        await verifyAgainstDummy(values.password);
        throw INVALID_CREDENTIALS();
      }

      if (!(await verifyPassword(values.password, user))) {
        throw INVALID_CREDENTIALS();
      }

      const session = sessions.create(user.id);
      return { user: publicUser(user), session };
    },

    logout(token) {
      return sessions.destroy(token);
    },

    async resolveSession(token) {
      const session = sessions.get(token);
      if (!session) return null;
      const user = await users.findById(session.userId);
      if (!user) {
        sessions.destroy(token);
        return null;
      }
      return publicUser(user);
    },
  };
}
