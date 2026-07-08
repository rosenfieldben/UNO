/*
 * ai.test.js
 *
 * Zero-dependency tests for the CPU opponent. Run with:
 *   node ai.test.js
 *
 * Runner, seeded rng, and deck-stacking helpers are shared with
 * engine.test.js via testutil.js. The core guarantee is legality: across
 * thousands of seeded random game states, chooseAction must always
 * return an action the engine accepts.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');
var U = require('./testutil.js');

var test = U.test, run = U.run;
var assert = U.assert, assertEqual = U.assertEqual;
var seededRng = U.seededRng, card = U.card;
var makeGame = U.makeGame, trimHand = U.trimHand;
var FILLER0 = U.FILLER[0], FILLER1 = U.FILLER[1];

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

run();
