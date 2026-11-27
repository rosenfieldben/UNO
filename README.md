# Uno

A single-player browser version of the card game Uno against 1 to 3 CPU
opponents. Vanilla JavaScript, HTML, and CSS with no frameworks, no build
step, and no external dependencies.

## Play

Open `index.html` directly in a browser. Pick the number of opponents and
the target score, then play: click a card to play it, click the draw pile
to draw, and use the UNO! button when you are down to two cards (or during
your call window). If a CPU forgets to call Uno, hit Catch! before the
next player acts. With the challenge rule switched on, a Wild Draw Four
played at you waits for Challenge! or Take 4 before anything is drawn.
With stacking switched on, a Draw Two or Wild Draw Four played at you
can be answered with the same card from your hand, which passes the
total on. The total waiting on whoever is to move shows on the table,
and when it is yours, Take N takes it.

The game saves itself in the browser after every move, so a refresh or a
closed tab picks up where you left off. New game, or the end of a game,
discards the save. If the browser blocks storage, the game still plays;
it just cannot be resumed.

## Layout

- `engine.js` - pure rules engine: plain state object in, new state out,
  all randomness through an injected rng. Runs under node with no DOM.
- `ai.js` - pure CPU decision functions `chooseAction(state, playerIndex, rng)`
  and `decideChallenge(state, playerIndex, rng)`.
- `save.js` - save and resume, pure apart from the storage it is handed:
  encodes the engine state with a version number, and restores it only
  when the version matches and `validateState` finds nothing wrong.
  Every storage call is wrapped, so a missing, blocked, or full
  localStorage cannot break play.
- `ui.js` - the only file that touches the DOM; mutates state exclusively
  through engine functions, or restores a game saved earlier through
  `save.js`, and saves every state it adopts.
- `narrate.js` - the message bar's words as pure functions of engine
  states: what a move did, how many cards a take really dealt, a
  challenge verdict, and what the human owes next. `ui.js` decides when
  to show them; this decides what they say.
- `index.html`, `style.css` - markup and card-table styling.
- `testutil.js` - shared runner, seeded rng, and deck-stacking helpers
  for the test suites.
- `bench-bluff.js` - seeded all-CPU bench for Wild Draw Four bluffing:
  the share of CPU Wild Draw Fours that are guilty, split by what a
  player can see at the table, and what bluffing does to a CPU's round
  win rate against the same rounds played without it. With
  `--breakeven` it also measures what a challenge is worth in round
  wins and in points, split by the offender's hand; `--stack` turns
  stacking on. Run it with `node bench-bluff.js`, which takes a couple
  of minutes; it is a measurement, not a test, and its name keeps it out
  of `node --test`.

## Tests

Zero-dependency, deterministic under seeded rngs. From the repo root:

```
node --test
```

Node's built-in runner finds every `*.test.js` file, runs each in its own
process, and fails if any suite fails or crashes. A suite also runs on
its own, for example `node engine.test.js`, which prints only its output.

A new suite is picked up by its name alone, here and in CI. Helper
scripts must avoid the names Node treats as tests: `*.test.js`,
`*-test.js`, `*_test.js`, `test-*.js`, `test.js`, or anything under a
`test/` folder.

The suites run on every pull request (`.github/workflows/test.yml`) and
again on `main` before each deploy (`.github/workflows/pages.yml`).

## Rules notes

- Wild Draw Four is always playable. The official challenge rule sits
  behind the off-by-default `challengeRule` config flag: instead of
  drawing, the victim may challenge, and the play is judged on whether
  the offender still held a card of the color that was active when they
  played it. A guilty offender draws the four themselves, the card and
  the declared color stand, and the victim keeps their turn. A failed
  challenge costs the challenger six (the four plus two) and their turn.
  Guilt is decided at the moment of play and never revisited, so cards
  moving in or out of a hand while the window is open change nothing.
- A Wild Draw Four played as a last card does not end the round until
  that window resolves: accepting or challenging and losing lets the win
  stand, with the drawn cards counted in the score, while a successful
  challenge hands the four back to the offender and play continues.
