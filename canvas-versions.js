/*
  canvas-versions.js
  Version-scrubbing visualization for The Canvas story page.

  This file is loaded only from the-canvas.html. It reads the genealogy JSON,
  builds per-version display arrays, and provides a timeline UI for switching
  between the six versions of the story.

  How it works:
    1. On DOMContentLoaded, fetch authorship/canvas-genealogy.json.
    2. Build CANVAS_VERSIONS — one ordered array of display objects per version.
    3. When the user clicks "Versions", enter versionsMode:
         - Cancel any running typewriter animation
         - Disable the Animate/Static toggle (it doesn't apply here)
         - Show the timeline bar
         - Render the 'final' version (identical to the original published page)
    4. Clicking a tick renders that version's text into .story.
    5. Clicking "Close" exits versionsMode:
         - Re-render 'final' to restore the correct DOM
         - Re-initialize the animation system against the new elements
         - Re-enable the toggle, hide the timeline

  Isolation:
    This file never reads or writes canvas-animations.js's internal state
    directly. The two files coordinate through two window functions exposed
    by canvas-animations.js: cancelCanvasAnimation() and reinitCanvasAnimation().

  Note on fetch and local testing:
    The JSON is loaded via fetch(), which requires an HTTP server.
    It works on GitHub Pages and any local dev server (VS Code Live Server,
    python -m http.server, etc.). It will be blocked on raw file:// URLs.

  Data flexibility:
    VERSION_SUPPLEMENTS lets you inject extra lines per version that aren't
    tracked in the genealogy JSON. Use this when you extract full docx text
    in a later phase — each extra line gets an 'insertAfter' anchor that
    controls where it appears in the rendered output.
*/

'use strict';


// ─── Version order and labels ─────────────────────────────────────────────────

/* Six versions of the story in the order they were written */
var VERSION_ORDER = ['draft_a', 'draft_b', 'v2_5', 'draft_c', 'draft_d', 'final'];

/* Human-readable labels for the timeline tick buttons */
var VERSION_LABELS = {
  draft_a: 'Draft A',
  draft_b: 'Draft B',
  v2_5:    'V 2.5',
  draft_c: 'Draft C',
  draft_d: 'Draft D',
  final:   'Final'
};


// ─── Supplement lines ─────────────────────────────────────────────────────────

/*
  Lines that exist in specific versions but are NOT in the genealogy JSON.
  The 'final' version uses the captured HTML snapshot (not this table), so
  no final-version entries are needed here.

  When you extract full docx text in a later phase, add each extra draft line
  here with an 'insertAfter' anchor telling the renderer where it belongs:
    'bylines'  — inject after all byline lines (above the opening separator)
    'end'      — append after all story content
    lineId     — inject after the line with that JSON id (e.g. '008')
*/
var VERSION_SUPPLEMENTS = {
  /*
    Example entry format (for reference when adding docx-extracted lines):

    draft_a: [
      { insertAfter: 'bylines', cssClass: 'story-byline', text: '...' },
      { insertAfter: '008',     cssClass: 'ai',           text: '...' },
      { insertAfter: 'end',     cssClass: 'epilogue',     text: '...' }
    ]
  */
};


// ─── Capture original HTML synchronously ─────────────────────────────────────

/*
  Grab the .story div's innerHTML the moment this script executes — before
  DOMContentLoaded fires and canvas-animations.js empties all the story
  elements. Both scripts register DOMContentLoaded handlers, but synchronous
  top-level code runs first, so .story still has its full original content here.

  This snapshot is used to render the 'final' version. Rebuilding from the
  genealogy JSON would produce small discrepancies (e.g. one JSON line that
  the HTML splits across two paragraphs), so using the original markup
  guarantees an exact match.
*/
var originalStoryHTML = '';
(function () {
  var story = document.querySelector('.story');
  if (story) originalStoryHTML = story.innerHTML;
}());


// ─── Runtime state ────────────────────────────────────────────────────────────

var versionData    = null;    /* built from JSON after fetch completes */
var versionsActive = false;   /* true while timeline mode is on */
var activeVersion  = 'final'; /* which tick is currently selected */


// ─── Entry point ─────────────────────────────────────────────────────────────

