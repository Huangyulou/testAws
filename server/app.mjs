import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import { AuthError, SESSION_TTL_MS, createAuthService } from './auth.mjs';

const COOKIE_NAME = 'llk_session';
const MAX_BODY_BYTES = 16 * 1024;
const DENY_SEGMENTS = new Set(['node_modules', 'server', 'tests']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const DOCUMENT_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendError(response, error) {
  if (error instanceof AuthError || error instanceof HttpError) {
    sendJson(
      response,
      error.status,
      { error: { code: error.code, message: error.message } },
      error.headers ?? {},
    );
    return;
  }

  console.error('Unexpected auth error:', error);
  sendJson(
    response,
    500,
    { error: { code: 'server_error', message: '服务器暂时无法处理请求，请稍后再试' } },
  );
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string') return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    cookies.set(name, value);
  }
  return cookies;
}

function isSecureRequest(request) {
  return (
    Boolean(request.socket.encrypted) || request.headers['x-forwarded-proto'] === 'https'
  );
}

function sessionCookie(session, request) {
  return [
    `${COOKIE_NAME}=${session.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${session.maxAgeSeconds}`,
    ...(isSecureRequest(request) ? ['Secure'] : []),
  ].join('; ');
}

function clearedSessionCookie(request) {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(isSecureRequest(request) ? ['Secure'] : []),
  ].join('; ');
}

function requestProtocol(request) {
  return isSecureRequest(request) ? 'https' : 'http';
}

/** Reject cross-site state-changing requests. SameSite cookies cover the rest. */
function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = `${requestProtocol(request)}://${request.headers.host ?? ''}`;
  if (origin !== expected) {
    throw new HttpError(403, 'forbidden', '请求来源不受信任');
  }
}

async function readJsonBody(request) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', '请求格式不正确');
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        rejectBody(new HttpError(413, 'payload_too_large', '请求内容过大'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const value = JSON.parse(raw || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('not an object');
        }
        resolveBody(value);
      } catch {
        rejectBody(new HttpError(400, 'invalid_json', '请求格式不正确'));
      }
    });

    request.on('error', rejectBody);
  });
}

function createRateLimiter({ limit, windowMs, now }) {
  const attempts = new Map();

  function current(key) {
    const entry = attempts.get(key);
    if (!entry) return null;
    if (now() - entry.startedAt >= windowMs) {
      attempts.delete(key);
      return null;
    }
    return entry;
  }

  return {
    retryAfterSeconds(key) {
      const entry = current(key);
      if (!entry || entry.count < limit) return 0;
      return Math.max(1, Math.ceil((entry.startedAt + windowMs - now()) / 1000));
    },
    record(key) {
      const entry = current(key);
      if (entry) entry.count += 1;
      else attempts.set(key, { startedAt: now(), count: 1 });
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}

/**
 * Create the game server: static files plus a small same-origin auth API.
 *
 * The game still ships as dependency-free browser code. Authentication needs
 * a server, so it is served by this Node process instead of a static host.
 */
export function createAppServer({
  root,
  dataDir,
  sessionTtlMs = SESSION_TTL_MS,
  now = Date.now,
} = {}) {
  if (!root || !dataDir) {
    throw new Error('createAppServer requires root and dataDir');
  }

  const documentRoot = resolve(root);
  const authDataDir = resolve(dataDir);
  const auth = createAuthService({ dataDir: authDataDir, sessionTtlMs, now });
  const loginLimiter = createRateLimiter({ limit: 8, windowMs: 15 * 60 * 1000, now });
  const registerLimiter = createRateLimiter({ limit: 20, windowMs: 60 * 60 * 1000, now });

  function clientKey(request) {
    return request.socket.remoteAddress ?? 'unknown';
  }

  async function handleAuth(request, response, pathname) {
    if (request.method === 'POST') assertSameOrigin(request);

    if (pathname === '/api/auth/me' && request.method === 'GET') {
      const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
      const user = token ? await auth.resolveSession(token) : null;
      if (!user) {
        sendJson(
          response,
          401,
          { error: { code: 'not_authenticated', message: '请先登录' } },
          token ? { 'Set-Cookie': clearedSessionCookie(request) } : {},
        );
        return;
      }
      sendJson(response, 200, { user });
      return;
    }

    if (pathname === '/api/auth/register' && request.method === 'POST') {
      const key = clientKey(request);
      const retryAfter = registerLimiter.retryAfterSeconds(key);
      if (retryAfter) {
        throw new HttpError(
          429,
          'too_many_attempts',
          `注册尝试过于频繁，请 ${retryAfter} 秒后再试`,
          { 'Retry-After': String(retryAfter) },
        );
      }
      registerLimiter.record(key);

      const body = await readJsonBody(request);
      const { user, session } = await auth.register(body);
      sendJson(response, 201, { user }, { 'Set-Cookie': sessionCookie(session, request) });
      return;
    }

    if (pathname === '/api/auth/login' && request.method === 'POST') {
      const key = clientKey(request);
      const retryAfter = loginLimiter.retryAfterSeconds(key);
      if (retryAfter) {
        throw new HttpError(
          429,
          'too_many_attempts',
          `尝试次数过多，请 ${retryAfter} 秒后再试`,
          { 'Retry-After': String(retryAfter) },
        );
      }

      const body = await readJsonBody(request);
      try {
        const { user, session } = await auth.login(body);
        loginLimiter.clear(key);
        sendJson(response, 200, { user }, { 'Set-Cookie': sessionCookie(session, request) });
      } catch (error) {
        if (error instanceof AuthError && error.code === 'invalid_credentials') {
          loginLimiter.record(key);
        }
        throw error;
      }
      return;
    }

    if (pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
      if (token) auth.logout(token);
      response.writeHead(204, {
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-store',
        'Set-Cookie': clearedSessionCookie(request),
      });
      response.end();
      return;
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  function serveStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', '不支持的请求方法');
    }

    const segments = pathname.split('/').filter(Boolean);
    if (segments.some((segment) => segment.startsWith('.') || DENY_SEGMENTS.has(segment))) {
      throw new HttpError(404, 'not_found', '文件不存在');
    }

    const filePath = resolve(documentRoot, `.${pathname}`);
    const isInsideRoot = filePath === documentRoot || filePath.startsWith(documentRoot + sep);
    const isAuthData = filePath === authDataDir || filePath.startsWith(authDataDir + sep);

    if (!isInsideRoot || isAuthData) {
      throw new HttpError(403, 'forbidden', '禁止访问');
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new HttpError(404, 'not_found', '文件不存在');
    }

    const extension = extname(filePath).toLowerCase();
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    };

    if (extension === '.html') {
      headers['Content-Security-Policy'] = DOCUMENT_CSP;
    }

    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'bad_request', '请求地址不正确');
      }

      if (pathname.startsWith('/api/')) {
        await handleAuth(request, response, pathname);
        return;
      }

      if (pathname.endsWith('/')) pathname += 'index.html';
      serveStatic(request, response, pathname);
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });
}
