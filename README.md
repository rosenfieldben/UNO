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

## Layout

- `engine.js` - pure rules engine: plain state object in, new state out,
  all randomness through an injected rng. Runs under node with no DOM.
- `ai.js` - pure CPU decision functions `chooseAction(state, playerIndex, rng)`
  and `decideChallenge(state, playerIndex, rng)`.
- `ui.js` - the only file that touches the DOM; mutates state exclusively
  through engine functions.
- `index.html`, `style.css` - markup and card-table styling.
- `testutil.js` - shared runner, seeded rng, and deck-stacking helpers
  for the test suites.

## Tests

Zero-dependency, deterministic under seeded rngs:

```
node engine.test.js
node ai.test.js
```

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
- Reverse acts as Skip in a two-player game.
- Failing to call Uno before the next action costs two cards; in a
  two-player game an action card that hands you the turn straight back
  does not let you dodge the penalty.
- Stacking Draw Two / Draw Four is available behind the off-by-default
  `stackDraws` config flag.
- Scoring is standard: number cards face value, action cards 20, wilds 50,
  first to the target score (default 500) wins.
