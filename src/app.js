import {
  HINT_COST,
  LianliankanGame,
  MATCH_SCORE,
  WIN_TIME_BONUS,
} from './game.js';
import { THEMES, resolveTheme } from './themes.js';
import { AuthRequestError, currentUser, login, logout, register } from './auth.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROWS = 8;
const COLS = 8;
const TIME_LOW = 60;
const TIME_CRITICAL = 30;
const DEFAULT_STATUS = '找到相同图案，点击连线消除';
const THEME_STORAGE_KEY = 'llk-theme';

const els = {
  board: document.getElementById('board'),
  boardShell: document.getElementById('board-shell'),
  gameCard: document.querySelector('.game-card'),
  brandTagline: document.getElementById('brand-tagline'),
  logoFaces: [...document.querySelectorAll('.logo span')],
  miniTiles: [...document.querySelectorAll('.mini-tile')],
  overlay: document.getElementById('overlay'),
  overlayArt: document.getElementById('overlay-art'),
  overlayEyebrow: document.getElementById('overlay-eyebrow'),
  overlayTitle: document.getElementById('overlay-title'),
  overlayText: document.getElementById('overlay-text'),
  overlayScore: document.getElementById('overlay-score'),
  overlayFinalScore: document.getElementById('final-score'),
  overlayButton: document.getElementById('overlay-btn'),
  overlayNote: document.getElementById('overlay-note'),
  status: document.getElementById('status'),
  time: document.getElementById('time'),
  score: document.getElementById('score'),
  remaining: document.getElementById('remaining'),
  timebar: document.getElementById('timebar'),
  timefill: document.getElementById('timefill'),
  hintButton: document.getElementById('hint-btn'),
  shuffleButton: document.getElementById('shuffle-btn'),
  restartButton: document.getElementById('restart-btn'),
  pathLayer: document.getElementById('path-layer'),
  toast: document.getElementById('toast'),
  themeSwitcher: document.getElementById('theme-switcher'),
  themeButton: document.getElementById('theme-btn'),
  themeLabel: document.getElementById('theme-label'),
  themeMenu: document.getElementById('theme-menu'),
  themeColor: document.getElementById('theme-color'),
  page: document.querySelector('.page'),
  account: document.getElementById('account'),
  accountAvatar: document.getElementById('account-avatar'),
  accountName: document.getElementById('account-name'),
  logoutButton: document.getElementById('logout-btn'),
  authGate: document.getElementById('auth-gate'),
  authArt: document.getElementById('auth-art'),
  authEyebrow: document.getElementById('auth-eyebrow'),
  authTitle: document.getElementById('auth-title'),
  authSubtitle: document.getElementById('auth-subtitle'),
  authTabs: document.getElementById('auth-tabs'),
  authTabLogin: document.getElementById('auth-tab-login'),
  authTabRegister: document.getElementById('auth-tab-register'),
  authForm: document.getElementById('auth-form'),
  authUsername: document.getElementById('auth-username'),
  authPassword: document.getElementById('auth-password'),
  authError: document.getElementById('auth-error'),
  authSubmit: document.getElementById('auth-submit'),
  authRetry: document.getElementById('auth-retry'),
  authNote: document.getElementById('auth-note'),
};

const game = new LianliankanGame({ rows: ROWS, cols: COLS });

let tickHandle = null;
let locked = false;
let overlayMode = 'start';
let roundId = 0;
let trackedHintPositions = [];
let hintTimer = null;
let statusTimer = null;
let toastTimer = null;
let pathTimer = null;
let pathClearTimer = null;
let themeMenuOpen = false;
let currentTheme = resolveTheme(document.documentElement.dataset.theme);
let authUser = null;
let authMode = 'login';
let authBusy = false;

function currentFaces() {
  return THEMES[currentTheme].faces;
}

function setThemeMenu(open, { focus = false } = {}) {
  themeMenuOpen = open;
  els.themeMenu.hidden = !open;
  els.themeButton.setAttribute('aria-expanded', String(open));

  if (open && focus) {
    const active = els.themeMenu.querySelector('.theme-option[aria-checked="true"]');
    const fallback = els.themeMenu.querySelector('.theme-option');
    (active ?? fallback)?.focus();
  }
}

