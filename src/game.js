/**
 * Pure game logic for the web version of Lianliankan (连连看).
 *
 * The board keeps a one-cell empty border around the playable area so that
 * connection lines may leave the board and travel around its outside edge,
 * which is the classic rule of the game.
 *
 * This module has no DOM dependencies so the rules can be tested with Node's
 * built-in test runner.
 */

/** @typedef {{ r: number, c: number }} Position */

/**
 * Tiles used by the game. `hue` gives each type a pastel tint in the UI and
 * `name` is used for accessible labels and status messages.
 */
export const TILE_TYPES = Object.freeze([
  { emoji: '🍎', name: '苹果', hue: 4 },
  { emoji: '🍊', name: '橙子', hue: 28 },
  { emoji: '🍋', name: '柠檬', hue: 50 },
  { emoji: '🥝', name: '猕猴桃', hue: 95 },
  { emoji: '🍇', name: '葡萄', hue: 268 },
  { emoji: '🍓', name: '草莓', hue: 338 },
  { emoji: '🍉', name: '西瓜', hue: 145 },
  { emoji: '🍑', name: '桃子', hue: 18 },
  { emoji: '🍒', name: '樱桃', hue: 350 },
  { emoji: '🥭', name: '芒果', hue: 40 },
  { emoji: '🍍', name: '菠萝', hue: 55 },
  { emoji: '🥥', name: '椰子', hue: 30 },
  { emoji: '🍅', name: '番茄', hue: 8 },
  { emoji: '🥕', name: '胡萝卜', hue: 24 },
  { emoji: '🌽', name: '玉米', hue: 48 },
  { emoji: '🍄', name: '蘑菇', hue: 210 },
]);

export const DEFAULT_ROWS = 8;
export const DEFAULT_COLS = 8;
export const DEFAULT_DURATION = 240;
export const MATCH_SCORE = 100;
export const HINT_COST = 30;
export const WIN_TIME_BONUS = 5;

const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Small deterministic PRNG (mulberry32) so tests and screenshots are stable.
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function createSeededRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(items, rng) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function assertDimensions(rows, cols) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) {
    throw new RangeError('The board needs at least 2 rows and 2 columns.');
  }
  if ((rows * cols) % 2 !== 0) {
    throw new RangeError('The board must contain an even number of cells.');
  }
}

/**
 * Create a filled board with a one-cell empty border.
 *
 * Every tile type appears an even number of times; for the default 8x8 board
 * all 16 types appear four times (two pairs each).
 *
 * @param {number} [rows]
 * @param {number} [cols]
 * @param {() => number} [rng]
 * @returns {{ rows: number, cols: number, grid: (number | null)[][] }}
 */
export function createBoard(rows = DEFAULT_ROWS, cols = DEFAULT_COLS, rng = Math.random) {
  assertDimensions(rows, cols);

  const pairCount = (rows * cols) / 2;
  const values = [];
  for (let pair = 0; pair < pairCount; pair += 1) {
    const type = pair % TILE_TYPES.length;
    values.push(type, type);
  }
  shuffleInPlace(values, rng);

  const grid = Array.from({ length: rows + 2 }, () => Array(cols + 2).fill(null));
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      grid[r][c] = values[(r - 1) * cols + (c - 1)];
    }
  }

  return { rows, cols, grid };
}

/**
 * @param {{ rows: number, cols: number, grid: (number | null)[][] }} board
 * @param {Position} position
 * @returns {boolean}
 */
export function isPlayable(board, position) {
  return (
    Number.isInteger(position?.r) &&
    Number.isInteger(position?.c) &&
    position.r >= 1 &&
    position.r <= board.rows &&
    position.c >= 1 &&
    position.c <= board.cols
  );
}

/**
 * Reduce a list of grid positions to the corners of the orthogonal path.
 *
 * @param {Position[]} points
 * @returns {Position[]}
 */
function simplifyPath(points) {
  if (points.length <= 2) return points;

  const corners = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const cross =
      (current.r - previous.r) * (next.c - current.c) -
      (current.c - previous.c) * (next.r - current.r);
    if (cross !== 0) corners.push(current);
  }
  corners.push(points[points.length - 1]);
  return corners;
}

/**
 * Reconstruct the path from a BFS state that reached the target.
 *
 * @param {{ r: number, c: number, prev: object | null }} node
 * @param {Position} start
 * @returns {Position[]}
 */
