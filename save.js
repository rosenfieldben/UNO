/*
 * save.js
 *
 * Save and resume for a game in progress. Pure apart from the storage
 * object it is handed: ui.js passes in the browser's localStorage, and
 * the tests pass in fakes that are missing, throw, or run out of room.
 * Nothing here touches the DOM or holds state of its own.
 *
 * Only the engine state is ever saved. It is plain JSON by design (see
 * clone in engine.js), so it round-trips through JSON.stringify and
 * JSON.parse unchanged. UI-only state such as an armed Uno call, a Wild
 * waiting on its color, or a pending CPU timer never reaches this module,
 * so it cannot be saved by accident.
 *
 * Same classic-script wrapper as engine.js and ai.js, so it loads from a
 * file:// URL as window.UnoSave and under node via require(). Like ai.js
 * it needs the engine: under node it requires it, and in the browser
 * engine.js must load first, which index.html does.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.UnoSave = factory(root.UnoEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  /*
   * Bump this whenever the state or its config changes shape in a way an
   * older save cannot satisfy, for example a new config field the AI
   * reads. A save from any other version is discarded rather than
   * migrated: losing a game in progress once is cheaper than restoring
   * one the current code misreads.
   */
  var VERSION = 1;

  /*
   * localStorage is shared by every page on an origin. On GitHub Pages
   * that is every project under the same user, and from a file:// URL
   * it can be every local file, so the key names this game explicitly.
   */
  var KEY = 'uno.savedGame';

  function encode(state) {
    return JSON.stringify({ version: VERSION, state: state });
  }

  /*
   * Returns the saved state, or null for anything that should not be
   * restored. Callers never need to tell the reasons apart: whatever the
   * cause, the player simply starts at the setup screen.
   *
   * The two gates guard different things. validateState catches a save
   * whose cards or seats are wrong, because it checks deck conservation,
   * seat ranges, the phase, and the colors. It does not check that every
   * field is present: it reads no config field but numPlayers, so a save
   * missing targetScore or a field the AI reads would pass it. A change
   * of shape is caught only by VERSION, which is why it must be bumped.
   * validateState also assumes a well-formed object and throws on some
   * malformed ones (a hand that is not an array, a null card), so a
   * throw counts as a rejection too.
   */
  function decode(text) {
    if (typeof text !== 'string') return null;
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!data || data.version !== VERSION) return null;
    try {
      if (E.validateState(data.state).length !== 0) return null;
    } catch (e) {
      return null;
    }
    return data.state;
  }

  /*
   * Merely reading window.localStorage can throw, not just using it:
   * browsers raise a SecurityError when storage is blocked for the page.
   * Taking the root object as a parameter keeps that try in tested code.
   */
  function storageFrom(root) {
    try {
      return (root && root.localStorage) || null;
    } catch (e) {
      return null;
    }
  }

  /*
   * Every storage call below is wrapped. Storage can be missing, blocked,
   * or full, and none of that may interrupt play: the worst outcome of a
   * storage failure is a game that cannot be resumed after a reload.
   */
  function load(storage) {
    var text;
    try {
      text = storage ? storage.getItem(KEY) : null;
    } catch (e) {
      return null;
    }
    if (text === null || text === undefined) return null;
    var state = decode(text);
    /*
     * A save this code cannot use is removed rather than re-read on every
     * visit. That includes one from a newer version, which the newer code
     * could have resumed; only one version of the game is expected per
     * origin, so that loss is accepted for a simple rule.
     */
    if (state === null) clear(storage);
    return state;
  }

  /*
   * Saves a game in progress, including one paused on a round summary,
   * and clears a finished one so the next visit starts at setup rather
   * than on a game-over screen. Returns whether a save now matches state.
   */
  function persist(storage, state) {
    if (!state || state.phase === 'gameOver') {
      clear(storage);
      return false;
    }
    if (!storage) return false;
    try {
      storage.setItem(KEY, encode(state));
      return true;
    } catch (e) {
      /*
       * A failed write must not leave the previous save behind. Resuming
       * that older position would quietly rewind the game, undoing moves
       * already made and letting a player replay a turn knowing what the
       * draw pile held. Better no save than a stale one.
       */
      clear(storage);
      return false;
    }
  }

  function clear(storage) {
    if (!storage) return;
    try {
      storage.removeItem(KEY);
    } catch (e) {
      /* Nothing more can be done, and play must go on regardless. */
    }
  }

  return {
    VERSION: VERSION,
    KEY: KEY,
    encode: encode,
    decode: decode,
    storageFrom: storageFrom,
    load: load,
    persist: persist,
    clear: clear
  };
});