/*
  Wire up the Versions button immediately (it only needs the HTML snapshot,
  not the JSON), then fetch the JSON so the timeline tick buttons can work.
  This means the button is responsive even before the JSON finishes loading.
*/
function versionsInit() {
  setupVersionsButton();

  fetch('authorship/canvas-genealogy.json')
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      versionData = buildVersionData(data);
      setupTickButtons();
    })
    .catch(function (err) {
      /*
        Non-fatal: if the JSON can't be loaded, the Versions button still
        works for the 'final' view (HTML snapshot). Draft ticks won't respond.
        The rest of the page is unaffected.
      */
      console.warn('canvas-versions: could not load genealogy data.', err);
    });
}


// ─── Build per-version data from JSON ─────────────────────────────────────────

/*
  Turns the flat JSON lines array into one ordered display array per version.
  Each item has: id (JSON line id), cssClass, text (cleaned of format markers).
  Null entries (line absent in that version) are dropped entirely.
*/
function buildVersionData(genealogy) {
  var versions = {};
  VERSION_ORDER.forEach(function (v) { versions[v] = []; });

  genealogy.lines.forEach(function (line) {
    VERSION_ORDER.forEach(function (version) {
      var rawText  = line.versions[version];
      if (rawText === null) return; /* absent in this version — skip */

      var cssClass = speakerToClass(line.speaker, line.id);
      if (!cssClass) return; /* title — not rendered inside .story */

      versions[version].push({
        id:       line.id,
        cssClass: cssClass,
        text:     cleanText(rawText)
      });
    });
  });

  return versions;
}

/*
  Maps a JSON speaker value to the CSS class used in the story layout.
  Returns null for lines that aren't rendered as <p> inside .story (the title).

  Speaker values in the JSON: title, byline, ai, creator, stage_direction, narrator
  CSS classes on the page:    story-byline, ai, creator, direction, story-break, epilogue
*/
function speakerToClass(speaker, lineId) {
  if (speaker === 'title')           return null;           /* static <h1>, not in .story */
  if (speaker === 'byline')          return 'story-byline';
  if (speaker === 'ai')              return 'ai';
  if (speaker === 'creator')         return 'creator';
  if (speaker === 'stage_direction') return 'direction';
  /*
    Line 075 is the '—' separator between the dialogue and the epilogue.
    Lines 076–077 are the closing prose paragraphs.
  */
  if (speaker === 'narrator' && lineId === '075') return 'story-break';
  if (speaker === 'narrator')        return 'epilogue';
  return null;
}

/*
  Removes speaker-marker prefixes that appear in the docx source files.
  These were used as formatting markers in the draft documents and are not
  part of the displayed story text.

    ": "  — AI lines in draft_c, draft_d, final
    "> "  — Creator lines in draft_c, draft_d, final
    "- "  — AI lines in v2_5 format
*/
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/^:\s+/, '')   /* strip ": " prefix */
    .replace(/^>\s+/, '')   /* strip "> " prefix */
    .replace(/^-\s+/, '')   /* strip "- " prefix */
    .trim();
}


// ─── UI setup ─────────────────────────────────────────────────────────────────

/* Wire the Versions toggle button. Called immediately at init. */
function setupVersionsButton() {
  var versionsBtn = document.getElementById('versions-toggle');
  if (!versionsBtn) return;

  versionsBtn.addEventListener('click', function () {
    if (versionsActive) {
      exitVersionsMode();
    } else {
      enterVersionsMode();
    }
  });
}

/* Wire the timeline tick buttons. Called only after JSON data is loaded. */
function setupTickButtons() {
  var timeline = document.getElementById('versions-timeline');
  if (!timeline) return;

  /* Each tick stores its version key in data-version */
  timeline.querySelectorAll('.versions-tick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setActiveVersion(this.dataset.version);
    });
  });
}


// ─── Mode entry / exit ────────────────────────────────────────────────────────

function enterVersionsMode() {
  var animBtn     = document.getElementById('anim-toggle');
  var versionsBtn = document.getElementById('versions-toggle');
  var timeline    = document.getElementById('versions-timeline');

  /* Stop any typewriter animation that might be running */
  if (typeof window.cancelCanvasAnimation === 'function') {
    window.cancelCanvasAnimation();
  }

  /*
    Disable the Animate/Static toggle. Typewriter animation isn't meaningful
    when we're scrubbing between draft texts — the user needs to see each
    version fully at a glance.
  */
  if (animBtn) {
    animBtn.disabled = true;
  }

  /* Show the timeline bar */
  if (timeline) timeline.style.display = 'flex';

  /* Change the button label to signal how to exit */
  versionsBtn.textContent = 'Close';

  versionsActive = true;

  /*
    Default to the final version when the mode first opens. This should look
    identical to the original page, so the reader can orient themselves before
    scrubbing backward.
  */
  setActiveVersion('final');
}