function buildPath(node, start) {
  const points = [];
  let current = node;
  while (current) {
    points.push({ r: current.r, c: current.c });
    current = current.prev;
  }
  points.push({ r: start.r, c: start.c });
  points.reverse();
  return simplifyPath(points);
}

/**
 * Find an orthogonal connection between two equal tiles using at most two
 * turns. Empty cells and the target cell may be entered; other tiles block the
 * line. Because the board grid contains an empty outer border, lines can go
 * around the outside of the playable board.
 *
 * @param {{ rows: number, cols: number, grid: (number | null)[][] }} board
 * @param {Position} start
 * @param {Position} end
 * @returns {Position[] | null} path corners from start to end, or null
 */
export function findPath(board, start, end) {
  if (!isPlayable(board, start) || !isPlayable(board, end)) return null;
  if (start.r === end.r && start.c === end.c) return null;

  const startValue = board.grid[start.r][start.c];
  const endValue = board.grid[end.r][end.c];
  if (startValue === null || endValue === null || startValue !== endValue) return null;

  const height = board.grid.length;
  const width = board.grid[0].length;
  const bestTurns = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => [Infinity, Infinity, Infinity, Infinity]),
  );

  /** @type {{ r: number, c: number, dir: number, turns: number, prev: object | null }[]} */
  const queue = [];

  for (let dir = 0; dir < DIRECTIONS.length; dir += 1) {
    const [dr, dc] = DIRECTIONS[dir];
    const r = start.r + dr;
    const c = start.c + dc;
    if (r < 0 || r >= height || c < 0 || c >= width) continue;

    const isTarget = r === end.r && c === end.c;
    if (!isTarget && board.grid[r][c] !== null) continue;

    bestTurns[r][c][dir] = 0;
    queue.push({ r, c, dir, turns: 0, prev: null });
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    if (current.r === end.r && current.c === end.c) {
      return buildPath(current, start);
    }

    for (let dir = 0; dir < DIRECTIONS.length; dir += 1) {
      const turns = current.turns + (dir === current.dir ? 0 : 1);
      if (turns > 2) continue;

      const [dr, dc] = DIRECTIONS[dir];
      const r = current.r + dr;
      const c = current.c + dc;
      if (r < 0 || r >= height || c < 0 || c >= width) continue;

      const isTarget = r === end.r && c === end.c;
      if (!isTarget && board.grid[r][c] !== null) continue;
      if (turns >= bestTurns[r][c][dir]) continue;

      bestTurns[r][c][dir] = turns;
      queue.push({ r, c, dir, turns, prev: current });
    }
  }

  return null;
}

function collectTiles(board) {
  const groups = new Map();
  for (let r = 1; r <= board.rows; r += 1) {
    for (let c = 1; c <= board.cols; c += 1) {
      const value = board.grid[r][c];
      if (value === null) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push({ r, c });
    }
  }
  return groups;
}

/**
 * Find any pair of tiles that can currently be connected.
 *
 * @param {{ rows: number, cols: number, grid: (number | null)[][] }} board
 * @param {() => number} [rng]
 * @returns {{ a: Position, b: Position, path: Position[], value: number } | null}
 */
export function findHint(board, rng = Math.random) {
  const groups = collectTiles(board);
  const values = shuffleInPlace([...groups.keys()], rng);

  for (const value of values) {
    const positions = shuffleInPlace(groups.get(value).slice(), rng);
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const path = findPath(board, positions[i], positions[j]);
        if (path) {
          return { a: positions[i], b: positions[j], path, value };
        }
      }
    }
  }

  return null;
}

/**
 * Shuffle the remaining tiles in place until the board has at least one legal
 * connection (or the board is down to its last pair, which is always
 * connectable in an otherwise empty board).
 *
 * @param {{ rows: number, cols: number, grid: (number | null)[][] }} board
 * @param {() => number} [rng]
 * @param {number} [attempts]
 * @returns {typeof board}
 */
export function shuffleRemaining(board, rng = Math.random, attempts = 80) {
  const positions = [];
  const values = [];
  for (let r = 1; r <= board.rows; r += 1) {
    for (let c = 1; c <= board.cols; c += 1) {
      const value = board.grid[r][c];
      if (value === null) continue;
      positions.push({ r, c });
      values.push(value);
    }
  }

  if (positions.length < 2) return board;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    shuffleInPlace(values, rng);
    for (let i = 0; i < positions.length; i += 1) {
      const { r, c } = positions[i];
      board.grid[r][c] = values[i];
    }
    if (positions.length === 2 || findHint(board, rng)) return board;
  }

  return board;
}