function applyTheme(themeKey, { announce = false, persist = true, render = true } = {}) {
  const theme = THEMES[themeKey];
  if (!theme) return;

  currentTheme = themeKey;
  document.documentElement.dataset.theme = themeKey;
  els.themeColor.setAttribute('content', theme.themeColor);

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeKey);
    } catch (error) {
      // Storage can be unavailable in private browsing; the selected theme still applies.
    }
  }

  els.brandTagline.textContent = theme.tagline;
  els.themeLabel.textContent = theme.label;
  els.themeButton.setAttribute(
    'aria-label',
    `视觉风格：${theme.label}，点击切换`,
  );
  els.logoFaces.forEach((span, index) => {
    span.textContent = theme.logo[index] ?? theme.logo[0];
  });
  for (const tile of els.miniTiles) tile.textContent = theme.logo[0];

  for (const option of els.themeMenu.querySelectorAll('.theme-option')) {
    option.setAttribute('aria-checked', String(option.dataset.theme === themeKey));
  }

  if (overlayMode === 'start') {
    els.overlayArt.textContent = theme.logo[0];
    els.overlayEyebrow.textContent = theme.eyebrow;
    els.overlayTitle.textContent = theme.startTitle;
  }

  if (!render) return;

  clearHint();
  hidePath();
  renderBoard();
  syncSelection();

  if (announce && game.status === 'playing') {
    setStatus(`已切换为${theme.label}风格`);
    showToast(`已切换为${theme.label}风格`);
  }
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getTileElement(position) {
  return els.board.querySelector(
    `.tile[data-r="${position.r}"][data-c="${position.c}"]`,
  );
}

function updateBoardLabel() {
  els.board.setAttribute(
    'aria-label',
    `${ROWS} 行 ${COLS} 列连连看棋盘，剩余 ${game.remaining} 对图案`,
  );
}

function setStatus(message, { persist = false } = {}) {
  els.status.textContent = message;
  clearTimeout(statusTimer);
  if (persist) return;
  statusTimer = window.setTimeout(() => {
    if (game.status === 'playing') els.status.textContent = DEFAULT_STATUS;
  }, 2400);
}

function setControlsEnabled(enabled) {
  els.hintButton.disabled = !enabled;
  els.shuffleButton.disabled = !enabled;
  els.restartButton.disabled = !enabled;
}

function renderHud() {
  els.time.textContent = formatTime(game.timeLeft);
  els.score.textContent = game.score.toLocaleString('zh-CN');
  els.remaining.textContent = String(game.remaining);

  const ratio = game.duration > 0 ? game.timeLeft / game.duration : 0;
  els.timefill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  els.timefill.classList.toggle('is-low', game.timeLeft <= TIME_LOW && game.timeLeft > TIME_CRITICAL);
  els.timefill.classList.toggle('is-critical', game.timeLeft <= TIME_CRITICAL);
  els.timebar.setAttribute('aria-valuemax', String(game.duration));
  els.timebar.setAttribute('aria-valuenow', String(game.timeLeft));
  updateBoardLabel();
}

function renderBoard() {
  const fragment = document.createDocumentFragment();

  for (let r = 1; r <= ROWS; r += 1) {
    for (let c = 1; c <= COLS; c += 1) {
      const value = game.board.grid[r][c];
      if (value === null) continue;

      const type = currentFaces()[value];
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.r = String(r);
      tile.dataset.c = String(c);
      tile.style.gridArea = `${r} / ${c}`;
      tile.style.setProperty('--hue', String(type.hue));
      tile.setAttribute('aria-label', `${type.name}，第 ${r} 行第 ${c} 列`);
      tile.setAttribute('aria-pressed', 'false');

      const face = document.createElement('span');
      face.className = 'tile-face';
      face.setAttribute('aria-hidden', 'true');
      face.textContent = type.symbol;
      tile.append(face);

      fragment.append(tile);
    }
  }

  els.board.replaceChildren(fragment);
  updateBoardLabel();
}

function syncSelection() {
  for (const tile of els.board.querySelectorAll('.tile.is-selected')) {
    tile.classList.remove('is-selected');
    tile.setAttribute('aria-pressed', 'false');
  }
  if (!game.selected) return;

  const tile = getTileElement(game.selected);
  if (tile) {
    tile.classList.add('is-selected');
    tile.setAttribute('aria-pressed', 'true');
  }
}

function flashTiles(positions, className) {
  for (const position of positions) {
    const tile = getTileElement(position);
    if (!tile) continue;
    tile.classList.remove(className);
    // Restart the shake animation if the same tile is tapped again quickly.
    void tile.offsetWidth;
    tile.classList.add(className);
    window.setTimeout(() => tile.classList.remove(className), 420);
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2000);
}

