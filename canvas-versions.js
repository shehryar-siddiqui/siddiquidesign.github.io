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
         - Inject an "Authorship" toggle button into the controls row
         - Render the 'final' version (identical to the original published page)
    4. Clicking a tick renders that version's text into .story.
    5. Clicking "Authorship" enters authorship mode:
         - Each story line is tinted by its authorship score from the JSON
         - A legend appears below the timeline explaining the color scheme
    6. Clicking "Close" exits versionsMode:
         - Turns off authorship mode if active
         - Removes the authorship toggle button and legend
         - Re-renders 'final' to restore the correct DOM
         - Re-initializes the animation system

  Authorship color formula:
    Hue by authorship score:
      > +0.5  (user-written)    → 20   warm amber/rose
      < -0.5  (Claude-written)  → 210  cool teal/blue
      in between (collaborative) → 270  violet/purple
    Saturation by stability (0.0–1.0 maps to 0–80%):
      High stability = vivid; low stability = near-grey
    Medium-confidence lines: saturation halved (subtle signal, not noise)
    Lightness fixed at 72% for readability on dark backgrounds.

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

var versionData      = null;    /* built from JSON after fetch completes */
var versionsActive   = false;   /* true while timeline mode is on */
var activeVersion    = 'final'; /* which tick is currently selected */

/*
  authorshipData: keyed by JSON line id, stores the scores used for color.
  Built alongside versionData when the JSON loads.
  Shape: { '001': { authorship: 1.0, stability: 1.0, confidence: 'high' }, ... }
*/
var authorshipData   = null;

/*
  finalLineMap: maps cleaned final-version text → line id.
  Used to annotate <p> elements after restoring the HTML snapshot for the
  'final' version, since that snapshot was captured before the JSON was fetched
  and therefore has no data-line-id attributes.
  Shape: { 'Hello, world.': '004', ... }
*/
var finalLineMap     = null;

var authorshipActive = false;   /* true while authorship color mode is on */


// ─── Entry point ─────────────────────────────────────────────────────────────

/*
  Wire up the Versions button immediately (it only needs the HTML snapshot,
  not the JSON), then fetch the JSON so the timeline tick buttons can work.
  This means the button is responsive even before the JSON finishes loading.
*/
function versionsInit() {
  setupVersionsButton();
  setupAuthorshipButton(); /* always present — no JSON needed to wire the click */

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
        works for the 'final' view (HTML snapshot). Draft ticks won't respond,
        and the Authorship toggle won't apply colors. The rest of the page
        is unaffected.
      */
      console.warn('canvas-versions: could not load genealogy data.', err);
    });
}


// ─── Build per-version data from JSON ─────────────────────────────────────────