function exitVersionsMode() {
  var animBtn     = document.getElementById('anim-toggle');
  var versionsBtn = document.getElementById('versions-toggle');
  var timeline    = document.getElementById('versions-timeline');

  /*
    Re-render the final version. This rebuilds .story with fresh DOM elements
    so the animation system can re-initialize against them — without this, the
    animation's stored element references would point to stale/detached nodes.
  */
  renderVersion('final');

  /*
    Tell the animation system to re-scan the new elements and return to static
    mode. After this, clicking "Animate" will restart the typewriter correctly.
  */
  if (typeof window.reinitCanvasAnimation === 'function') {
    window.reinitCanvasAnimation();
  }

  /* Re-enable the Animate/Static toggle */
  if (animBtn) {
    animBtn.disabled = false;
  }

  /* Hide the timeline bar */
  if (timeline) timeline.style.display = 'none';

  /* Restore the toggle button's label */
  if (versionsBtn) versionsBtn.textContent = 'Versions';

  versionsActive = false;
  activeVersion  = 'final';
}


// ─── Timeline state ───────────────────────────────────────────────────────────

/* Mark a tick as active and render its version's content. */
function setActiveVersion(version) {
  activeVersion = version;

  /* Highlight the active tick, un-highlight the rest */
  document.querySelectorAll('.versions-tick').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.version === version);
  });

  renderVersion(version);
}


// ─── Version rendering ────────────────────────────────────────────────────────

/*
  Replaces .story's content with the given version's lines.

  For 'final': restores the original HTML snapshot captured at script load.
  This guarantees an exact match with the published page, including any
  paragraph splits or wording that the genealogy JSON doesn't perfectly
  replicate.

  For draft versions, render order is:
    1. Bylines from JSON (absent in all pre-final versions)
    2. Byline-position supplements (e.g. 'co-written with Claude')
    3. Opening '—' separator — structural; present in all versions
    4. Story content: direction, ai, creator, story-break, epilogue lines
    5. End-position supplements (e.g. date colophon)

  Lines that are null in the JSON for this version are simply absent.
*/
function renderVersion(version) {
  var story = document.querySelector('.story');
  if (!story) return;

  /* For final, use the original HTML snapshot — exact match guaranteed */
  if (version === 'final') {
    story.innerHTML = originalStoryHTML;
    return;
  }

  if (!versionData) return;

  var lines = versionData[version];
  if (!lines) return;

  /*
    Separate bylines from story content. Bylines live above the opening
    separator; everything else goes below it.
  */
  var bylines      = lines.filter(function (l) { return l.cssClass === 'story-byline'; });
  var storyContent = lines.filter(function (l) { return l.cssClass !== 'story-byline'; });

  /* Clear the story div before rebuilding */
  story.innerHTML = '';

  /* 1. Bylines from JSON */
  bylines.forEach(function (line) {
    story.appendChild(makeParagraph(line.cssClass, line.text));
  });

  /* 2. Byline-position supplements */
  injectSupplements(story, version, 'bylines');

  /* 3. Opening separator — sits between bylines and the first dialogue line */
  story.appendChild(makeParagraph('story-break', '—'));

  /* 4. All story content in JSON order */
  storyContent.forEach(function (line) {
    story.appendChild(makeParagraph(line.cssClass, line.text));
  });

  /* 5. End-position supplements */
  injectSupplements(story, version, 'end');
}

/*
  Appends supplement lines for the given version at the given position.
  'bylines' and 'end' are the positions used in Phase 1.
  Future phases can add line-id positions for mid-content insertions.
*/
function injectSupplements(story, version, position) {
  var supplements = VERSION_SUPPLEMENTS[version];
  if (!supplements) return;

  supplements
    .filter(function (s) { return s.insertAfter === position; })
    .forEach(function (s) {
      story.appendChild(makeParagraph(s.cssClass, s.text));
    });
}

/* Creates a <p> element with the given CSS class and text content. */
function makeParagraph(cssClass, text) {
  var p = document.createElement('p');
  p.className   = cssClass;
  p.textContent = text;
  return p;
}


// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', versionsInit);
} else {
  versionsInit();
}