function hideToast() {
  clearTimeout(toastTimer);
  els.toast.classList.remove('is-visible');
}

function createDot(point, variant) {
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', point.x.toFixed(2));
  dot.setAttribute('cy', point.y.toFixed(2));
  dot.setAttribute('r', '4.2');
  dot.setAttribute('class', `path-dot path-dot--${variant}`);
  return dot;
}

function hidePath() {
  clearTimeout(pathTimer);
  els.pathLayer.classList.remove('is-visible');
  clearTimeout(pathClearTimer);
  pathClearTimer = window.setTimeout(() => {
    if (!els.pathLayer.classList.contains('is-visible')) {
      els.pathLayer.replaceChildren();
      els.pathLayer.removeAttribute('viewBox');
    }
  }, 220);
}

function drawPath(path, { variant = 'match' } = {}) {
  if (!path || path.length < 2) return;

  const shellRect = els.boardShell.getBoundingClientRect();
  const boardRect = els.board.getBoundingClientRect();
  if (boardRect.width === 0 || shellRect.width === 0) return;

  const styles = getComputedStyle(els.board);
  const gapX = Number.parseFloat(styles.columnGap) || 0;
  const gapY = Number.parseFloat(styles.rowGap) || 0;
  const cellWidth = (boardRect.width - gapX * (COLS - 1)) / COLS;
  const cellHeight = (boardRect.height - gapY * (ROWS - 1)) / ROWS;
  const offsetX = boardRect.left - shellRect.left;
  const offsetY = boardRect.top - shellRect.top;

  // Routes that leave the playable area travel through the virtual border
  // ring. Clamp those points to just outside the tiles so the line stays
  // inside the framed board instead of spilling into the header.
  const minX = offsetX - 5;
  const maxX = offsetX + boardRect.width + 5;
  const minY = offsetY - 5;
  const maxY = offsetY + boardRect.height + 5;
  const points = path.map(({ r, c }) => {
    const x = offsetX + (c - 1) * (cellWidth + gapX) + cellWidth / 2;
    const y = offsetY + (r - 1) * (cellHeight + gapY) + cellHeight / 2;
    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
    };
  });

  clearTimeout(pathTimer);
  clearTimeout(pathClearTimer);
  els.pathLayer.setAttribute(
    'viewBox',
    `0 0 ${shellRect.width.toFixed(2)} ${shellRect.height.toFixed(2)}`,
  );
  els.pathLayer.replaceChildren();

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute(
    'points',
    points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
  );
  line.setAttribute('class', `path-line path-line--${variant}`);

  els.pathLayer.append(
    line,
    createDot(points[0], variant),
    createDot(points[points.length - 1], variant),
  );
  els.pathLayer.classList.add('is-visible');

  if (variant === 'match') {
    const length = line.getTotalLength();
    line.style.strokeDasharray = `${length}`;
    line.style.strokeDashoffset = `${length}`;
    line.getBoundingClientRect();
    window.requestAnimationFrame(() => {
      line.style.transition = 'stroke-dashoffset 180ms ease-out';
      line.style.strokeDashoffset = '0';
    });
  }

  pathTimer = window.setTimeout(() => hidePath(), variant === 'hint' ? 1300 : 480);
}

function clearHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  for (const position of trackedHintPositions) {
    getTileElement(position)?.classList.remove('is-hint');
  }
  trackedHintPositions = [];
}

function stopTimer() {
  if (tickHandle !== null) {
    window.clearInterval(tickHandle);
    tickHandle = null;
  }
}

function startTimer() {
  stopTimer();
  tickHandle = window.setInterval(() => {
    game.tick();
    renderHud();
    if (game.status === 'lost') finishGame(false);
  }, 1000);
}

function showOverlay() {
  els.overlay.dataset.mode = overlayMode;
  els.board.inert = true;
  els.overlay.hidden = false;
  window.requestAnimationFrame(() => {
    els.overlayButton.focus({ preventScroll: true });
  });
}

function hideOverlay() {
  els.overlay.hidden = true;
  els.board.inert = false;
}