/*
  Turns the flat JSON lines array into:
    1. One ordered display array per version (stored in `versionData`).
    2. `authorshipData` — a keyed map of per-line color scores.
    3. `finalLineMap`   — a keyed map of cleaned final-version text to line id.

  Each display item has: id (JSON line id), cssClass, text (cleaned).
  Null entries (line absent in that version) are dropped entirely.
*/
function buildVersionData(genealogy) {
  var versions = {};
  VERSION_ORDER.forEach(function (v) { versions[v] = []; });

  /* Build the two authorship maps in the same pass through the lines array */
  authorshipData = {};
  finalLineMap   = {};

  genealogy.lines.forEach(function (line) {

    /* Store scores for this line — used later by applyAuthorshipColors() */
    authorshipData[line.id] = {
      authorship: line.authorship,
      stability:  line.stability,
      confidence: line.confidence
    };

    /*
      Map the cleaned final-version text to this line's id. When the 'final'
      HTML snapshot is restored, annotateStoryElements() walks the live <p>
      elements and uses this map to set data-line-id on each one.
    */
    if (line.versions.final !== null) {
      var cleanedFinal = cleanText(line.versions.final);
      if (cleanedFinal) finalLineMap[cleanedFinal] = line.id;
    }

    /* Populate each version's display array */
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

/*
  Wire the Authorship toggle. Called at init — the button is always in the DOM
  (not injected dynamically), so this runs immediately without waiting for JSON.
  If the user clicks before JSON loads, enterAuthorshipMode() guards against that.
*/
function setupAuthorshipButton() {
  var btn = document.getElementById('authorship-toggle');
  if (!btn) return;
  btn.addEventListener('click', toggleAuthorshipMode);
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
    If authorship mode is still on, renderVersion() will re-annotate and
    re-apply colors to the restored snapshot automatically.
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


// ─── Authorship toggle ────────────────────────────────────────────────────────

/* Click handler for the Authorship button — toggles authorship color mode. */
function toggleAuthorshipMode() {
  if (authorshipActive) {
    exitAuthorshipMode();
  } else {
    enterAuthorshipMode();
  }
}


// ─── Authorship color mode ────────────────────────────────────────────────────

/*
  Turns on authorship color mode:
    1. Annotates the current version's <p> elements with data-line-id if needed
       (the 'final' HTML snapshot doesn't have these — draft versions do,
       because makeParagraph() sets them when it builds the elements).
    2. Applies HSL colors to all annotated elements.
    3. Shows the legend below the timeline.
*/
function enterAuthorshipMode() {
  /* Guard: don't proceed if JSON hasn't loaded — no data to color with */
  if (!authorshipData) {
    console.warn('canvas-versions: authorship data not yet loaded.');
    return;
  }

  authorshipActive = true;

  /* Mark the button as active so the stylesheet can tint it */
  var btn = document.getElementById('authorship-toggle');
  if (btn) btn.classList.add('active');

  /*
    Annotate when showing the final HTML snapshot — either because versions mode
    is off (always showing final) or because the 'final' tick is selected.
    Draft versions don't need this: makeParagraph() already set data-line-id.
  */
  if (!versionsActive || activeVersion === 'final') annotateStoryElements();

  applyAuthorshipColors();
  showAuthorshipLegend();
}

/* Turns off authorship color mode: removes colors, hides legend, resets button. */
function exitAuthorshipMode() {
  authorshipActive = false;

  var btn = document.getElementById('authorship-toggle');
  if (btn) btn.classList.remove('active');

  removeAuthorshipColors();
  removeAuthorshipLegend();
}


// ─── Final-version annotation ─────────────────────────────────────────────────

/*
  Walks every <p> in .story and assigns a data-line-id to each one whose
  text content matches a known final-version line in finalLineMap.

  This is only needed for the 'final' version because it is rendered from the
  raw HTML snapshot (originalStoryHTML), which was captured before the JSON
  was fetched. All other versions go through makeParagraph(), which sets
  data-line-id directly at element creation time.

  Lines with no match in the JSON (e.g. the '—' separator, or lines that
  exist in the HTML but not in the genealogy) simply don't get annotated —
  they'll be skipped by applyAuthorshipColors() and remain the default color.
*/
function annotateStoryElements() {
  if (!finalLineMap) return;
  var story = document.querySelector('.story');
  if (!story) return;

  /*
    Build a case-insensitive lookup and a list of {keyLower, id} pairs for
    substring matching. Both are needed because the HTML and JSON can diverge
    in two ways:

      1. Capitalisation: e.g. JSON "The sum of…" vs HTML "the sum of…".
         Exact match fails; lowercase comparison finds it.

      2. Split paragraphs: the HTML sometimes breaks a single JSON entry across
         two <p> elements (e.g. "So you traded certainty for freedom." is its
         own paragraph in the HTML, but shares a JSON entry with the line that
         follows it). The substring check catches this — if the paragraph text
         is fully contained within a JSON entry, they share the same authorship.
         A minimum length guard (20 chars) prevents accidental false matches on
         short lines like "Yes." that could appear inside longer entries.
  */
  var lowerMap = {};
  var entries  = [];
  Object.keys(finalLineMap).forEach(function (key) {
    var keyLower = key.toLowerCase();
    lowerMap[keyLower] = finalLineMap[key];
    entries.push({ keyLower: keyLower, id: finalLineMap[key] });
  });

  story.querySelectorAll('p').forEach(function (el) {
    var text      = el.textContent.trim();
    var textLower = text.toLowerCase();

    /* 1. Exact match */
    var id = finalLineMap[text];

    /* 2. Case-insensitive exact match */
    if (!id) id = lowerMap[textLower];

    /* 3. Substring match — paragraph is part of a multi-sentence JSON entry */
    if (!id && textLower.length >= 20) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].keyLower.indexOf(textLower) !== -1) {
          id = entries[i].id;
          break;
        }
      }
    }

    if (id) el.dataset.lineId = id;
  });
}