- With stacking and the challenge rule both on, the victim of a Wild
  Draw Four has a third option: answering with their own. An answer
  closes the window and opens none of its own. It was the only kind of
  card its player could play, so it is never judged on the color they
  hold; it adds four to the total exactly as a Draw Two answers a Draw
  Two, and the next player answers again or takes the total. Judging
  answers on color, as an earlier version did, made about two thirds of
  CPU answers guilty, which turned challenging them into a near-free
  win. A Wild Draw Four played as a last card cannot be answered, since
  the round is over as soon as its window resolves. An answer played as
  a last card ends the round at once, and the next player takes the
  total before hands are counted, exactly as after a winning Draw Two
  answer. No official rule covers the combination, so this is a house
  choice; with stacking off it reduces exactly to the official four and
  six.
- With the challenge rule on, CPU players sometimes bluff: they play a
  Wild Draw Four while still holding the color in play, which a
  challenge would catch. They only bluff when the next player is down to
  one or two cards, and then with probability `cpuBluffChance` (default
  0.1). Bluffing in ordinary play as well was tried and cost a CPU two to
  three points of round win rate, because it spends the Wild Draw Four
  too early. Bluffing only against a low hand costs about a tenth of a
  point at most: 0.04, 0.09 and 0.12 points of round win rate at two,
  three and four players, over 60,000 rounds each against the same
  rounds played without bluffing, and only the four-player interval
  excludes zero.
- When to challenge: when you hold one or two cards and the CPU still
  holds five or more; otherwise accept. Call g the share of Wild Draw
  Fours you face that are bluffs. Counting cards, a failed challenge
  costs six against four for accepting, so challenging pays when
  6 x (1 - g) < 4, that is when g is above one third. That undersells
  it: a successful challenge also keeps your turn, and with one or two
  cards left that turn often wins the round. Measured in play
  (`node bench-bluff.js --breakeven`, 60,000 rounds per table size, at
  the default bluff chance), the bar at one or two cards depends on the
  CPU's hand after the play. Left with one to four cards, a CPU bluffs
  about 5% of the time, below a bar of 11 to 12% in round wins and 24
  to 28% in points, and challenging every such play costs 1 to 2 points
  of round wins and 8 to 11 card points. Left with five or more, it
  bluffs about a quarter of the time, above a bar of 16 to 19% in round
  wins and 11 to 18% in points, and challenging every one gains about 2
  points of round wins and 4 to 6 card points. Every one of those
  ranges excludes zero, at two, three and four players. Against a hand
  of three or more a CPU Wild Draw Four is never a chosen bluff, so
  accepting is right. With stacking on, accepting stays right in the
  same cases, but challenging a CPU left with five or more is no longer
  a clear gain (+1.4, +0.5 and 0.0 points of round wins at two, three
  and four players, none clear of zero), because not challenging then
  includes answering with your own Wild Draw Four when you hold one.
- Tells. A player can read some of this from the table. Besides your own
  hand size, the offender's matters most: at the default, a Wild Draw
  Four from a CPU left with one or two cards is a bluff about 3% of the
  time, against about a quarter of the time from one holding five or
  more (25 to 28%), since a big hand is likely to still hold the color
  in play. A
  bluffing CPU never re-declares the color already in play, so that
  gives nothing away.
- Reverse acts as Skip in a two-player game.
- Failing to call Uno before the next action costs two cards; in a
  two-player game an action card that hands you the turn straight back
  does not let you dodge the penalty.
- Stacking is a setup option, off by default (`stackDraws` in the
  engine config): a Draw Two may be answered with a Draw Two and a Wild
  Draw Four with a Wild Draw Four, passing the growing total to the
  next player. Only the player who cannot or will not answer takes it.
  Taking it is its own button, Take N, because the engine deals the
  whole total for what would otherwise be a single-card draw, so a tap
  on the draw pile does nothing while a total is owed.
- Scoring is standard: number cards face value, action cards 20, wilds 50,
  first to the target score (default 500) wins.