function showStartOverlay() {
  overlayMode = 'start';
  const theme = THEMES[currentTheme];
  els.overlayArt.textContent = theme.logo[0];
  els.overlayEyebrow.textContent = theme.eyebrow;
  els.overlayTitle.textContent = theme.startTitle;
  const minutes = Math.round(game.duration / 60);
  els.overlayText.textContent = `两个相同图案，用不超过两个转弯的线连起来即可消除。在 ${minutes} 分钟内清空整盘 ${game.remaining} 对图案就能过关。`;
  els.overlayScore.hidden = true;
  els.overlayButton.textContent = '开始游戏';
  els.overlayNote.textContent = `提示会扣 ${HINT_COST} 分 · 无路可消时自动重排`;
  showOverlay();
}

function showResultOverlay(won) {
  overlayMode = 'result';
  els.overlayArt.textContent = won ? '🎉' : '⌛';
  els.overlayEyebrow.textContent = won ? '恭喜过关' : '差一点点';
  els.overlayTitle.textContent = won ? '全部消除！' : '时间到';
  els.overlayText.textContent = won
    ? `在 ${formatTime(game.timeLeft)} 内清空棋盘，剩余时间奖励已计入得分。`
    : `时间用完了，棋盘上还剩 ${game.remaining} 对图案。再来一局试试吧。`;
  els.overlayScore.hidden = false;
  els.overlayFinalScore.textContent = game.score.toLocaleString('zh-CN');
  els.overlayButton.textContent = '再来一局';
  els.overlayNote.textContent = won
    ? `剩余时间按每秒 ${WIN_TIME_BONUS} 分计入`
    : '提示与重排都不会暂停计时';
  showOverlay();
}

/* ------------------------------------------------------------ auth gate */

function setAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = !message;
}

function authSubmitLabel() {
  if (!authBusy) return authMode === 'register' ? '注册' : '登录';
  return authMode === 'register' ? '注册中…' : '登录中…';
}

function setAuthBusy(busy) {
  authBusy = busy;
  els.authSubmit.disabled = busy;
  els.authSubmit.textContent = authSubmitLabel();
  els.authUsername.disabled = busy;
  els.authPassword.disabled = busy;
  els.authTabLogin.disabled = busy;
  els.authTabRegister.disabled = busy;
}

function setAuthMode(mode, { focus = false } = {}) {
  authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = authMode === 'register';

  els.authTitle.textContent = isRegister ? '创建你的账号' : '登录后开始游戏';
  els.authSubtitle.textContent = isRegister
    ? '注册成功会自动登录，马上就能开一局。'
    : '输入账号密码，继续你的连连看对局。';
  els.authTabLogin.setAttribute('aria-selected', String(!isRegister));
  els.authTabRegister.setAttribute('aria-selected', String(isRegister));
  els.authTabLogin.tabIndex = isRegister ? -1 : 0;
  els.authTabRegister.tabIndex = isRegister ? 0 : -1;
  els.authPassword.autocomplete = isRegister ? 'new-password' : 'current-password';
  els.authNote.textContent = isRegister
    ? '密码至少 8 位；账号数据只保存在运行游戏的这台电脑上'
    : '还没有账号？点击上方「注册」创建';
  els.authSubmit.textContent = authSubmitLabel();
  setAuthError('');

  if (focus) els.authUsername.focus({ preventScroll: true });
}

function openAuthGate() {
  els.authGate.hidden = false;
  els.board.inert = true;
  els.page.inert = true;
}

function hideAuthGate() {
  els.authGate.hidden = true;
  els.page.inert = false;
}

function showAuthChecking() {
  openAuthGate();
  els.authTabs.hidden = true;
  els.authForm.hidden = true;
  els.authRetry.hidden = true;
  els.authArt.textContent = '🔐';
  els.authEyebrow.textContent = '玩家账号';
  els.authTitle.textContent = '正在检查登录状态…';
  els.authSubtitle.textContent = '请稍候';
  els.authNote.textContent = '';
}

function showAuthForm() {
  openAuthGate();
  els.authTabs.hidden = false;
  els.authForm.hidden = false;
  els.authRetry.hidden = true;
  els.authArt.textContent = '🔐';
  els.authEyebrow.textContent = '玩家账号';
  setAuthMode(authMode);
  setAuthBusy(false);
  window.requestAnimationFrame(() => els.authUsername.focus({ preventScroll: true }));
}

function showAuthUnavailable() {
  openAuthGate();
  els.authTabs.hidden = true;
  els.authForm.hidden = true;
  els.authRetry.hidden = false;
  els.authArt.textContent = '📡';
  els.authEyebrow.textContent = '连接失败';
  els.authTitle.textContent = '无法连接登录服务';
  els.authSubtitle.textContent =
    '账号登录需要本地服务支持。请用 npm start 启动游戏，或确认服务正在运行后重试。';
  els.authNote.textContent = '';
  window.requestAnimationFrame(() => els.authRetry.focus({ preventScroll: true }));
}