// ─── Color application ────────────────────────────────────────────────────────

/*
  Applies a continuous HSL color gradient to every <p data-line-id> in .story.

  The authorship score (-1.0 to +1.0) is remapped to t (0.0 to 1.0) and used
  to drive tent-shaped saturation and lightness curves that pass through white
  at the collaborative midpoint (t=0.5):

    t=0   (pure Claude) → hsl(212, 55%, 70%)   clear steel blue
    t=0.5 (collaborative) → hsl(any, 0%, 90%)  neutral white (sat=0, hue irrelevant)
    t=1   (pure you)    → hsl(35, 20–75%, 84%) amber (stability-driven)

  Hue is pinned at 212 for the Claude half and 35 for the amber half rather
  than interpolated linearly — linear interpolation from 212→35 passes through
  green (120°) and teal (162°) in the middle, making Claude-leaning lines read
  as greenish. Pinning hue per half avoids this: the only crossover point is
  t=0.5, where saturation is already 0, making the discontinuity invisible.
*/
function applyAuthorshipColors() {
  if (!authorshipData) return;
  var story = document.querySelector('.story');
  if (!story) return;

  story.querySelectorAll('p[data-line-id]').forEach(function (el) {
    var id   = el.dataset.lineId;
    var meta = authorshipData[id];
    if (!meta) return; /* line not in metadata — leave default color */

    var authorship = meta.authorship;
    var stability  = meta.stability;

    /* Remap authorship from [-1, +1] to [0, 1] */
    var t = (authorship + 1) / 2;

    /*
      Hue: pinned per half so the gradient never passes through green.
      Claude half (t < 0.5) stays at 200 (teal-blue, pops more on dark bg).
      Amber half  (t ≥ 0.5) stays at 35 (amber).
      The crossover at t=0.5 is invisible because saturation = 0 there.
    */
    var hue = t < 0.5 ? 200 : 35;

    /*
      Saturation: tent — peaks at the endpoints, collapses to 0 at t=0.5.
      u = |2t − 1| gives 1 at both endpoints and 0 at the midpoint.

      Claude side uses a gentle power curve (u^0.65) so the saturation decays
      more slowly — lines scored at -0.3 to -0.5 stay visibly teal rather than
      fading to near-grey. Linear decay would halve the saturation at t=0.25;
      the curve keeps it at ~62% of maximum there instead.

      Amber end: 20–75% driven by stability (fragile lines near white, stable = amber).
    */
    var u = Math.abs(2 * t - 1);
    var saturationAmber = 20 + stability * 55;
    var saturation = t < 0.5
      ? Math.pow(u, 0.65) * 65   /* biased: decays slowly, 65% at pure Claude */
      : u * saturationAmber;

    /*
      Lightness: inverse tent — 68% at the teal end (vivid on dark bg),
      peaks at 90% at the midpoint, settles at 84% at the amber end.
    */
    var lightness = t < 0.5
      ? 68 + (t / 0.5) * (90 - 68)          /* 68 → 90 */
      : 90 + ((t - 0.5) / 0.5) * (84 - 90); /* 90 → 84 */

    el.style.color = 'hsl(' + hue + ', ' + saturation.toFixed(1) + '%, ' + lightness.toFixed(1) + '%)';
  });
}

/*
  Removes all inline color styles from <p> elements in .story.
  Called when authorship mode is turned off — returns full control
  to the stylesheet so the dark-theme default colors take over again.
*/
function removeAuthorshipColors() {
  var story = document.querySelector('.story');
  if (!story) return;
  story.querySelectorAll('p').forEach(function (el) {
    el.style.color = '';
  });
}


