import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DURATION,
  HINT_COST,
  MATCH_SCORE,
  TILE_TYPES,
  WIN_TIME_BONUS,
  LianliankanGame,
  createBoard,
  createSeededRng,
  findHint,
  findPath,
  shuffleRemaining,
} from '../src/game.js';
import { THEMES, THEME_ORDER, resolveTheme } from '../src/themes.js';

/**
 * Build a board with an empty border from a list of [row, column, value]
 * placements.
 */
function layoutBoard(rows, cols, placements) {
  const grid = Array.from({ length: rows + 2 }, () => Array(cols + 2).fill(null));
  for (const [r, c, value] of placements) grid[r][c] = value;
  return { rows, cols, grid };
}

function turnCount(path) {
  let turns = 0;
  for (let i = 1; i < path.length - 1; i += 1) {
    const before = path[i - 1];
    const current = path[i];
    const after = path[i + 1];
    const inbound = [current.r - before.r, current.c - before.c];
    const outbound = [after.r - current.r, after.c - current.c];
    if (inbound[0] !== outbound[0] || inbound[1] !== outbound[1]) turns += 1;
  }
  return turns;
}

function valuesOf(board) {
  const values = [];
  for (let r = 1; r <= board.rows; r += 1) {
    for (let c = 1; c <= board.cols; c += 1) {
      if (board.grid[r][c] !== null) values.push(board.grid[r][c]);
    }
  }
  return values.sort((a, b) => a - b);
}

test('createBoard fills an even 8x8 board and leaves an empty border', () => {
  const board = createBoard(8, 8, createSeededRng(42));

  assert.equal(board.rows, 8);
  assert.equal(board.cols, 8);
  assert.equal(board.grid.length, 10);
  assert.equal(board.grid[0].length, 10);

  for (let i = 0; i < 10; i += 1) {
    assert.equal(board.grid[0][i], null);
    assert.equal(board.grid[9][i], null);
    assert.equal(board.grid[i][0], null);
    assert.equal(board.grid[i][9], null);
  }

  const counts = new Map();
  for (let r = 1; r <= 8; r += 1) {
    for (let c = 1; c <= 8; c += 1) {
      const value = board.grid[r][c];
      assert.ok(Number.isInteger(value));
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  assert.equal(counts.size, TILE_TYPES.length);
  for (const count of counts.values()) assert.equal(count, 4);
});

test('createBoard is deterministic for a seeded RNG', () => {
  const first = createBoard(6, 6, createSeededRng(7));
  const second = createBoard(6, 6, createSeededRng(7));
  assert.deepEqual(first, second);
});

test('createBoard rejects boards without an even number of cells', () => {
  assert.throws(() => createBoard(3, 3, createSeededRng(1)), RangeError);
  assert.throws(() => createBoard(1, 4, createSeededRng(1)), RangeError);
});

test('findPath connects equal adjacent tiles in a straight line', () => {
  const board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 2, 0],
  ]);
  const path = findPath(board, { r: 1, c: 1 }, { r: 1, c: 2 });

  assert.ok(path);
  assert.deepEqual(path[0], { r: 1, c: 1 });
  assert.deepEqual(path.at(-1), { r: 1, c: 2 });
  assert.equal(path.length, 2);
  assert.equal(turnCount(path), 0);
});

test('findPath uses two turns when the direct approach is blocked', () => {
  const board = layoutBoard(5, 5, [
    [2, 2, 0],
    [3, 2, 1],
    [2, 3, 1],
    [2, 4, 0],
    [4, 2, 1],
    [3, 4, 1],
  ]);
  const path = findPath(board, { r: 2, c: 2 }, { r: 2, c: 4 });

  assert.ok(path);
  assert.ok(turnCount(path) <= 2);
  assert.equal(turnCount(path), 2);
  assert.ok(path.length <= 4);
});

test('findPath can travel around the outside border', () => {
  const board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 2, 1],
    [1, 3, 1],
    [1, 4, 0],
    [2, 1, 2],
    [2, 4, 2],
  ]);
  const path = findPath(board, { r: 1, c: 1 }, { r: 1, c: 4 });

  assert.ok(path);
  assert.ok(path.some((point) => point.r === 0), 'path should use the border row');
  assert.ok(turnCount(path) <= 2);
});

test('findPath refuses a tile that is completely boxed in', () => {
  const board = layoutBoard(3, 3, [
    [2, 2, 0],
    [1, 1, 0],
    [1, 2, 1],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 4],
    [3, 1, 5],
    [3, 2, 6],
    [3, 3, 7],
  ]);
  assert.equal(findPath(board, { r: 2, c: 2 }, { r: 1, c: 1 }), null);
});

