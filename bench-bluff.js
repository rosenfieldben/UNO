/*
 * bench-bluff.js
 *
 * Seeded all-CPU playouts that measure Wild Draw Four bluffing with the
 * challenge rule on. Run with:
 *   node bench-bluff.js [--rounds N] [--chances 0,0.1,...]
 *                       [--victims cpu|accept|challenge] [--breakeven]
 *
 * Not a test: the name keeps it out of `node --test` on purpose, since
 * it takes a minute or more and its job is to inform a choice, not to
 * pass.
 *
 * For each chance and table size (2, 3 and 4 players) it reports:
 *
 * 1. Bluff share. Every seat bluffs at the given cpuBluffChance, as in a
 *    real game where all CPUs share one config. For each CPU Wild Draw
 *    Four it records whether the play was guilty (the engine's own
 *    snapshot, pendingChallenge.hadColorMatch, so it is the verdict a
 *    challenge would get). A Wild Draw Four played as a last card is
 *    counted apart: it is innocent by construction and visibly so, so it
 *    is not a challenge decision. The rest are split the ways a player at
 *    the table can see: the victim's hand size when the card was played
 *    (1 to 2 cards, 3 or more), the offender's hand size after playing
 *    it, and whether the declared color is the one already in play. A
 *    share that moves with any of these is a tell.
 *
 * 2. Win rate. One seat bluffs at the given chance and every other seat
 *    plays with cpuBluffChance 0, the AI as it was before bluffing. The
 *    bluffing seat rotates every round, so seat order cancels out. Each
 *    round is also replayed from the same seed with every seat at 0, and
 *    the difference between the two is the cost or gain of bluffing.
 *    Comparing on the same seeds removes the luck of the deal, which a
 *    comparison against a fair 1/n share does not.
 *
 * 3. With --breakeven, what a challenge is worth in round wins rather
 *    than cards. At every challengeable CPU Wild Draw Four in pass 1 the
 *    game is forked, the victim accepts in one copy and challenges in
 *    the other, and both play out from the same seed. G is the victim's
 *    gain in round wins from challenging a guilty play, L the loss from
 *    challenging an innocent one, and challenging pays when the share of
 *    guilty plays is above L / (L + G). It is several times slower.
 *
 * Every round is its own seeded game, played to its first round end.
 * Each pass and table size has its own block of seeds, and every chance
 * reuses the same seeds so chances compare like for like. By default
 * victims decide with the AI's own decideChallenge, exactly as CPU
 * victims do in the browser; --victims accept or challenge makes every
 * victim always do that instead, which brackets how a person might
 * answer, since what a bluff is worth depends on how often it is called.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');
var U = require('./testutil.js');

/* Seed blocks: seeds are (base + players) * 1e6 + round, so --rounds must stay below 1e6. */
var SEEDS = { share: 10, winRate: 20, fork: 30 };

function parseArgs(argv) {
  var opts = { rounds: 20000, chances: null, victims: 'cpu', breakeven: false };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--rounds') opts.rounds = Number(argv[++i]);
    else if (argv[i] === '--chances') opts.chances = argv[++i].split(',').map(Number);
    else if (argv[i] === '--victims') opts.victims = argv[++i];
    else if (argv[i] === '--breakeven') opts.breakeven = true;
    else throw new Error('unknown argument: ' + argv[i]);
  }
  if (!(Number.isInteger(opts.rounds) && opts.rounds > 0 && opts.rounds < 1e6)) {
    throw new Error('--rounds must be a whole number from 1 to 999999');
  }
  if (['cpu', 'accept', 'challenge'].indexOf(opts.victims) === -1) {
    throw new Error('--victims must be cpu, accept or challenge');
  }
  if (!opts.chances) {
    /* Today's default, and 0 for the AI as it was before bluffing. */
    var shipped = E.createGame({ numPlayers: 2 }, U.seededRng(1)).config.cpuBluffChance;
    opts.chances = shipped > 0 ? [0, shipped] : [0];
  }
  if (opts.chances.some(function (c) { return !(c >= 0 && c <= 1); })) {
    throw new Error('--chances must be numbers from 0 to 1');
  }
  return opts;
}

