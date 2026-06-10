/*
  canvas-animations.js
  Sequential typewriter animations for The Canvas story page.

  This file is linked only from the-canvas.html — it has no effect on any
  other page and does not touch the sidebar/about logic in sidebar.js.

  How the system works:
    1. On page load, every animated story element's text is stored in memory
       and then cleared from the DOM.

    2. animateAll() works through the elements one at a time.  When an element
       finishes typing the next one starts after the configured delay.

    3. The "Static" button cancels any in-flight animation and quickly reveals
       all text top-to-bottom.  The "Animate" button clears everything and
       restarts the animation from the beginning.

  Cancellation uses a session counter: every new animation run gets a unique
  session number.  setTimeout / setInterval callbacks check their session
  against the current one before doing anything, so they silently bail out
  if the user toggled while they were waiting.
*/

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

// How long to wait between typing each character (milliseconds).
const CHAR_INTERVAL_MS = 12;

// How long to pause before a line starts when the speaker just changed.
// Applied whenever we switch from an AI line to a Creator line (or back).
const SPEAKER_DELAY_MS = 2200;

// How long to pause between consecutive lines from the same speaker,
// or before/after a stage direction or epilogue line.
const SAME_DELAY_MS = 850;

// How long to wait between each element when doing the quick "reveal all"
// static reveal — gives a fast top-to-bottom wipe rather than instant fill.
const REVEAL_STAGGER_MS = 18;


// ─── Which elements to animate ────────────────────────────────────────────────

const ANIMATED_SELECTORS =
  '.story p.direction, .story p.ai, .story p.creator, .story p.epilogue';


// ─── State ────────────────────────────────────────────────────────────────────

// Stores each element's original text content before we empty it.
const originalTexts = new Map();

// All target elements in DOM order — kept so restart can clear them all.
let allTargets = [];

// Incremented every time a new animation run starts (or is cancelled).
// Each setTimeout/setInterval closure captures its session value at creation
// time and bails out if currentSession has moved on.
let currentSession = 0;

// Tracks whether we are in animated mode (true) or static mode (false).
let animationEnabled = true;


// ─── Initialisation ───────────────────────────────────────────────────────────

function init() {
  allTargets = Array.from(document.querySelectorAll(ANIMATED_SELECTORS));
  if (allTargets.length === 0) return;

  // Store each element's text, then clear it.
  allTargets.forEach(function (el) {
    originalTexts.set(el, el.textContent);
    el.textContent = '';
  });

  // Wire up the toggle button.
  var btn = document.getElementById('anim-toggle');
  if (btn) {
    btn.addEventListener('click', function () {
      if (animationEnabled) {
        // ── Switch to static mode ──────────────────────────────────────────
        animationEnabled = false;
        btn.textContent  = 'Animate';
        revealAll();
      } else {
        // ── Restart animation ──────────────────────────────────────────────
        animationEnabled = true;
        btn.textContent  = 'Static';
        restartAnimation();
      }
    });
  }

  // Start the first animation run.
  animateAll(allTargets, 0, null, currentSession);
}


// ─── Sequential animator ─────────────────────────────────────────────────────

// Animates elements[index], then calls itself for the next element.
// session: the run ID captured when this chain started — if currentSession
// has changed by the time a callback fires, the chain silently stops.
function animateAll(elements, index, prevSpeaker, session) {
  if (session !== currentSession)  return; // cancelled by toggle
  if (index >= elements.length)    return; // all done

  var el      = elements[index];
  var speaker = getSpeaker(el);
  var delay   = getDelay(speaker, prevSpeaker);

  setTimeout(function () {
    if (session !== currentSession) return; // cancelled during delay
    typeIn(el, originalTexts.get(el) || '', function () {
      animateAll(elements, index + 1, speaker, session);
    }, session);
  }, delay);
}


// ─── Toggle actions ───────────────────────────────────────────────────────────

// Cancels the running animation and reveals all remaining text in a quick
// top-to-bottom stagger (REVEAL_STAGGER_MS between elements).
function revealAll() {
  currentSession++; // invalidates all in-flight callbacks

  allTargets.forEach(function (el, i) {
    setTimeout(function () {
      el.textContent = originalTexts.get(el) || '';
    }, i * REVEAL_STAGGER_MS);
  });
}

// Clears all story elements and restarts the typewriter from the beginning.
function restartAnimation() {
  currentSession++;
  var session = currentSession; // capture before any async work

  // Clear all elements synchronously so the page looks blank from the start.
  allTargets.forEach(function (el) {
    el.textContent = '';
  });

  // Brief pause before the first character appears, then kick off the chain.
  setTimeout(function () {
    if (session !== currentSession) return;
    animateAll(allTargets, 0, null, session);
  }, 300);
}


// ─── Speaker helpers ──────────────────────────────────────────────────────────

function getSpeaker(el) {
  if (el.classList.contains('ai'))      return 'ai';
  if (el.classList.contains('creator')) return 'creator';
  return 'neutral';
}

function getDelay(currentSpeaker, previousSpeaker) {
  if (previousSpeaker === null) return 0;

  var speakerChanged =
    (currentSpeaker === 'ai'      && previousSpeaker === 'creator') ||
    (currentSpeaker === 'creator' && previousSpeaker === 'ai');

  return speakerChanged ? SPEAKER_DELAY_MS : SAME_DELAY_MS;
}


// ─── Typewriter ───────────────────────────────────────────────────────────────

// Types `text` into `el` character by character.
// Checks session on every tick — stops (without calling onComplete) if
// currentSession has changed, which happens when the user clicks the toggle.
function typeIn(el, text, onComplete, session) {
  var charIndex = 0;

  var tick = setInterval(function () {
    if (session !== currentSession) {
      clearInterval(tick); // cancelled — leave the element as-is
      return;
    }

    charIndex++;
    var cursor = (charIndex < text.length) ? '|' : '';
    el.textContent = text.slice(0, charIndex) + cursor;

    if (charIndex >= text.length) {
      clearInterval(tick);
      onComplete();
    }
  }, CHAR_INTERVAL_MS);
}


// ─── External API for canvas-versions.js ─────────────────────────────────────

/*
  These two window functions let canvas-versions.js coordinate with the
  animation system without reading or writing its internal variables directly.
  Both are called from canvas-versions.js; they should not be called from
  anywhere else.
*/

/*
  Cancels any in-flight animation by advancing the session counter.
  All pending setTimeout / setInterval callbacks capture the old session
  value and will bail out silently when they see the mismatch.
*/
window.cancelCanvasAnimation = function () {
  currentSession++;
};

/*
  Re-initializes the animation system after .story's DOM has been replaced
  (happens when exiting versions mode, which re-renders the story from data).

  What this does:
    - Cancels anything in flight (new session)
    - Re-scans the document for story elements
    - Stores their current text without clearing it (text stays visible)
    - Puts the system in static mode so the button shows "Animate"

  After this runs, the user can click "Animate" to restart the typewriter
  from the beginning against the freshly-built DOM elements.
*/
window.reinitCanvasAnimation = function () {
  currentSession++; /* cancel in-flight work */

  /* Re-scan elements that are now in the DOM (new nodes from renderVersion) */
  allTargets = Array.from(document.querySelectorAll(ANIMATED_SELECTORS));
  originalTexts.clear();
  allTargets.forEach(function (el) {
    /* Store visible text without clearing — we enter static mode */
    originalTexts.set(el, el.textContent);
  });

  /* Switch to static mode */
  animationEnabled = false;
  var btn = document.getElementById('anim-toggle');
  if (btn) {
    btn.textContent = 'Animate';
  }
};


// ─── Entry point ─────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
