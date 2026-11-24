/*
 * bench-bluff.js
 *
 * Seeded all-CPU playouts that measure Wild Draw Four bluffing with the
 * challenge rule on. Run with:
 *   node bench-bluff.js [--rounds N] [--chances 0,0.1,...]
 *                       [--victims cpu|accept|challenge] [--breakeven] [--stack]
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
 * 3. With --breakeven, what a challenge is worth in play rather than in
 *    cards. At every challengeable CPU Wild Draw Four in pass 1 played at
 *    a victim holding one or two cards, the game is forked, the victim
 *    challenges in one copy and does not in the other, and both play out
 *    from the same seed. Not challenging means the victim's own next
 *    move: taking the total, or with --stack answering with its own Wild
 *    Draw Four when it holds one, as the CPU always does. G is the victim's gain from challenging a guilty
 *    play, L the loss from challenging an innocent one, and challenging
 *    pays when the share of guilty plays is above L / (L + G). The last
 *    column is the mean gain from challenging every one of them, which
 *    answers the same question at the CPU's real bluff rate, with an
 *    interval, and without dividing one noisy number by another.
 *
 *    Two yardsticks, because they can disagree. Round wins count only
 *    who goes out. Points are the victim's side of the score margin: the
 *    round's points if it goes out, otherwise minus the points left in
 *    its hand, which is what it hands the winner. In a two-player game
 *    that is exactly the change in the margin; with more players it
 *    leaves out what the others hand each other. A failed challenge
 *    costs two cards that a round win does not see when the victim goes
 *    on to win anyway, and a successful one adds four cards to the
 *    offender's hand that score only if the victim wins.
 *
 *    Both are split by the offender's hand after the play, one to four
 *    cards or five and more, which is the tell a player can see best.
 *    It is several times slower.
 *
 * 4. With --stack, the stacking house rule is on as well, so a victim
 *    may answer a Wild Draw Four with their own. Those answers are
 *    counted apart from Wild Draw Fours played on an ordinary turn,
 *    since the answer was the only card the player was allowed to play
 *    and is judged on the color the previous offender declared. With
 *    --breakeven they are forked too, whatever the victim holds.
 *
 * Every round is its own seeded game, played to its first round end.
 * Each pass and table size has its own block of seeds, and every chance
 * reuses the same seeds so chances compare like for like. By default
 * victims decide with the AI's own decideChallenge, exactly as CPU
 * victims do in the browser; --victims accept or challenge makes every
 * victim never or always challenge instead, which brackets how a person
 * might answer, since what a bluff is worth depends on how often it is
 * called. With --stack a victim that does not challenge still answers
 * with its own Wild Draw Four when it holds one, as the CPU does.
 */
'use strict';

var E = require('./engine.js');
var AI = require('./ai.js');
var U = require('./testutil.js');

/* Seed blocks: seeds are (base + players) * 1e6 + round, so --rounds must stay below 1e6. */
var SEEDS = { share: 10, winRate: 20, fork: 30 };
/* Fork seeds are base * 1e8 + round * FORKS + n, so a round may fork at most FORKS times. */
var FORKS = 64;

function parseArgs(argv) {
  var opts = { rounds: 20000, chances: null, victims: 'cpu', breakeven: false, stack: false };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === '--rounds') opts.rounds = Number(argv[++i]);
    else if (argv[i] === '--chances') opts.chances = argv[++i].split(',').map(Number);
    else if (argv[i] === '--victims') opts.victims = argv[++i];
    else if (argv[i] === '--breakeven') opts.breakeven = true;
    else if (argv[i] === '--stack') opts.stack = true;
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

function newRound(seed, numPlayers, stack) {
  var rng = U.seededRng(seed);
  return {
    rng: rng,
    state: E.createGame({ numPlayers: numPlayers, targetScore: 1e9, challengeRule: true, stackDraws: stack }, rng)
  };
}