/* The same state with a different cpuBluffChance, for one seat's decision. */
function withChance(state, chance) {
  var view = Object.assign({}, state);
  view.config = Object.assign({}, state.config, { cpuBluffChance: chance });
  return view;
}

function challenges(victims, state, seat, rng) {
  if (victims === 'accept') return false;
  if (victims === 'challenge') return true;
  return AI.decideChallenge(state, seat, rng);
}

/*
 * Plays from state s until the round ends, every seat driven by the AI.
 * chanceFor(seat) gives each seat's cpuBluffChance. onWild4, if given,
 * sees every Wild Draw Four the moment it lands, along with the states
 * before and after it. Returns the final state.
 */
function playOut(s, rng, chanceFor, victims, onWild4) {
  for (var steps = 0; s.phase === 'playing'; steps++) {
    if (steps > 100000) throw new Error('round did not finish');
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
    var next = E.applyPlay(s, action, rng);
    if (onWild4 && card.value === 'wild4' && next.pendingChallenge) onWild4(s, next, action);
    s = next;
  }
  return s;
}

function newRound(seed, numPlayers) {
  var rng = U.seededRng(seed);
  return { rng: rng, state: E.createGame({ numPlayers: numPlayers, targetScore: 1e9, challengeRule: true }, rng) };
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

/* Mean of a list of per-round differences, with its 95% interval, in points. */
function meanCI(diffs) {
  var n = diffs.length, m = 0, v = 0;
  diffs.forEach(function (d) { m += d; });
  m /= n;
  diffs.forEach(function (d) { v += (d - m) * (d - m); });
  var h = 1.96 * Math.sqrt(v / (n - 1) / n);
  function f(x) { return (x >= 0 ? '+' : '') + (100 * x).toFixed(2); }
  return f(m) + ' [' + f(m - h) + ', ' + f(m + h) + ']';
}

function tally() { return [0, 0]; }
function add(t, hit) { t[1]++; if (hit) t[0]++; }

/* Pass 1, and pass 3 when asked: bluff share, tells, and the fork. */
function bluffShare(numPlayers, chance, opts) {
  var t = {
    lastCard: 0, all: tally(), low: tally(), high: tally(),
    off12: tally(), off34: tally(), off5: tally(), sameBluff: tally(), sameHonest: tally(),
    fork: { gain: [], loss: [] }
  };
  function every() { return chance; }
  for (var r = 0; r < opts.rounds; r++) {
    var seed = (SEEDS.share + numPlayers) * 1e6 + r;
    var g = newRound(seed, numPlayers);
    var forks = 0;
    playOut(g.state, g.rng, every, opts.victims, function (before, after, action) {
      var seat = before.currentPlayer;
      var offenderLeft = after.players[seat].hand.length;
      if (offenderLeft === 0) { t.lastCard++; return; }
      var guilty = after.pendingChallenge.hadColorMatch;
      var victim = after.pendingChallenge.victim;
      var low = before.players[victim].hand.length <= 2;
      add(t.all, guilty);
      add(low ? t.low : t.high, guilty);
      if (low) add(offenderLeft <= 2 ? t.off12 : offenderLeft <= 4 ? t.off34 : t.off5, guilty);
      add(guilty ? t.sameBluff : t.sameHonest, action.chosenColor === before.currentColor);
      if (opts.breakeven && low) {
        /*
         * Both copies replay from one fork seed, so they differ only in
         * the victim's answer. 64 forks per round is far above the most
         * Wild Draw Fours a round can hold.
         */
        var forkSeed = (SEEDS.fork + numPlayers) * 1e8 + r * 64 + (forks++);
        var accepted = playOut(E.applyDraw(after, U.seededRng(forkSeed)), U.seededRng(forkSeed + 1), every, opts.victims);
        var challenged = playOut(E.applyChallenge(after, U.seededRng(forkSeed)), U.seededRng(forkSeed + 1), every, opts.victims);
        var d = (challenged.roundWinner === victim ? 1 : 0) - (accepted.roundWinner === victim ? 1 : 0);
        (guilty ? t.fork.gain : t.fork.loss).push(d);
      }
    });
  }
  return t;
}

/* Pass 2: one rotating bluffer against non-bluffers, and the same seeds without it. */
function winRate(numPlayers, chance, opts) {
  var wins = 0, control = 0, diffs = [];
  for (var r = 0; r < opts.rounds; r++) {
    var bluffer = r % numPlayers;
    var seed = (SEEDS.winRate + numPlayers) * 1e6 + r;
    var a = newRound(seed, numPlayers);
    var won = playOut(a.state, a.rng, function (seat) { return seat === bluffer ? chance : 0; }, opts.victims)
      .roundWinner === bluffer ? 1 : 0;
    var b = newRound(seed, numPlayers);
    var wonAnyway = playOut(b.state, b.rng, function () { return 0; }, opts.victims).roundWinner === bluffer ? 1 : 0;
    wins += won;
    control += wonAnyway;
    diffs.push(won - wonAnyway);
  }
  return { wins: wins, control: control, rounds: opts.rounds, diff: meanCI(diffs) };
}

function main() {
  var opts = parseArgs(process.argv);
  console.log('Rounds per table size: ' + opts.rounds + '. Challenge rule on, stacking off. Victims: ' +
    { cpu: 'the CPU challenge rule', accept: 'always accept', challenge: 'always challenge' }[opts.victims] + '.');
  console.log('Guilty = the CPU held the color in play when it played the Wild Draw Four. Shares leave out');
  console.log('Wild Draw Fours played as a last card, which are innocent by construction.');
  opts.chances.forEach(function (chance) {
    console.log('\ncpuBluffChance ' + chance);
    console.log('players | W+4 guilty (95% CI)          last card | victim 1-2: n  guilty | victim 3+: n  guilty |' +
      ' at victim 1-2, offender left 1-2  3-4   5+ | same color: bluff  honest');
    var rows = [2, 3, 4].map(function (n) {
      var t = bluffShare(n, chance, opts);
      console.log(
        String(n).padStart(7) + ' | ' + String(t.all[1]).padStart(5) + ' ' + pct(t.all[0], t.all[1]) + ' ' +
        wilson(t.all[0], t.all[1]).padEnd(13) + String(t.lastCard).padStart(10) + ' | ' +
        String(t.low[1]).padStart(12) + ' ' + pct(t.low[0], t.low[1]) + ' | ' +
        String(t.high[1]).padStart(11) + ' ' + pct(t.high[0], t.high[1]) + ' |' +
        pct(t.off12[0], t.off12[1]).padStart(33) + ' ' + pct(t.off34[0], t.off34[1]) + ' ' + pct(t.off5[0], t.off5[1]) + ' |' +
        pct(t.sameBluff[0], t.sameBluff[1]).padStart(19) + ' ' + pct(t.sameHonest[0], t.sameHonest[1]).padStart(7)
      );
      return { n: n, t: t };
    });
    if (chance > 0) {
      console.log('players | bluffer round wins   same seeds, nobody bluffing   difference in points (95% CI)');
      [2, 3, 4].forEach(function (n) {
        var w = winRate(n, chance, opts);
        console.log(String(n).padStart(7) + ' | ' + pct(w.wins, w.rounds).padStart(18) + ' ' +
          pct(w.control, w.rounds).padStart(29) + '   ' + w.diff);
      });
    }
    if (opts.breakeven) {
      console.log('players | victim 1-2: gain G if guilty (n)   loss L if honest (n)   break-even L/(L+G)   guilty share');
      rows.forEach(function (row) {
        var f = row.t.fork;
        var G = f.gain.length ? f.gain.reduce(function (a, b) { return a + b; }, 0) / f.gain.length : NaN;
        var L = f.loss.length ? -f.loss.reduce(function (a, b) { return a + b; }, 0) / f.loss.length : NaN;
        var be = isFinite(G) && isFinite(L) ? (100 * L / (L + G)).toFixed(1) + '%' : 'n/a';
        console.log(String(row.n).padStart(7) + ' | ' +
          ((isFinite(G) ? (100 * G).toFixed(1) + ' pts' : 'n/a') + ' (' + f.gain.length + ')').padStart(32) + ' ' +
          ((isFinite(L) ? (100 * L).toFixed(1) + ' pts' : 'n/a') + ' (' + f.loss.length + ')').padStart(21) + ' ' +
          be.padStart(20) + ' ' + pct(row.t.low[0], row.t.low[1]).padStart(14));
      });
    }
  });
}

main();