function setAuthUser(user) {
  authUser = user;
  els.account.hidden = !user;
  if (!user) return;

  els.accountName.textContent = user.username;
  els.accountAvatar.textContent =
    Array.from(user.username)[0]?.toUpperCase() ?? '玩';
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (authBusy) return;

  const username = els.authUsername.value.trim();
  const password = els.authPassword.value;

  if (!username) {
    setAuthError('请输入用户名');
    els.authUsername.focus();
    return;
  }
  if (!password) {
    setAuthError('请输入密码');
    els.authPassword.focus();
    return;
  }

  const mode = authMode;
  setAuthError('');
  setAuthBusy(true);

  try {
    const user =
      mode === 'register'
        ? await register(username, password)
        : await login(username, password);

    setAuthBusy(false);
    els.authForm.reset();
    setAuthUser(user);
    hideAuthGate();
    window.requestAnimationFrame(() => els.overlayButton.focus({ preventScroll: true }));
    showToast(
      mode === 'register' ? `账号已创建，欢迎 ${user.username}` : `欢迎回来，${user.username}`,
    );
  } catch (error) {
    setAuthBusy(false);
    if (error instanceof AuthRequestError && error.code === 'network_error') {
      showAuthUnavailable();
      return;
    }
    setAuthError(error.message ?? '登录失败，请稍后再试');
    els.authPassword.select();
  }
}

async function handleLogout() {
  if (els.logoutButton.disabled) return;

  els.logoutButton.disabled = true;
  try {
    await logout();
  } catch (error) {
    showToast(error.message ?? '退出登录失败，请稍后再试');
    return;
  } finally {
    els.logoutButton.disabled = false;
  }

  setAuthUser(null);
  authMode = 'login';
  startNewGame();
  showAuthForm();
}

function handleAuthTabKeydown(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  setAuthMode(authMode === 'login' ? 'register' : 'login', { focus: true });
}

async function initAuth() {
  try {
    const user = await currentUser();
    if (user) {
      setAuthUser(user);
      hideAuthGate();
      return;
    }

    setAuthUser(null);
    showAuthForm();
  } catch {
    setAuthUser(null);
    showAuthUnavailable();
  }
}

function retryAuth() {
  showAuthChecking();
  initAuth();
}

function startRound() {
  if (!authUser) {
    showAuthForm();
    return;
  }
  if (!game.start()) return;

  hideOverlay();
  clearHint();
  hidePath();
  locked = false;
  els.gameCard.classList.add('is-live');
  setControlsEnabled(true);
  setStatus(DEFAULT_STATUS, { persist: true });
  renderHud();
  startTimer();
}

function startNewGame({ autoStart = false } = {}) {
  roundId += 1;
  stopTimer();
  clearHint();
  hidePath();
  hideToast();
  locked = false;
  els.gameCard.classList.remove('is-live');
  setThemeMenu(false);
  setControlsEnabled(false);

  game.reset();
  renderBoard();
  renderHud();
  setStatus('准备好了就开始吧', { persist: true });

  if (autoStart) {
    startRound();
  } else {
    showStartOverlay();
  }
}

function finishGame(won) {
  roundId += 1;
  stopTimer();
  locked = true;
  clearHint();
  hidePath();
  hideToast();
  els.gameCard.classList.remove('is-live');
  setThemeMenu(false);
  setControlsEnabled(false);
  setStatus(won ? '棋盘清空，恭喜过关！' : '时间到，本局结束', { persist: true });
  showResultOverlay(won);
}

function autoShuffle() {
  if (game.status !== 'playing') return;

  game.shuffle();
  renderBoard();
  renderHud();
  setStatus('没有可消除的组合，已自动重排');
  showToast('已自动重新排列');
}

function handleMatch(result) {
  const round = roundId;
  locked = true;
  clearHint();
  syncSelection();

  const tiles = [result.a, result.b].map(getTileElement);
  for (const tile of tiles) {
    if (!tile) continue;
    tile.classList.remove('is-selected');
    tile.classList.add('is-matched');
  }

  drawPath(result.path);
  renderHud();
  setStatus(`消除成功 +${MATCH_SCORE} 分`);

  window.setTimeout(() => {
    if (round !== roundId) return;
    for (const tile of tiles) tile?.remove();
    updateBoardLabel();
    locked = false;

    if (game.status === 'won') {
      finishGame(true);
    } else if (!game.hasMoves()) {
      window.setTimeout(() => {
        if (round === roundId) autoShuffle();
      }, 140);
    }
  }, 280);
}

