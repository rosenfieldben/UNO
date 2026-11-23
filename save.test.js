/*
 * save.test.js
 *
 * Zero-dependency tests for save.js, run with `node save.test.js` or as
 * part of `node --test`. Storage is faked so each failure save.js has to
 * survive (no storage, a localStorage getter that throws, every call
 * throwing, writes refused as when full) happens on cue, and all game
 * states come from seeded games so every run is identical.
 *
 * No saved string is pinned here. Each test builds its saves through
 * encode or from VERSION, so the tests describe the rules for accepting
 * a save rather than freezing one particular encoding.
 */
'use strict';

var assertNode = require('assert');
var E = require('./engine.js');
var S = require('./save.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assert = U.assert, assertEqual = U.assertEqual;
var seededRng = U.seededRng;

/* ----- helpers ----- */

/* A working in-memory stand-in for localStorage. */
function memoryStorage() {
  var items = {};
  return {
    items: items,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(items, k) ? items[k] : null; },
    setItem: function (k, v) { items[k] = String(v); },
    removeItem: function (k) { delete items[k]; }
  };
}

/* Storage where every call throws, as when the browser blocks it. */
function throwingStorage() {
  function fail() { throw new Error('SecurityError: storage is blocked'); }
  return { getItem: fail, setItem: fail, removeItem: fail };
}

/* Storage that reads and deletes fine but refuses writes, as when full. */
function fullStorage(start) {
  var s = memoryStorage();
  if (start) s.items[S.KEY] = start;
  s.setItem = function () { throw new Error('QuotaExceededError'); };
  return s;
}

/*
 * Node's own deep comparison, which also sees what a JSON string would
 * hide (a key present but undefined, NaN, -0). Still zero-dependency.
 */
function same(a, b) {
  try {
    assertNode.deepStrictEqual(a, b);
    return true;
  } catch (e) {
    return false;
  }
}

/*
 * One seeded legal step, chosen the same way as the engine soak tests.
 * Taking the rng as a parameter lets two copies of a game be driven by
 * identical rngs and compared move for move.
 */
function step(s, rng) {
  if (s.phase === 'roundOver') return E.startNextRound(s, rng);
  if (s.pendingChallenge && rng() < 0.5) return E.applyChallenge(s, rng);
  var plays = E.legalPlays(s, s.currentPlayer);
  if (plays.length) {
    var pick = plays[Math.floor(rng() * plays.length)];
    var action = {
      type: 'play', playerIndex: s.currentPlayer, cardIndex: pick.cardIndex,
      declareUno: rng() < 0.8
    };
    if (E.isWild(pick.card)) action.chosenColor = E.COLORS[Math.floor(rng() * 4)];
    return E.applyPlay(s, action, rng);
  }
  if (s.pendingDraw) return E.applyPass(s);
  return E.applyDraw(s, rng);
}

/* Plays a seeded game until stop(state) is true, or to its end. */
function playUntil(seed, config, stop) {
  var rng = seededRng(seed);
  var s = E.createGame(config, rng);
  for (var i = 0; i < 20000 && s.phase !== 'gameOver' && !stop(s); i++) s = step(s, rng);
  return s;
}

/* ----- encode and decode ----- */

test('a fresh game round-trips unchanged at every table size', function () {
  [2, 3, 4].forEach(function (n) {
    var g = E.createGame({ numPlayers: n, challengeRule: true }, seededRng(n));
    var back = S.decode(S.encode(g));
    assert(back !== null, n + ' players: decoded to null');
    assert(same(back, g), n + ' players: decoded state differs');
  });
});

test('a save holds the version and the engine state and nothing else', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(1));
  var data = JSON.parse(S.encode(g));
  assertEqual(data.version, S.VERSION);
  assert(same(data.state, g), 'state is stored as is');
  assertEqual(Object.keys(data).length, 2, 'no other fields');
});