test('findPath validates value, position and identity', () => {
  const board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 2, 1],
  ]);

  assert.equal(findPath(board, { r: 1, c: 1 }, { r: 1, c: 2 }), null);
  assert.equal(findPath(board, { r: 1, c: 1 }, { r: 1, c: 1 }), null);
  assert.equal(findPath(board, { r: 1, c: 1 }, { r: 0, c: 1 }), null);
  assert.equal(findPath(board, { r: 1, c: 1 }, { r: 1, c: 9 }), null);
});

test('findHint returns a legal pair on a playable board', () => {
  const board = layoutBoard(3, 3, [
    [1, 1, 0],
    [1, 2, 0],
    [3, 1, 1],
    [3, 3, 1],
  ]);
  const hint = findHint(board, createSeededRng(3));

  assert.ok(hint);
  assert.equal(board.grid[hint.a.r][hint.a.c], board.grid[hint.b.r][hint.b.c]);
  assert.deepEqual(findPath(board, hint.a, hint.b), hint.path);
});

test('findHint returns null when no pair can be connected', () => {
  const board = layoutBoard(4, 4, []);
  const blocked = layoutBoard(3, 3, [
    [2, 2, 0],
    [1, 1, 0],
    [1, 2, 1],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 4],
    [3, 1, 5],
    [3, 2, 6],
    [3, 3, 7],
  ]);

  assert.equal(findHint(board), null);
  assert.equal(findHint(blocked), null);
});

test('shuffleRemaining preserves tiles and creates a legal move', () => {
  const board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 4, 0],
    [4, 1, 1],
    [4, 4, 1],
    [2, 2, 2],
    [3, 3, 2],
    [2, 3, 3],
    [3, 2, 3],
  ]);
  const before = valuesOf(board);

  shuffleRemaining(board, createSeededRng(11));

  assert.deepEqual(valuesOf(board), before);
  assert.ok(findHint(board, createSeededRng(12)));
});

test('shuffleRemaining handles the last pair', () => {
  const board = layoutBoard(2, 2, [
    [1, 1, 0],
    [2, 2, 0],
  ]);
  shuffleRemaining(board, createSeededRng(5));

  assert.ok(findHint(board));
});

test('game starts ready with a full board and a guaranteed first move', () => {
  const game = new LianliankanGame({ rng: createSeededRng(9) });

  assert.equal(game.status, 'ready');
  assert.equal(game.remaining, 32);
  assert.equal(game.score, 0);
  assert.equal(game.timeLeft, DEFAULT_DURATION);
  assert.equal(game.selected, null);
  assert.ok(game.hasMoves());
});

test('game start and tick change the state only while appropriate', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1), duration: 2 });

  assert.equal(game.tick(), 'ready');
  assert.equal(game.start(), true);
  assert.equal(game.status, 'playing');
  assert.equal(game.start(), false);

  game.selected = { r: 1, c: 1 };
  assert.equal(game.tick(), 'playing');
  assert.equal(game.timeLeft, 1);
  assert.equal(game.tick(), 'lost');
  assert.equal(game.timeLeft, 0);
  assert.equal(game.selected, null);
  assert.equal(game.tick(), 'lost');
});

test('selecting two connectable tiles removes them and scores', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1), duration: 60 });
  game.board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 2, 0],
  ]);
  game.remaining = 1;
  game.status = 'playing';

  assert.deepEqual(game.select({ r: 1, c: 1 }), { type: 'selected' });
  const result = game.select({ r: 1, c: 2 });

  assert.equal(result.type, 'match');
  assert.equal(result.won, true);
  assert.ok(result.path);
  assert.equal(game.remaining, 0);
  assert.equal(game.status, 'won');
  assert.equal(game.score, MATCH_SCORE + 60 * WIN_TIME_BONUS);
  assert.equal(game.board.grid[1][1], null);
  assert.equal(game.board.grid[1][2], null);
  assert.equal(game.selected, null);
});

test('mismatched tiles keep the second tile selected', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1) });
  game.board = layoutBoard(4, 4, [
    [2, 2, 0],
    [2, 3, 1],
  ]);
  game.remaining = 1;
  game.status = 'playing';

  game.select({ r: 2, c: 2 });
  const result = game.select({ r: 2, c: 3 });

  assert.equal(result.type, 'mismatch');
  assert.deepEqual(game.selected, { r: 2, c: 3 });
  assert.equal(game.remaining, 1);
  assert.equal(game.score, 0);
});

