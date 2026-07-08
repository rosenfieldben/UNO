# Uno

A single-player browser version of the card game Uno against 1 to 3 CPU
opponents. Vanilla JavaScript, HTML, and CSS with no frameworks, no build
step, and no external dependencies.

## Play

Open `index.html` directly in a browser. Pick the number of opponents and
the target score, then play: click a card to play it, click the draw pile
to draw, and use the UNO! button when you are down to two cards (or during
your call window). If a CPU forgets to call Uno, hit Catch! before the
next player acts.

## Layout

- `engine.js` - pure rules engine: plain state object in, new state out,
  all randomness through an injected rng. Runs under node with no DOM.
- `ai.js` - pure CPU decision function `chooseAction(state, playerIndex, rng)`.
- `ui.js` - the only file that touches the DOM; mutates state exclusively
  through engine functions.
- `index.html`, `style.css` - markup and card-table styling.

## Tests

Zero-dependency, deterministic under seeded rngs:

```
node engine.test.js
node ai.test.js
```

## Rules notes

- Wild Draw Four is always playable; the challenge rule is not implemented.
- Reverse acts as Skip in a two-player game.
- Failing to call Uno before the next player acts costs two cards.
- Stacking Draw Two / Draw Four is available behind the off-by-default
  `stackDraws` config flag.
- Scoring is standard: number cards face value, action cards 20, wilds 50,
  first to the target score (default 500) wins.