test('every state of seeded games survives a save, and plays on identically', function () {
  /*
   * Restore checked two ways at every step: the rebuilt state is deeply
   * equal to the original, and driven by an identical rng it makes
   * exactly the same next move. Challenge and stacking windows, Uno
   * windows, pending draws, and round summaries all come up along the
   * way.
   */
  for (var seed = 500; seed < 512; seed++) {
    var config = {
      numPlayers: 2 + (seed % 3), targetScore: 150,
      challengeRule: seed % 2 === 0, stackDraws: seed % 3 === 0
    };
    var rng = seededRng(seed);
    var s = E.createGame(config, rng);
    for (var i = 0; i < 20000 && s.phase !== 'gameOver'; i++) {
      var restored = S.decode(S.encode(s));
      assert(restored !== null, 'seed ' + seed + ' step ' + i + ': save rejected');
      assert(same(restored, s), 'seed ' + seed + ' step ' + i + ': save changed the state');
      var probe = seededRng(seed * 100000 + i);
      var twin = seededRng(seed * 100000 + i);
      assert(same(step(restored, probe), step(s, twin)),
        'seed ' + seed + ' step ' + i + ': restored game played on differently');
      s = step(s, rng);
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must finish');
  }
});

test('anything that is not a current, well-formed save decodes to null', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(2));
  var bad = [
    undefined, null, 42, {}, '', 'not json', '{', 'null', '42', '"text"', '[]', '{}',
    JSON.stringify({ state: g }),
    JSON.stringify({ version: String(S.VERSION), state: g }),
    JSON.stringify({ version: S.VERSION + 1, state: g }),
    JSON.stringify({ version: S.VERSION - 1, state: g }),
    JSON.stringify({ version: S.VERSION }),
    JSON.stringify({ version: S.VERSION, state: null }),
    JSON.stringify({ version: S.VERSION, state: [] }),
    JSON.stringify({ version: S.VERSION, state: 'game' }),
    JSON.stringify([S.VERSION, g])
  ];
  bad.forEach(function (input, i) {
    assertEqual(S.decode(input), null, 'input #' + i);
  });
});

test('a state that fails validateState is never restored', function () {
  var g = E.createGame({ numPlayers: 3 }, seededRng(4));
  function broken(mutate) {
    var copy = JSON.parse(JSON.stringify(g));
    mutate(copy);
    return S.encode(copy);
  }
  var cases = {
    'a lost card': function (s) { s.drawPile.pop(); },
    'a duplicated card': function (s) { s.drawPile.push(JSON.parse(JSON.stringify(s.players[0].hand[0]))); },
    'a bad phase': function (s) { s.phase = 'paused'; },
    'a seat out of range': function (s) { s.currentPlayer = 3; },
    'a player missing': function (s) { s.players.pop(); },
    'no config': function (s) { delete s.config; }
  };
  Object.keys(cases).forEach(function (name) {
    assertEqual(S.decode(broken(cases[name])), null, name);
  });
});

test('a state that makes validateState throw is rejected, not thrown', function () {
  /* Each of these really does throw inside validateState; decode must not. */
  var g = E.createGame({ numPlayers: 2 }, seededRng(5));
  function broken(mutate) {
    var copy = JSON.parse(JSON.stringify(g));
    mutate(copy);
    return copy;
  }
  var cases = [
    broken(function (s) { delete s.players; }),
    broken(function (s) { delete s.players[1].hand; }),
    broken(function (s) { s.players[0].hand.push(null); }),
    broken(function (s) { s.drawPile = 'cards'; })
  ];
  cases.forEach(function (s, i) {
    var threw = false;
    try { E.validateState(s); } catch (e) { threw = true; }
    assert(threw, 'case ' + i + ' should make validateState throw');
    assertEqual(S.decode(S.encode(s)), null, 'case ' + i);
  });
});

/* ----- storage ----- */

test('persist then load returns the game in progress', function () {
  var store = memoryStorage();
  var g = playUntil(7, { numPlayers: 3, challengeRule: true }, function (s) { return s.round === 1 && s.discardPile.length > 6; });
  assertEqual(g.phase, 'playing');
  assertEqual(S.persist(store, g), true);
  assert(typeof store.items[S.KEY] === 'string', 'written under the save key');
  assert(same(S.load(store), g), 'loaded state differs');
});

test('the newest persist wins', function () {
  var store = memoryStorage();
  var rng = seededRng(8);
  var a = E.createGame({ numPlayers: 2 }, rng);
  var b = step(a, rng);
  S.persist(store, a);
  S.persist(store, b);
  assert(same(S.load(store), b), 'load returns the latest state');
});