/**
 * A small state machine around the board: scoring, timer, selection, hints and
 * shuffles. Rendering remains the responsibility of the UI layer.
 */
export class LianliankanGame {
  /**
   * @param {{ rows?: number, cols?: number, rng?: () => number, duration?: number }} [options]
   */
  constructor({
    rows = DEFAULT_ROWS,
    cols = DEFAULT_COLS,
    rng = Math.random,
    duration = DEFAULT_DURATION,
  } = {}) {
    assertDimensions(rows, cols);
    this.rows = rows;
    this.cols = cols;
    this.rng = rng;
    this.duration = duration;
    this.reset();
  }

  reset() {
    this.board = createBoard(this.rows, this.cols, this.rng);
    let guard = 0;
    while (!findHint(this.board, this.rng) && guard < 20) {
      guard += 1;
      shuffleRemaining(this.board, this.rng);
    }

    this.remaining = (this.rows * this.cols) / 2;
    this.score = 0;
    this.timeLeft = this.duration;
    this.status = 'ready';
    this.selected = null;
  }

  /**
   * @returns {boolean} true when a ready game moved to playing
   */
  start() {
    if (this.status !== 'ready') return false;
    this.status = 'playing';
    return true;
  }

  /**
   * Handle a click on a tile.
   *
   * @param {Position} position
   * @returns {{
   *   type: 'ignored' | 'selected' | 'deselected' | 'mismatch' | 'blocked' | 'match',
   *   a?: Position, b?: Position, path?: Position[], won?: boolean, scoreGained?: number
   * }}
   */
  select(position) {
    if (this.status !== 'playing') return { type: 'ignored' };
    if (!isPlayable(this.board, position)) return { type: 'ignored' };
    if (this.board.grid[position.r][position.c] === null) return { type: 'ignored' };

    const spot = { r: position.r, c: position.c };
    const previous = this.selected;

    if (previous && previous.r === spot.r && previous.c === spot.c) {
      this.selected = null;
      return { type: 'deselected' };
    }

    if (!previous) {
      this.selected = spot;
      return { type: 'selected' };
    }

    const previousValue = this.board.grid[previous.r][previous.c];
    const value = this.board.grid[spot.r][spot.c];

    if (previousValue !== value) {
      this.selected = spot;
      return { type: 'mismatch', a: { ...previous }, b: { ...spot } };
    }

    const path = findPath(this.board, previous, spot);
    if (!path) {
      this.selected = spot;
      return { type: 'blocked', a: { ...previous }, b: { ...spot } };
    }

    this.board.grid[previous.r][previous.c] = null;
    this.board.grid[spot.r][spot.c] = null;
    this.remaining -= 1;
    this.score += MATCH_SCORE;
    this.selected = null;

    let won = false;
    if (this.remaining === 0) {
      this.status = 'won';
      this.score += this.timeLeft * WIN_TIME_BONUS;
      won = true;
    }

    return {
      type: 'match',
      a: { ...previous },
      b: spot,
      path,
      won,
      scoreGained: MATCH_SCORE,
    };
  }

  /**
   * Spend points to reveal a connectable pair.
   *
   * @returns {{ a: Position, b: Position, path: Position[], value: number, cost: number } | null}
   */
  hint() {
    if (this.status !== 'playing' || this.remaining === 0) return null;

    const hint = findHint(this.board, this.rng);
    if (!hint) return null;

    const cost = Math.min(this.score, HINT_COST);
    this.score -= cost;
    return { ...hint, cost };
  }

  /**
   * @returns {boolean} true when a playing board was reshuffled
   */
  shuffle() {
    if (this.status !== 'playing' || this.remaining === 0) return false;
    this.selected = null;
    shuffleRemaining(this.board, this.rng);
    return true;
  }

  /**
   * @returns {boolean} whether at least one legal pair remains
   */
  hasMoves() {
    return Boolean(findHint(this.board, this.rng));
  }

  /**
   * Advance the countdown by one second.
   *
   * @returns {'ready' | 'playing' | 'won' | 'lost'}
   */
  tick() {
    if (this.status !== 'playing') return this.status;

    this.timeLeft = Math.max(0, this.timeLeft - 1);
    if (this.timeLeft === 0) {
      this.status = 'lost';
      this.selected = null;
    }
    return this.status;
  }
}
