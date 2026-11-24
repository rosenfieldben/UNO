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
- `index.html`, `style.css` - markup and card-table styling.
- `testutil.js` - shared runner, seeded rng, and deck-stacking helpers
  for the test suites.
- `bench-bluff.js` - seeded all-CPU bench for Wild Draw Four bluffing:
  the share of CPU Wild Draw Fours that are bluffs, split by the
  victim's hand size, and how a bluffing CPU fares against ones that
  never bluff. Run it with `node bench-bluff.js` (about a minute); it is
  a measurement, not a test, and its name keeps it out of `node --test`.

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
- With `stackDraws` and `challengeRule` both on, the victim has a third
  option: answering with their own Wild Draw Four. That closes the
  current window and opens a fresh one for the next player, with the
  total raised by four and guilt judged again for the new offender. A
  successful challenge moves the whole accumulated total to the most
  recent offender; a failed one costs the challenger that total plus
  two. An offender who played their last card ends the chain, since the
  round is over as soon as the window resolves, exactly as a winning
  answer to a stacked Draw Two leaves the next player no answer of their
  own. No official rule covers the combination, so this is a house
  choice; with stacking off it reduces exactly to the official four and
  six.
- With the challenge rule on, CPU players sometimes bluff: they play a
  Wild Draw Four while still holding the color in play, which a
  challenge would catch. They only bluff when the next player is down to
  one or two cards, and then with probability `cpuBluffChance` (default
  0.4). Challenging pays when more than a third of the Wild Draw Fours
  you face are bluffs: a failed challenge costs six cards against four
  for accepting, and 6 x (1 - g) < 4 when g > 1/3. Counting the four
  cards a caught offender draws as a gain for you lowers that to a fifth.
  `bench-bluff.js` measures the default at about one bluff in three for
  a player holding one or two cards, and none at all for a player
  holding three or more: a Wild Draw Four played at a bigger hand is
  always honest. Bluffing only against a low hand is deliberate. When
  the default was chosen, a version that also bluffed in ordinary play
  lost two to three points of round win rate in the bench, because it
  spends the Wild Draw Four too early; bluffing only against a low hand
  costs nothing measurable.
- Reverse acts as Skip in a two-player game.
- Failing to call Uno before the next action costs two cards; in a
  two-player game an action card that hands you the turn straight back
  does not let you dodge the penalty.
- Stacking Draw Two / Draw Four is available behind the off-by-default
  `stackDraws` config flag.
- Scoring is standard: number cards face value, action cards 20, wilds 50,
  first to the target score (default 500) wins.