test('same tiles without a path are not removed', () => {
  const tiles = [
    [2, 2, 0],
    [1, 1, 0],
    [1, 2, 1],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 4],
    [3, 1, 5],
    [3, 2, 6],
    [3, 3, 7],
  ];
  const game = new LianliankanGame({ rng: createSeededRng(1) });
  game.board = layoutBoard(3, 3, tiles);
  game.remaining = 4;
  game.status = 'playing';

  game.select({ r: 2, c: 2 });
  const result = game.select({ r: 1, c: 1 });

  assert.equal(result.type, 'blocked');
  assert.equal(game.remaining, 4);
  assert.equal(game.score, 0);
  assert.deepEqual(game.selected, { r: 1, c: 1 });
});

test('clicking the selected tile again deselects it', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1) });
  game.board = layoutBoard(4, 4, [
    [1, 1, 0],
    [1, 2, 0],
  ]);
  game.remaining = 1;
  game.status = 'playing';

  game.select({ r: 1, c: 1 });
  assert.deepEqual(game.select({ r: 1, c: 1 }), { type: 'deselected' });
  assert.equal(game.selected, null);
});

test('hint reveals a pair and deducts its cost', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1) });
  game.board = layoutBoard(4, 4, [
    [2, 2, 0],
    [2, 3, 0],
  ]);
  game.remaining = 1;
  game.status = 'playing';
  game.score = 100;

  const hint = game.hint();

  assert.ok(hint);
  assert.equal(hint.cost, HINT_COST);
  assert.equal(game.score, 100 - HINT_COST);
  assert.ok(hint.path);
  assert.deepEqual(findPath(game.board, hint.a, hint.b), hint.path);
});

test('hint cost never pushes the score below zero', () => {
  const game = new LianliankanGame({ rng: createSeededRng(1) });
  game.board = layoutBoard(4, 4, [
    [2, 2, 0],
    [2, 3, 0],
  ]);
  game.remaining = 1;
  game.status = 'playing';
  game.score = 10;

  const hint = game.hint();

  assert.ok(hint);
  assert.equal(hint.cost, 10);
  assert.equal(game.score, 0);
});

test('shuffle clears the selection and produces a legal board', () => {
  const game = new LianliankanGame({ rng: createSeededRng(21) });
  game.start();
  game.selected = { r: 1, c: 1 };
  const valuesBefore = valuesOf(game.board);

  assert.equal(game.shuffle(), true);
  assert.equal(game.selected, null);
  assert.deepEqual(valuesOf(game.board), valuesBefore);
  assert.ok(game.hasMoves());
});

test('following hints clears a full generated board', () => {
  const game = new LianliankanGame({ rng: createSeededRng(99) });
  game.start();

  let guard = 0;
  while (game.status === 'playing' && guard < 200) {
    guard += 1;
    const hint = game.hint();
    assert.ok(hint, 'a playing board should always offer a hint');
    assert.equal(game.select(hint.a).type, 'selected');
    assert.equal(game.select(hint.b).type, 'match');

    if (game.status === 'playing' && !game.hasMoves()) {
      assert.equal(game.shuffle(), true);
    }
  }

  assert.equal(guard, 32);
  assert.equal(game.status, 'won');
  assert.equal(game.remaining, 0);
});

test('reset restores a fresh ready game', () => {
  const game = new LianliankanGame({ rng: createSeededRng(4) });
  game.start();
  game.score = 500;
  game.timeLeft = 12;
  game.selected = { r: 1, c: 1 };

  game.reset();

  assert.equal(game.status, 'ready');
  assert.equal(game.score, 0);
  assert.equal(game.timeLeft, DEFAULT_DURATION);
  assert.equal(game.remaining, 32);
  assert.equal(game.selected, null);
  assert.ok(game.hasMoves());
});

test('every visual theme maps all tile types to a unique face', () => {
  assert.deepEqual([...THEME_ORDER], ['orchard', 'cartoon', 'fantasy']);

  for (const key of THEME_ORDER) {
    const theme = THEMES[key];
    assert.ok(theme, `${key} should exist`);

    assert.equal(theme.faces.length, TILE_TYPES.length);
    assert.equal(new Set(theme.faces.map((face) => face.symbol)).size, TILE_TYPES.length);
    assert.equal(new Set(theme.faces.map((face) => face.name)).size, TILE_TYPES.length);
    assert.equal(new Set(theme.faces.map((face) => face.hue)).size, TILE_TYPES.length);

    for (const face of theme.faces) {
      assert.ok(face.symbol.length > 0);
      assert.ok(face.name.length > 0);
      assert.ok(face.hue >= 0 && face.hue < 360);
    }
  }

  assert.equal(resolveTheme('fantasy'), 'fantasy');
  assert.equal(resolveTheme('unknown'), 'orchard');
  assert.equal(resolveTheme(undefined), 'orchard');
});
