import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAppServer } from '../server/app.mjs';
import {
  AuthError,
  SessionStore,
  UserStore,
  createAuthService,
  hashPassword,
  normalizeUsername,
  validateRegistration,
  verifyPassword,
} from '../server/auth.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function tempDataDir() {
  return mkdtemp(join(tmpdir(), 'llk-auth-'));
}

async function startApp(dataDir) {
  const server = createAppServer({ root: projectRoot, dataDir });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    },
  };
}

async function withApp(t, dataDir = null) {
  const directory = dataDir ?? (await tempDataDir());
  const app = await startApp(directory);
  t.after(async () => {
    await app.close();
    if (!dataDir) await rm(directory, { recursive: true, force: true });
  });
  return app;
}

function postJson(url, path, body, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  return header.split(';')[0];
}

test('username validation normalizes valid names and rejects invalid ones', () => {
  assert.equal(normalizeUsername('  小明  '), '小明');
  assert.equal(normalizeUsername('Player_1'), 'Player_1');
  assert.equal(normalizeUsername('a-b'), 'a-b');

  for (const invalid of ['', ' a ', 'x', 'a'.repeat(21), 'has space', 'bad!', 42, null]) {
    assert.throws(
      () => normalizeUsername(invalid),
      (error) => error instanceof AuthError && error.code === 'invalid_username',
    );
  }
});

test('registration validation enforces password length', () => {
  assert.deepEqual(validateRegistration({ username: '小明', password: 'secret123' }), {
    username: '小明',
    password: 'secret123',
  });
  assert.deepEqual(validateRegistration({ username: '小明', password: '12345678' }), {
    username: '小明',
    password: '12345678',
  });

  for (const password of ['1234567', 'a'.repeat(129), '', 42]) {
    assert.throws(
      () => validateRegistration({ username: '小明', password }),
      (error) => error instanceof AuthError && error.code === 'invalid_password',
    );
  }
});

test('password hashes are salted and verifiable', async () => {
  const first = await hashPassword('same-password');
  const second = await hashPassword('same-password');

  assert.equal(first.algorithm, 'scrypt');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyPassword('same-password', first), true);
  assert.equal(await verifyPassword('same-password', second), true);
  assert.equal(await verifyPassword('different-password', first), false);
});

