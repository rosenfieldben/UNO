/*
 * bench-bluff.js
 *
 * Seeded all-CPU playouts that measure Wild Draw Four bluffing with the
 * challenge rule on. Run with:
 *   node bench-bluff.js [--rounds N] [--chances 0,0.1,...] [--victims cpu|accept|challenge]
 *
 * Not a test: the name keeps it out of `node --test` on purpose, since
 * it takes minutes and its job is to inform a choice, not to pass.
 *
 * Two measurements per table size (2, 3 and 4 players):
 *
 * 1. Bluff share. Every seat bluffs at the given cpuBluffChance, as in a
 *    real game where all CPUs share one config. For each CPU Wild Draw
 *    Four it records whether the play was guilty (the engine's own
 *    snapshot, pendingChallenge.hadColorMatch, so it is the verdict a
 *    challenge would get), split by the victim's hand size when the card
 *    was played (1 to 2 cards, 3 or more). Those are the facts a player
 *    at the table can see, so a gap between the two buckets is a tell.
 *    It also counts how often the declared color is the one already in
 *    play, another thing visible from the table.
 *
 * 2. Win rate. One seat bluffs at the given chance and every other seat
 *    plays with cpuBluffChance 0, which is the AI as it was before
 *    bluffing. The bluffing seat rotates every round, so seat order
 *    cancels out. A win rate above 1/n means bluffing helps that CPU.
 *
 * Each round is its own seeded game, played to its first round end, so
 * every number here is reproducible. By default victims decide with the
 * AI's own decideChallenge, exactly as CPU victims do in the browser.
 * --victims accept or challenge makes every victim always do that
 * instead, which brackets how a person might answer: how much a bluff
 * is worth depends on how often it gets called.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');
var U = require('./testutil.js');

function parseArgs(argv) {
  var opts = { rounds: 20000, chances: null, victims: 'cpu' };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--rounds') opts.rounds = parseInt(argv[++i], 10);
    else if (argv[i] === '--chances') opts.chances = argv[++i].split(',').map(Number);
    else if (argv[i] === '--victims') opts.victims = argv[++i];
    else throw new Error('unknown argument: ' + argv[i]);
  }
  if (['cpu', 'accept', 'challenge'].indexOf(opts.victims) === -1) {
    throw new Error('--victims must be cpu, accept or challenge');
  }
  if (!opts.chances) {
    /* Today's default, and 0 for the AI as it was before bluffing. */
    var shipped = E.createGame({ numPlayers: 2 }, U.seededRng(1)).config.cpuBluffChance;
    opts.chances = shipped > 0 ? [0, shipped] : [0];
  }
  return opts;
}

/* The same state with a different cpuBluffChance, for one seat's decision. */
function withChance(state, chance) {
  var view = Object.assign({}, state);
  view.config = Object.assign({}, state.config, { cpuBluffChance: chance });
  return view;
}

/*
 * Plays one seeded round with every seat driven by the AI. chanceFor(seat)
 * gives each seat's cpuBluffChance. onWild4 sees every Wild Draw Four the
 * moment it lands. Returns the round winner.
 */
function playRound(seed, numPlayers, chanceFor, onWild4, victims) {
  var rng = U.seededRng(seed);
  var s = E.createGame({ numPlayers: numPlayers, targetScore: 1e9, challengeRule: true }, rng);
  for (var steps = 0; s.phase === 'playing'; steps++) {
    if (steps > 100000) throw new Error('round did not finish: seed ' + seed);
    var seat = s.currentPlayer;
    var view = withChance(s, chanceFor(seat));
    if (s.pendingChallenge && s.pendingChallenge.victim === seat && challenges(victims, view, seat, rng)) {
      s = E.applyChallenge(s, rng);
      continue;
    }
    var action = AI.chooseAction(view, seat, rng);
    if (action.type === 'draw') {
      s = E.applyDraw(s, rng);
      continue;
    }
    var card = s.players[seat].hand[action.cardIndex];
    var priorColor = s.currentColor;
    var next = E.applyPlay(s, action, rng);
    if (card.value === 'wild4' && next.pendingChallenge) {
      onWild4({
        seat: seat,
        guilty: next.pendingChallenge.hadColorMatch,
        victimCards: s.players[next.pendingChallenge.victim].hand.length,
        sameColor: action.chosenColor === priorColor
      });
    }
    s = next;
  }
  return s.roundWinner;
}

