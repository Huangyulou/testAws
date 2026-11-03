const AUTH_BASE = '/api/auth';

/** Error raised for failed auth requests, carrying the server's message. */
export class AuthRequestError extends Error {
  constructor(message, { status = 0, code = 'request_failed' } = {}) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;

  try {
    response = await fetch(`${AUTH_BASE}/${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new AuthRequestError('无法连接登录服务，请确认游戏服务已启动', {
      code: 'network_error',
    });
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A proxy or a non-JSON error page: fall through with the status code.
  }

  if (!response.ok) {
    throw new AuthRequestError(payload?.error?.message ?? '登录请求失败，请稍后再试', {
      status: response.status,
      code: payload?.error?.code ?? 'request_failed',
    });
  }

  return payload;
}

/** Resolve the signed-in player, or null when there is no valid session. */
export async function currentUser() {
  try {
    const payload = await request('me');
    return payload?.user ?? null;
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function login(username, password) {
  const payload = await request('login', { method: 'POST', body: { username, password } });
  return payload.user;
}

export async function register(username, password) {
  const payload = await request('register', { method: 'POST', body: { username, password } });
  return payload.user;
}

export async function logout() {
  await request('logout', { method: 'POST', body: {} });
}