// ─── Authorship legend ────────────────────────────────────────────────────────

/*
  Injects a small legend div below the timeline bar explaining the color scheme.
  Three color swatches (you / both / claude) plus a note about saturation.
  Styled via style-canvas.css — see #authorship-legend there.
*/
function showAuthorshipLegend() {
  /* Don't add a duplicate if already visible */
  if (document.getElementById('authorship-legend')) return;

  var legend = document.createElement('div');
  legend.id = 'authorship-legend';

  /*
    A single horizontal gradient bar running from Claude's blue to your amber,
    with labels at each end. Reflects the continuous gradient rather than three
    discrete categories.
  */
  legend.innerHTML =
    '<span class="legend-end" style="color: hsl(35, 75%, 84%)">Shehryar</span>' +
    '<span class="legend-bar"></span>' +
    '<span class="legend-end" style="color: hsl(200, 65%, 68%)">Claude</span>';

  /*
    Insert after the controls row so the legend is always visible whether
    versions mode is active or not — the timeline bar may be hidden, but
    authorship mode is now independent of it.
  */
  var controlsRow = document.querySelector('.controls-row');
  if (controlsRow && controlsRow.parentNode) {
    controlsRow.parentNode.insertBefore(legend, controlsRow.nextSibling);
  }
}

/* Removes the legend div from the DOM. */
function removeAuthorshipLegend() {
  var legend = document.getElementById('authorship-legend');
  if (legend && legend.parentNode) legend.parentNode.removeChild(legend);
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
  replicate. If authorship mode is on, the restored elements are annotated
  with data-line-id (via annotateStoryElements) and then colored.

  For draft versions, render order is:
    1. Bylines from JSON (absent in all pre-final versions)
    2. Byline-position supplements (e.g. 'co-written with Claude')
    3. Opening '—' separator — structural; present in all versions
    4. Story content: direction, ai, creator, story-break, epilogue lines
    5. End-position supplements (e.g. date colophon)
  Each element is created by makeParagraph(), which sets data-line-id.
  If authorship mode is on, colors are applied immediately after rendering.

  Lines that are null in the JSON for this version are simply absent.
*/
function renderVersion(version) {
  var story = document.querySelector('.story');
  if (!story) return;

  /* For final, use the original HTML snapshot — exact match guaranteed */
  if (version === 'final') {
    story.innerHTML = originalStoryHTML;

    /*
      The restored snapshot has no data-line-id attributes (it was captured
      before the JSON loaded). If authorship mode is on, annotate then color.
    */
    if (authorshipActive) {
      annotateStoryElements();
      applyAuthorshipColors();
    }
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
    story.appendChild(makeParagraph(line.cssClass, line.text, line.id));
  });

  /* 2. Byline-position supplements */
  injectSupplements(story, version, 'bylines');

  /* 3. Opening separator — sits between bylines and the first dialogue line */
  story.appendChild(makeParagraph('story-break', '—'));

  /* 4. All story content in JSON order */
  storyContent.forEach(function (line) {
    story.appendChild(makeParagraph(line.cssClass, line.text, line.id));
  });

  /* 5. End-position supplements */
  injectSupplements(story, version, 'end');

  /*
    If authorship mode is active, color the freshly rendered elements.
    They already have data-line-id set by makeParagraph(), so no annotation
    pass is needed here (unlike the 'final' snapshot path above).
  */
  if (authorshipActive) applyAuthorshipColors();
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

/*
  Creates a <p> element with the given CSS class and text content.
  If lineId is provided, it is stored as data-line-id so that
  applyAuthorshipColors() can look up the line's color metadata.
*/
function makeParagraph(cssClass, text, lineId) {
  var p = document.createElement('p');
  p.className   = cssClass;
  p.textContent = text;
  if (lineId) p.dataset.lineId = lineId;
  return p;
}


// 
// ─── Bootstrap ────────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', versionsInit);
} else {
  versionsInit();
}