function challenges(victims, state, seat, rng) {
  if (victims === 'accept') return false;
  if (victims === 'challenge') return true;
  return AI.decideChallenge(state, seat, rng);
}

function pct(k, n) {
  return n === 0 ? '   n/a' : (100 * k / n).toFixed(1).padStart(5) + '%';
}

/* 95% Wilson interval, which stays sensible near 0 and 1. */
function wilson(k, n) {
  if (n === 0) return '';
  var z = 1.96, p = k / n, d = 1 + z * z / n;
  var c = (p + z * z / (2 * n)) / d;
  var h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return '[' + (100 * Math.max(0, c - h)).toFixed(1) + ', ' + (100 * Math.min(1, c + h)).toFixed(1) + ']';
}

function bluffShare(numPlayers, chance, rounds, victims) {
  var t = { all: [0, 0], low: [0, 0], high: [0, 0], sameBluff: [0, 0], sameHonest: [0, 0] };
  for (var r = 0; r < rounds; r++) {
    playRound(1000000 * numPlayers + r, numPlayers, function () { return chance; }, function (w) {
      var bucket = w.victimCards <= 2 ? t.low : t.high;
      t.all[1]++; bucket[1]++;
      if (w.guilty) { t.all[0]++; bucket[0]++; }
      var same = w.guilty ? t.sameBluff : t.sameHonest;
      same[1]++;
      if (w.sameColor) same[0]++;
    }, victims);
  }
  return t;
}

function winRate(numPlayers, chance, rounds, victims) {
  var wins = 0;
  for (var r = 0; r < rounds; r++) {
    var bluffer = r % numPlayers;
    var winner = playRound(2000000 * numPlayers + r, numPlayers, function (seat) {
      return seat === bluffer ? chance : 0;
    }, function () {}, victims);
    if (winner === bluffer) wins++;
  }
  return [wins, rounds];
}

function main() {
  var opts = parseArgs(process.argv);
  console.log('Rounds per table size: ' + opts.rounds + '. Challenge rule on, stacking off. Victims: ' +
    { cpu: 'the CPU challenge rule', accept: 'always accept', challenge: 'always challenge' }[opts.victims] + '.');
  console.log('Guilty = the CPU held the color in play when it played the Wild Draw Four.\n');
  console.log('chance  players | W+4 plays  guilty (95% CI)          | victim 1-2: n  guilty | victim 3+: n  guilty |' +
    ' same color: bluff  honest | bluffer win (95% CI)    vs fair');
  opts.chances.forEach(function (chance) {
    [2, 3, 4].forEach(function (n) {
      var t = bluffShare(n, chance, opts.rounds, opts.victims);
      var w = chance === 0 ? null : winRate(n, chance, opts.rounds, opts.victims);
      console.log(
        String(chance).padStart(6) + '  ' + String(n).padStart(7) + ' | ' +
        String(t.all[1]).padStart(9) + ' ' + pct(t.all[0], t.all[1]) + ' ' + wilson(t.all[0], t.all[1]).padEnd(16) + ' | ' +
        String(t.low[1]).padStart(12) + ' ' + pct(t.low[0], t.low[1]) + ' | ' +
        String(t.high[1]).padStart(11) + ' ' + pct(t.high[0], t.high[1]) + ' | ' +
        pct(t.sameBluff[0], t.sameBluff[1]).padStart(18) + ' ' + pct(t.sameHonest[0], t.sameHonest[1]).padStart(7) + ' | ' +
        (w ? pct(w[0], w[1]) + ' ' + wilson(w[0], w[1]).padEnd(14) + '  ' + pct(1, n) : 'baseline')
      );
    });
  });
}

main();