test('a game paused on a round summary is saved and comes back on it', function () {
  var store = memoryStorage();
  var g = playUntil(9, { numPlayers: 2, targetScore: 2000 }, function (s) { return s.phase === 'roundOver'; });
  assertEqual(g.phase, 'roundOver');
  assertEqual(S.persist(store, g), true);
  assertEqual(S.load(store).phase, 'roundOver');
});

test('a finished game clears the save instead of storing it', function () {
  var store = memoryStorage();
  var g = playUntil(10, { numPlayers: 2, targetScore: 100 }, function () { return false; });
  assertEqual(g.phase, 'gameOver');
  S.persist(store, E.createGame({ numPlayers: 2 }, seededRng(11)));
  assertEqual(S.persist(store, g), false);
  assert(!(S.KEY in store.items), 'save removed');
  assertEqual(S.load(store), null);
});

test('persisting no state at all clears the save', function () {
  var store = memoryStorage();
  S.persist(store, E.createGame({ numPlayers: 2 }, seededRng(12)));
  assertEqual(S.persist(store, null), false);
  assert(!(S.KEY in store.items), 'save removed');
});

test('clear removes the save, and load then finds nothing', function () {
  var store = memoryStorage();
  S.persist(store, E.createGame({ numPlayers: 2 }, seededRng(13)));
  S.clear(store);
  assert(!(S.KEY in store.items), 'save removed');
  assertEqual(S.load(store), null);
});

test('load with nothing saved returns null and writes nothing', function () {
  var store = memoryStorage();
  assertEqual(S.load(store), null);
  assertEqual(Object.keys(store.items).length, 0);
});

test('an invalid save is discarded on load', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(14));
  [
    'garbage',
    JSON.stringify({ version: S.VERSION + 1, state: g }),
    S.encode(Object.assign({}, g, { drawPile: g.drawPile.slice(1) }))
  ].forEach(function (text, i) {
    var store = memoryStorage();
    store.items[S.KEY] = text;
    assertEqual(S.load(store), null, 'case ' + i);
    assert(!(S.KEY in store.items), 'case ' + i + ': bad save left behind');
  });
});

test('other keys in the same storage are never touched', function () {
  /* On GitHub Pages one origin's storage is shared by every project. */
  var store = memoryStorage();
  store.items['someOtherApp'] = 'keep me';
  S.persist(store, E.createGame({ numPlayers: 2 }, seededRng(15)));
  S.load(store);
  S.clear(store);
  store.items[S.KEY] = 'garbage';
  S.load(store);
  assertEqual(store.items['someOtherApp'], 'keep me');
  assertEqual(Object.keys(store.items).join(','), 'someOtherApp');
});

test('missing storage never throws and never restores', function () {
  var g = E.createGame({ numPlayers: 2 }, seededRng(16));
  [null, undefined].forEach(function (store) {
    assertEqual(S.load(store), null);
    assertEqual(S.persist(store, g), false);
    S.clear(store);
  });
});

test('storage that throws on every call never throws out of save.js', function () {
  var store = throwingStorage();
  var g = E.createGame({ numPlayers: 2 }, seededRng(17));
  assertEqual(S.load(store), null);
  assertEqual(S.persist(store, g), false);
  S.clear(store);
});

test('a write that fails leaves no older save behind', function () {
  /*
   * Resuming the older save would rewind the game, so a failed write
   * clears it: after a reload there is either the latest state or none.
   */
  var rng = seededRng(18);
  var older = E.createGame({ numPlayers: 2 }, rng);
  var newer = step(older, rng);
  var store = fullStorage(S.encode(older));
  assert(same(S.load(store), older), 'precondition: older save present');
  assertEqual(S.persist(store, newer), false);
  assert(!(S.KEY in store.items), 'older save removed');
  assertEqual(S.load(store), null);
});

test('storageFrom tolerates a missing or blocked localStorage', function () {
  var real = memoryStorage();
  assertEqual(S.storageFrom({ localStorage: real }), real);
  assertEqual(S.storageFrom({}), null);
  assertEqual(S.storageFrom(null), null);
  assertEqual(S.storageFrom(undefined), null);
  /* Browsers throw on merely reading the property when storage is blocked. */
  var blocked = {};
  Object.defineProperty(blocked, 'localStorage', {
    get: function () { throw new Error('SecurityError: access denied'); }
  });
  assertEqual(S.storageFrom(blocked), null);
});

run();