/* The victim's side of the score margin for a finished round (see the header). */
function margin(final, seat) {
  return final.roundWinner === seat ? final.roundPoints : -E.handPoints(final.players[seat].hand);
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

function mean(xs) {
  return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : NaN;
}

/*
 * Mean of a list of differences with its 95% interval. scale 100 shows
 * a difference in round wins as percentage points; scale 1 leaves card
 * points as they are.
 */
function meanCI(diffs, scale) {
  scale = scale || 100;
  var n = diffs.length, m = mean(diffs), v = 0;
  if (n < 2) return 'n/a';
  diffs.forEach(function (d) { v += (d - m) * (d - m); });
  var h = 1.96 * Math.sqrt(v / (n - 1) / n);
  function f(x) { return (x >= 0 ? '+' : '') + (scale * x).toFixed(2); }
  return f(m) + ' [' + f(m - h) + ', ' + f(m + h) + ']';
}

function tally() { return [0, 0]; }
function add(t, hit) { t[1]++; if (hit) t[0]++; }

/*
 * The fork's copy without a challenge: the victim makes the move it
 * would make anyway. With stacking off, or holding no Wild Draw Four,
 * that is taking the total, and chooseAction returns it without touching
 * the rng. Under stacking a victim holding one answers with it instead,
 * so building this copy from applyDraw alone would weigh the challenge
 * against a move nobody makes.
 */
function decline(after, chance, rng) {
  var action = AI.chooseAction(withChance(after, chance), after.currentPlayer, rng);
  return action.type === 'draw' ? E.applyDraw(after, rng) : E.applyPlay(after, action, rng);
}

/*
 * One fork's outcome for each yardstick: guilty or honest, and what
 * challenging gained over accepting in round wins and in points.
 */
function forks() { return { guilty: { wins: [], pts: [] }, honest: { wins: [], pts: [] } }; }

/* Pass 1, and pass 3 when asked: bluff share, tells, and the fork. */
function bluffShare(numPlayers, chance, opts) {
  var t = {
    lastCard: 0, stackedLastCard: 0, all: tally(), low: tally(), high: tally(),
    off12: tally(), off34: tally(), off5: tally(), sameBluff: tally(), sameHonest: tally(),
    stacked: tally(), stackedLow: tally(), stackedHigh: tally(), stackedSame: tally(),
    fork: { off14: forks(), off5: forks(), stacked: forks() }
  };
  function every() { return chance; }
  for (var r = 0; r < opts.rounds; r++) {
    var seed = (SEEDS.share + numPlayers) * 1e6 + r;
    var g = newRound(seed, numPlayers, opts.stack);
    var forked = 0;
    playOut(g.state, g.rng, every, opts.victims, function (before, after, action) {
      var seat = before.currentPlayer;
      var offenderLeft = after.players[seat].hand.length;
      /* An answer to a stack lands while the previous window is still open. */
      var answer = !!before.pendingChallenge;
      if (offenderLeft === 0) {
        if (answer) t.stackedLastCard++; else t.lastCard++;
        return;
      }
      var guilty = after.pendingChallenge.hadColorMatch;
      var victim = after.pendingChallenge.victim;
      var low = before.players[victim].hand.length <= 2;
      if (answer) {
        add(t.stacked, guilty);
        add(low ? t.stackedLow : t.stackedHigh, guilty);
        if (guilty) add(t.stackedSame, action.chosenColor === before.currentColor);
      } else {
        add(t.all, guilty);
        add(low ? t.low : t.high, guilty);
        if (low) add(offenderLeft <= 2 ? t.off12 : offenderLeft <= 4 ? t.off34 : t.off5, guilty);
        add(guilty ? t.sameBluff : t.sameHonest, action.chosenColor === before.currentColor);
      }
      if (opts.breakeven && (answer || low)) {
        /*
         * Both copies replay from one fork seed, so they differ only in
         * the victim's answer.
         */
        if (forked >= FORKS) throw new Error('more than ' + FORKS + ' forks in one round');
        var forkSeed = (SEEDS.fork + numPlayers) * 1e8 + r * FORKS + (forked++);
        var accepted = playOut(decline(after, chance, U.seededRng(forkSeed)), U.seededRng(forkSeed + 1), every, opts.victims);
        var challenged = playOut(E.applyChallenge(after, U.seededRng(forkSeed)), U.seededRng(forkSeed + 1), every, opts.victims);
        var bucket = answer ? t.fork.stacked : offenderLeft <= 4 ? t.fork.off14 : t.fork.off5;
        var side = guilty ? bucket.guilty : bucket.honest;
        side.wins.push((challenged.roundWinner === victim ? 1 : 0) - (accepted.roundWinner === victim ? 1 : 0));
        side.pts.push(margin(challenged, victim) - margin(accepted, victim));
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
    var a = newRound(seed, numPlayers, opts.stack);
    var won = playOut(a.state, a.rng, function (seat) { return seat === bluffer ? chance : 0; }, opts.victims)
      .roundWinner === bluffer ? 1 : 0;
    var b = newRound(seed, numPlayers, opts.stack);
    var wonAnyway = playOut(b.state, b.rng, function () { return 0; }, opts.victims).roundWinner === bluffer ? 1 : 0;
    wins += won;
    control += wonAnyway;
    diffs.push(won - wonAnyway);
  }
  return { wins: wins, control: control, rounds: opts.rounds, diff: meanCI(diffs) };
}

/* G, L, break-even and the challenge-every-one mean for one yardstick. */
function yardstick(f, key, scale, digits) {
  var G = mean(f.guilty[key]), L = -mean(f.honest[key]);
  function show(x) { return isFinite(x) ? (scale * x).toFixed(digits) : 'n/a'; }
  /*
   * L / (L + G) is the guilty share above which challenging pays, but
   * only when a guilty verdict helps (G > 0) and an honest one hurts
   * (L > 0). If neither hurts, challenging pays at any share, and if
   * neither helps, at none. Both negative, which only noise in a small
   * bucket produces, flips it: challenging then pays below the ratio,
   * shown with a leading '<'.
   */
  var be;
  if (!(isFinite(G) && isFinite(L))) be = 'n/a';
  else if (G > 0 && L > 0) be = (100 * L / (L + G)).toFixed(1) + '%';
  else if (G >= 0 && L <= 0) be = G === 0 && L === 0 ? 'even' : 'always';
  else if (G <= 0 && L >= 0) be = 'never';
  else be = '<' + (100 * L / (L + G)).toFixed(1) + '%';
  return show(G).padStart(7) + show(L).padStart(7) + be.padStart(8) + '  ' +
    meanCI(f.guilty[key].concat(f.honest[key]), scale).padEnd(25);
}

function forkRow(n, label, f, guilty) {
  return String(n).padStart(7) + ' | ' + label.padEnd(15) + ' | ' +
    String(guilty[1]).padStart(6) + ' ' + pct(guilty[0], guilty[1]) + ' | ' +
    yardstick(f, 'wins', 100, 1) + ' | ' + yardstick(f, 'pts', 1, 1);
}

function main() {
  var opts = parseArgs(process.argv);
  console.log('Rounds per table size: ' + opts.rounds + '. Challenge rule on, stacking ' +
    (opts.stack ? 'on' : 'off') + '. Victims: ' +
    { cpu: 'the CPU challenge rule', accept: 'never challenge', challenge: 'always challenge' }[opts.victims] +
    (opts.stack && opts.victims !== 'challenge' ? ', answering a stack when able.' : '.'));
  console.log('Guilty = the CPU held the color in play when it played the Wild Draw Four. Shares leave out');
  console.log('Wild Draw Fours played as a last card, which are innocent by construction' +
    (opts.stack ? ', and count answers to a stack apart.' : '.'));
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
    if (opts.stack) {
      console.log('players | answers to a stack: n  last card  per 100 rounds  guilty (95% CI)         | victim 1-2: n  guilty |' +
        ' victim 3+: n  guilty | guilty ones re-declaring the color in play');
      rows.forEach(function (row) {
        var t = row.t;
        console.log(String(row.n).padStart(7) + ' | ' + String(t.stacked[1]).padStart(21) + ' ' +
          String(t.stackedLastCard).padStart(10) + ' ' +
          (100 * (t.stacked[1] + t.stackedLastCard) / opts.rounds).toFixed(1).padStart(15) + ' ' +
          pct(t.stacked[0], t.stacked[1]) + ' ' +
          wilson(t.stacked[0], t.stacked[1]).padEnd(17) + ' | ' +
          String(t.stackedLow[1]).padStart(12) + ' ' + pct(t.stackedLow[0], t.stackedLow[1]) + ' | ' +
          String(t.stackedHigh[1]).padStart(11) + ' ' + pct(t.stackedHigh[0], t.stackedHigh[1]) + ' | ' +
          pct(t.stackedSame[0], t.stackedSame[1]).padStart(42));
      });
    }
    if (chance > 0) {
      console.log('players | bluffer round wins   same seeds, nobody bluffing   difference in points (95% CI)');
      [2, 3, 4].forEach(function (n) {
        var w = winRate(n, chance, opts);
        console.log(String(n).padStart(7) + ' | ' + pct(w.wins, w.rounds).padStart(18) + ' ' +
          pct(w.control, w.rounds).padStart(29) + '   ' + w.diff);
      });
    }
    if (opts.breakeven) {
      console.log('Challenge against not challenging, from the victim\'s side. Round wins in percentage points, points in card points.');
      console.log('players | at victim 1-2   |      n guilty |      G      L   break  challenge every one (95% CI) |' +
        '      G      L   break  challenge every one (95% CI)');
      console.log('        |                 |               |  round wins                                       |' +
        '  points');
      rows.forEach(function (row) {
        var t = row.t, f = t.fork;
        var off14 = [t.off12[0] + t.off34[0], t.off12[1] + t.off34[1]];
        console.log(forkRow(row.n, 'offender 1-4', f.off14, off14));
        console.log(forkRow(row.n, 'offender 5+', f.off5, t.off5));
        var both = {
          guilty: { wins: f.off14.guilty.wins.concat(f.off5.guilty.wins), pts: f.off14.guilty.pts.concat(f.off5.guilty.pts) },
          honest: { wins: f.off14.honest.wins.concat(f.off5.honest.wins), pts: f.off14.honest.pts.concat(f.off5.honest.pts) }
        };
        console.log(forkRow(row.n, 'either', both, t.low));
        if (opts.stack) console.log(forkRow(row.n, 'stack, any', f.stacked, t.stacked));
      });
    }
  });
}

main();