test('user store serializes accounts to disk and detects duplicates', async () => {
  const directory = await tempDataDir();
  const file = join(directory, 'users.json');
  const store = new UserStore(file);

  try {
    const created = await store.create({ username: 'Alice', password: 'hunter22' });
    assert.equal(created.username, 'Alice');
    assert.ok((await readFile(file, 'utf8')).includes('"usernameKey": "alice"'));

    const reloaded = new UserStore(file);
    assert.equal((await reloaded.findByUsername('alice')).id, created.id);
    assert.equal((await reloaded.findById(created.id)).username, 'Alice');

    await assert.rejects(
      () => store.create({ username: 'alice', password: 'hunter22' }),
      (error) => error instanceof AuthError && error.code === 'username_taken',
    );

    const document = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(document.users.length, 1);
    assert.ok(document.users[0].hash.length > 32);
    assert.ok(!JSON.stringify(document).includes('hunter22'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session store expires and destroys sessions', () => {
  let now = 1_000;
  const sessions = new SessionStore({ ttlMs: 100, now: () => now });
  const session = sessions.create('user-1');

  assert.equal(sessions.get(session.token).userId, 'user-1');
  assert.equal(sessions.get('missing'), null);

  now += 101;
  assert.equal(sessions.get(session.token), null);

  const second = sessions.create('user-2');
  assert.equal(sessions.destroy(second.token), true);
  assert.equal(sessions.get(second.token), null);
});

test('auth service registers, logs in and resolves sessions', async () => {
  const directory = await tempDataDir();
  const auth = createAuthService({ dataDir: directory });

  try {
    const registered = await auth.register({ username: '玩家一', password: 'secret123' });
    assert.equal(registered.user.username, '玩家一');
    assert.equal((await auth.resolveSession(registered.session.token)).username, '玩家一');

    await assert.rejects(
      () => auth.login({ username: '玩家一', password: 'wrong-password' }),
      (error) => error instanceof AuthError && error.code === 'invalid_credentials',
    );
    await assert.rejects(
      () => auth.login({ username: '不存在', password: 'secret123' }),
      (error) => error instanceof AuthError && error.code === 'invalid_credentials',
    );

    const loggedIn = await auth.login({ username: '玩家一', password: 'secret123' });
    assert.equal(loggedIn.user.id, registered.user.id);

    auth.logout(loggedIn.session.token);
    assert.equal(await auth.resolveSession(loggedIn.session.token), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('register creates an account, a session cookie and a hashed password file', async (t) => {
  const directory = await tempDataDir();
  const app = await withApp(t, directory);

  const response = await postJson(app.url, '/api/auth/register', {
    username: '小明',
    password: 'secret123',
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.user.username, '小明');
  assert.equal(typeof payload.user.id, 'string');
  assert.equal(payload.user.password, undefined);

  const cookie = sessionCookie(response);
  const me = await fetch(`${app.url}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, '小明');

  const stored = JSON.parse(await readFile(join(directory, 'users.json'), 'utf8'));
  assert.equal(stored.users.length, 1);
  assert.equal(stored.users[0].usernameKey, '小明');
  assert.ok(stored.users[0].hash.length > 32);
  assert.ok(!JSON.stringify(stored).includes('secret123'));

  const anonymous = await fetch(`${app.url}/api/auth/me`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'not_authenticated');

  const duplicate = await postJson(app.url, '/api/auth/register', {
    username: '小明',
    password: 'another-pass',
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'username_taken');
});

test('login rejects wrong credentials and logout invalidates the session', async (t) => {
  const app = await withApp(t);

  const registered = await postJson(app.url, '/api/auth/register', {
    username: 'Player',
    password: 'hunter22',
  });
  assert.equal(registered.status, 201);
  const firstCookie = sessionCookie(registered);

  const wrong = await postJson(app.url, '/api/auth/login', {
    username: 'player',
    password: 'wrong-password',
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'invalid_credentials');

  const login = await postJson(app.url, '/api/auth/login', {
    username: 'player',
    password: 'hunter22',
  });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  assert.equal((await login.json()).user.username, 'Player');

  const me = await fetch(`${app.url}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);

  const logout = await fetch(`${app.url}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  const after = await fetch(`${app.url}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
  assert.equal(
    (await fetch(`${app.url}/api/auth/me`, { headers: { Cookie: firstCookie } })).status,
    200,
  );
});

test('validation failures and cross-site requests are rejected', async (t) => {
  const app = await withApp(t);

  const shortPassword = await postJson(app.url, '/api/auth/register', {
    username: '小明',
    password: '12345',
  });
  assert.equal(shortPassword.status, 400);
  assert.equal((await shortPassword.json()).error.code, 'invalid_password');

  const badName = await postJson(app.url, '/api/auth/register', {
    username: 'bad name',
    password: 'secret123',
  });
  assert.equal(badName.status, 400);
  assert.equal((await badName.json()).error.code, 'invalid_username');

  const crossSite = await postJson(
    app.url,
    '/api/auth/register',
    { username: '小明', password: 'secret123' },
    { Origin: 'https://evil.example' },
  );
  assert.equal(crossSite.status, 403);

  const wrongType = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'username=abc',
  });
  assert.equal(wrongType.status, 415);
});

test('failed logins are rate limited per client', async (t) => {
  const app = await withApp(t);
  await postJson(app.url, '/api/auth/register', { username: 'Player', password: 'hunter22' });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await postJson(app.url, '/api/auth/login', {
      username: 'Player',
      password: 'wrong-password',
    });
    assert.equal(response.status, 401);
  }

  const limited = await postJson(app.url, '/api/auth/login', {
    username: 'Player',
    password: 'hunter22',
  });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'too_many_attempts');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('static hosting serves the game but never the server or account data', async (t) => {
  const app = await withApp(t);

  const home = await fetch(`${app.url}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await home.text(), /id="auth-gate"/);

  assert.equal((await fetch(`${app.url}/server/auth.mjs`)).status, 404);
  assert.equal((await fetch(`${app.url}/tests/auth.test.js`)).status, 404);
  assert.equal((await fetch(`${app.url}/..%2f..%2fetc%2fpasswd`)).status, 404);
  assert.equal((await fetch(`${app.url}/.data/users.json`)).status, 404);

  const post = await fetch(`${app.url}/api/unknown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(post.status, 404);
});
