/*
 * ai.test.js
 *
 * Zero-dependency tests for the CPU opponent. Run with:
 *   node ai.test.js
 *
 * The core guarantee is legality: across thousands of seeded random game
 * states, chooseAction must always return an action the engine accepts.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');

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

function seededRng(seed) {
  var t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    var r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function card(color, value) { return { color: color, value: value }; }
function sameCard(a, b) { return a.color === b.color && a.value === b.value; }

function stackDeck(topCards) {
  var deck = E.buildDeck();
  var picked = topCards.map(function (spec) {
    for (var k = 0; k < deck.length; k++) {
      if (sameCard(deck[k], spec)) return deck.splice(k, 1)[0];
    }
    throw new Error('stackDeck: no such card left');
  });
  return deck.concat(picked.reverse());
}

function makeGame(hands, flip, config) {
  config = config || {};
  config.numPlayers = hands.length;
  var order = [];
  for (var c = 0; c < 7; c++) {
    for (var p = 0; p < hands.length; p++) order.push(hands[p][c]);
  }
  order.push(flip);
  config._deck = stackDeck(order);
  return E.createGame(config, seededRng(1));
}

var FILLER0 = [card('green', '1'), card('green', '2'), card('green', '3'),
               card('green', '4'), card('green', '6'), card('green', '7'), card('green', '8')];
var FILLER1 = [card('blue', '1'), card('blue', '2'), card('blue', '3'),
               card('blue', '4'), card('blue', '6'), card('blue', '7'), card('blue', '8')];

function trimHand(state, playerIndex, keep) {
  var removed = state.players[playerIndex].hand.splice(keep);
  state.drawPile = removed.concat(state.drawPile);
}

/* ----- strategy unit tests ----- */

test('prefers the color it holds the most of', function () {
  /* Red 3 and blue 5 are both legal on red 5; the hand is heavy in blue. */
  var hand = [card('red', '3'), card('blue', '5'), card('blue', '9'),
              card('blue', 'skip'), card('green', '1'), card('green', '2'),
              card('yellow', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assertEqual(g.players[0].hand[a.cardIndex].color, 'blue');
});

test('holds Wilds while another legal play exists', function () {
  var hand = [card(null, 'wild'), card(null, 'wild4'), card('red', '3'),
              card('green', '1'), card('green', '2'), card('green', '4'),
              card('green', '6')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assert(!E.isWild(g.players[0].hand[a.cardIndex]), 'must not spend a Wild yet');
});

test('plays a Wild when nothing else is legal, declaring the majority color', function () {
  var hand = [card(null, 'wild'), card('green', '1'), card('green', '2'),
              card('green', '4'), card('green', '6'), card('blue', '9'),
              card('blue', '7')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'play');
  assertEqual(g.players[0].hand[a.cardIndex].value, 'wild');
  assertEqual(a.chosenColor, 'green', 'green is the hand majority');
});

test('punishes a next opponent at two or fewer cards with a draw card', function () {
  var hand = [card('red', 'draw2'), card('red', '3'), card('red', '4'),
              card('red', '6'), card('red', '7'), card('red', '8'),
              card('red', '9')];
  var g = makeGame([hand, FILLER1], card('red', '5'));
  trimHand(g, 1, 2);
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(g.players[0].hand[a.cardIndex].value, 'draw2');
});

test('draws when it has no legal play', function () {
  var hand = [card('blue', '9'), card('blue', '7'), card('blue', '1'),
              card('blue', '2'), card('blue', '3'), card('blue', '4'),
              card('blue', '6')];
  var g = makeGame([hand, FILLER0], card('red', '5'));
  var a = AI.chooseAction(g, 0, seededRng(2));
  assertEqual(a.type, 'draw');
});

test('declares Uno unless the injected rng says it forgot', function () {
  var hand = [card('red', '3'), card('red', '4')].concat(FILLER0.slice(0, 5));
  var g = makeGame([hand, FILLER1], card('red', '5'), { cpuForgetUnoChance: 0.5 });
  trimHand(g, 0, 2);
  /* rng below the forget chance means the CPU forgets; at or above, it calls. */
  var forgot = AI.chooseAction(g, 0, function () { return 0.1; });
  assertEqual(forgot.declareUno, false);
  var called = AI.chooseAction(g, 0, function () { return 0.9; });
  assertEqual(called.declareUno, true);
});

test('is deterministic for a given state and seed', function () {
  var g = E.createGame({ numPlayers: 3 }, seededRng(77));
  var a = AI.chooseAction(g, g.currentPlayer, seededRng(5));
  var b = AI.chooseAction(g, g.currentPlayer, seededRng(5));
  assertEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ----- legality soak: thousands of seeded random states ----- */

test('never returns an illegal action across thousands of game states', function () {
  var statesChecked = 0;
  for (var seed = 1; seed <= 60; seed++) {
    var rng = seededRng(seed);
    var s = E.createGame({
      numPlayers: 2 + (seed % 3),
      targetScore: 200,
      stackDraws: seed % 5 === 0
    }, rng);
    var steps = 0;
    while (s.phase !== 'gameOver' && steps < 20000) {
      steps++;
      if (s.phase === 'roundOver') { s = E.startNextRound(s, rng); continue; }
      var action = AI.chooseAction(s, s.currentPlayer, rng);
      statesChecked++;
      if (action.type === 'play') {
        var legal = E.legalPlays(s, s.currentPlayer).some(function (p) {
          return p.cardIndex === action.cardIndex;
        });
        assert(legal, 'seed ' + seed + ' step ' + steps + ': illegal card index');
        /* applyPlay re-validates everything, including the Wild color. */
        s = E.applyPlay(s, action, rng);
      } else {
        assertEqual(action.type, 'draw', 'seed ' + seed + ': unknown action type');
        s = E.applyDraw(s, rng);
      }
      var errors = E.validateState(s);
      assert(errors.length === 0, 'seed ' + seed + ' step ' + steps + ': ' + errors.join('; '));
    }
    assertEqual(s.phase, 'gameOver', 'seed ' + seed + ' must reach game over');
  }
  assert(statesChecked > 5000, 'expected thousands of states, got ' + statesChecked);
  console.log('      (' + statesChecked + ' states checked)');
});

/* ----- run ----- */

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