function handleTileClick(r, c) {
  const result = game.select({ r, c });
  if (result.type === 'ignored') return;

  if (result.type === 'match') {
    handleMatch(result);
    return;
  }

  syncSelection();

  if (result.type === 'selected') {
    const type = currentFaces()[game.board.grid[r][c]];
    setStatus(`已选中 ${type.symbol} ${type.name}，再选一个相同图案`);
  } else if (result.type === 'deselected') {
    setStatus('已取消选择');
  } else if (result.type === 'mismatch') {
    flashTiles([result.a, result.b], 'is-mismatch');
    setStatus('图案不同，再试一次');
  } else if (result.type === 'blocked') {
    flashTiles([result.a, result.b], 'is-blocked');
    setStatus('这两个图案连不上，先换一组吧');
  }
}

function handleHint() {
  if (!authUser || game.status !== 'playing' || locked) return;

  clearHint();
  hidePath();
  const hint = game.hint();
  if (!hint) {
    autoShuffle();
    return;
  }

  renderHud();
  trackedHintPositions = [hint.a, hint.b];
  for (const position of trackedHintPositions) {
    getTileElement(position)?.classList.add('is-hint');
  }
  drawPath(hint.path, { variant: 'hint' });
  hintTimer = window.setTimeout(clearHint, 2800);
  setStatus('试试点亮的两张牌');
  showToast(hint.cost > 0 ? `提示已使用，扣 ${hint.cost} 分` : '提示已使用');
}

function handleShuffle() {
  if (!authUser || game.status !== 'playing' || locked) return;

  clearHint();
  hidePath();
  if (!game.shuffle()) return;

  renderBoard();
  renderHud();
  setStatus('棋盘已重新排列');
  showToast('棋盘已重新排列');
}

els.board.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile || locked || game.status !== 'playing') return;
  clearHint();
  hidePath();
  handleTileClick(Number(tile.dataset.r), Number(tile.dataset.c));
});

els.hintButton.addEventListener('click', handleHint);
els.shuffleButton.addEventListener('click', handleShuffle);
els.restartButton.addEventListener('click', () => {
  if (!authUser) return;
  startNewGame();
});
els.logoutButton.addEventListener('click', handleLogout);

els.authTabLogin.addEventListener('click', () => setAuthMode('login', { focus: true }));
els.authTabRegister.addEventListener('click', () => setAuthMode('register', { focus: true }));
els.authTabLogin.addEventListener('keydown', handleAuthTabKeydown);
els.authTabRegister.addEventListener('keydown', handleAuthTabKeydown);
els.authForm.addEventListener('submit', handleAuthSubmit);
els.authRetry.addEventListener('click', retryAuth);

els.themeButton.addEventListener('click', (event) => {
  event.stopPropagation();
  setThemeMenu(!themeMenuOpen, { focus: !themeMenuOpen });
});

els.themeMenu.addEventListener('click', (event) => {
  const option = event.target.closest('.theme-option');
  if (!option) return;

  if (option.dataset.theme !== currentTheme) {
    applyTheme(option.dataset.theme, { announce: true });
  }
  setThemeMenu(false);
  els.themeButton.focus();
});

els.themeMenu.addEventListener('keydown', (event) => {
  const options = [...els.themeMenu.querySelectorAll('.theme-option')];
  const index = options.indexOf(document.activeElement);
  if (index < 0) return;

  let nextIndex = null;
  if (event.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
  else if (event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = options.length - 1;
  if (nextIndex === null) return;

  event.preventDefault();
  options[nextIndex].focus();
});

document.addEventListener('click', (event) => {
  if (!themeMenuOpen || els.themeSwitcher.contains(event.target)) return;
  setThemeMenu(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !themeMenuOpen) return;
  setThemeMenu(false);
  els.themeButton.focus();
});

els.overlayButton.addEventListener('click', () => {
  if (overlayMode === 'start') {
    startRound();
  } else {
    startNewGame({ autoStart: true });
  }
});

applyTheme(currentTheme, { persist: false, render: false });
startNewGame();
showAuthChecking();
initAuth();
