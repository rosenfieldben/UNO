/*
 * testutil.js
 *
 * Shared helpers for the zero-dependency test suites. Node-only: the
 * suites run with `node engine.test.js` / `node ai.test.js`, so a plain
 * module.exports is enough. Extracted into one module so the seeded rng,
 * the deck-stacking convention, and the runner cannot drift between the
 * two suites.
 */
'use strict';

var E = require('./engine.js');

/* ----- tiny test runner ----- */

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual') + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}
function assertThrows(fn, msg) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || 'expected an exception');
}
function assertValid(state, msg) {
  var errors = E.validateState(state);
  if (errors.length) {
    throw new Error((msg || 'state invalid') + ': ' + errors.join('; '));
  }
}

function run() {
  var failed = 0;
  tests.forEach(function (t) {
    try {
      t.fn();
      console.log('ok    ' + t.name);
    } catch (e) {
      failed++;
      console.error('FAIL  ' + t.name);
      console.error('      ' + e.message);
    }
  });
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
  if (failed > 0) process.exit(1);
}

/* ----- deterministic rng (mulberry32) ----- */

function seededRng(seed) {
  var t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    var r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----- deck and state builders ----- */

function card(color, value) { return { color: color, value: value }; }

function sameCard(a, b) { return a.color === b.color && a.value === b.value; }

/*
 * Builds a full 108-card deck where the cards in topCards are drawn
 * first, in order (cards are drawn with pop(), so the first requested
 * card sits at the end of the array).
 */
function stackDeck(topCards) {
  var deck = E.buildDeck();
  var picked = topCards.map(function (spec) {
    var i = -1;
    for (var k = 0; k < deck.length; k++) {
      if (sameCard(deck[k], spec)) { i = k; break; }
    }
    if (i === -1) throw new Error('stackDeck: no such card left: ' + spec.color + ' ' + spec.value);
    return deck.splice(i, 1)[0];
  });
  return deck.concat(picked.reverse());
}

/*
 * With numPlayers players, dealing interleaves seats: pops 0..7n-1 go to
 * seats 0,1,..,n-1 repeating, and pop 7n is the first flip. This builds
 * the topCards list for stackDeck from per-seat hands plus a flip card.
 */
function dealOrder(hands, flip) {
  var order = [];
  for (var c = 0; c < 7; c++) {
    for (var p = 0; p < hands.length; p++) order.push(hands[p][c]);
  }
  order.push(flip);
  return order;
}

function makeGame(hands, flip, config) {
  config = config || {};
  config.numPlayers = hands.length;
  config._deck = stackDeck(dealOrder(hands, flip));
  return E.createGame(config, seededRng(config.seed || 1));
}

/* Seven filler cards per seat that never interact with a red-number top. */
var FILLER = {
  0: [card('green', '1'), card('green', '2'), card('green', '3'), card('green', '4'),
      card('green', '6'), card('green', '7'), card('green', '8')],
  1: [card('blue', '1'), card('blue', '2'), card('blue', '3'), card('blue', '4'),
      card('blue', '6'), card('blue', '7'), card('blue', '8')],
  2: [card('yellow', '1'), card('yellow', '2'), card('yellow', '3'), card('yellow', '4'),
      card('yellow', '6'), card('yellow', '7'), card('yellow', '8')]
};

/* Moves the first drawPile card matching spec into the given hand, keeping
 * conservation intact. Used to shrink or shape hands mid-test. */
function moveToHand(state, playerIndex, spec) {
  for (var i = 0; i < state.drawPile.length; i++) {
    if (sameCard(state.drawPile[i], spec)) {
      state.players[playerIndex].hand.push(state.drawPile.splice(i, 1)[0]);
      return;
    }
  }
  throw new Error('moveToHand: card not in draw pile');
}

/* Moves all but the first `keep` cards of a hand to the bottom of the
 * draw pile (bottom = index 0, since draws pop from the end). */
function trimHand(state, playerIndex, keep) {
  var hand = state.players[playerIndex].hand;
  var removed = hand.splice(keep);
  state.drawPile = removed.concat(state.drawPile);
}

module.exports = {
  test: test,
  run: run,
  assert: assert,
  assertEqual: assertEqual,
  assertThrows: assertThrows,
  assertValid: assertValid,
  seededRng: seededRng,
  card: card,
  sameCard: sameCard,
  stackDeck: stackDeck,
  dealOrder: dealOrder,
  makeGame: makeGame,
  FILLER: FILLER,
  moveToHand: moveToHand,
  trimHand: trimHand
};
