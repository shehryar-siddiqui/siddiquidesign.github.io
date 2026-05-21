/*
  sidebar.js
  Controls two collapsible elements on section pages.

  Why setTimeout instead of transitionend events:
    The child elements inside .about-body (p, h4) have their own CSS color
    transitions. When those complete, they fire transitionend events that bubble
    up to .about-body and accidentally trigger listeners meant only for the height
    animation. Using setTimeout avoids all event bubbling issues entirely.

  COUPLING NOTE: TRANSITION_MS must match the transition durations set in
  style.css for .about-body (height) and .about-sidebar (width). If you change
  those values in CSS, update this constant to match.
*/

const TRANSITION_MS = 400; // matches 'transition: ... 0.4s' in style.css


/* ── Left navigation sidebar (mobile toggle) ──────────────────────────── */

// Only initialize the toggle on mobile-width viewports.
// On desktop the sidebar is always visible and the toggle button is display:none —
// attaching behavior to a hidden button on desktop can interfere with the layout
// and the About panel, so we gate it here with the same 768px threshold used in CSS.
if (window.innerWidth <= 768) {

  const sidebarToggle = document.querySelector('.sidebar-toggle');
  const navSidebar    = document.getElementById('nav-sidebar');

  if (sidebarToggle && navSidebar) {
    sidebarToggle.addEventListener('click', function () {
      const isOpen = this.getAttribute('aria-expanded') === 'true';

      if (isOpen) {
        navSidebar.style.height = '0';
        this.setAttribute('aria-expanded', 'false');
      } else {
        navSidebar.style.height = navSidebar.scrollHeight + 'px';
        this.setAttribute('aria-expanded', 'true');
      }
    });
  }

}


/* ── Right "About" sidebar ─────────────────────────────────────────────── */

// The About panel is a desktop feature (not viewport-gated) — it expands
// sideways on desktop and stacks vertically on mobile, but the JS is the same.
const aboutToggle  = document.querySelector('.about-toggle');
const aboutBody    = document.getElementById('about-body');
const aboutSidebar = aboutToggle ? aboutToggle.closest('.about-sidebar') : null;

if (aboutToggle && aboutBody && aboutSidebar) {
  aboutToggle.addEventListener('click', function () {
    const isOpen = this.getAttribute('aria-expanded') === 'true';

    if (isOpen) {
      // ── Closing ──────────────────────────────────────────────────────────
      // offsetHeight reads the currently rendered height — works whether the
      // element is at a pixel value or 'auto'. Pin it so the browser has a
      // concrete start value for the transition, then animate to 0.
      aboutBody.style.height = aboutBody.offsetHeight + 'px';
      requestAnimationFrame(() => {
        aboutBody.style.height = '0';
      });
      this.setAttribute('aria-expanded', 'false');

      // After the height finishes collapsing, remove .open to collapse the width.
      // setTimeout is more reliable than transitionend here because color transitions
      // on child elements bubble up and can fire the listener at the wrong time.
      setTimeout(() => {
        aboutSidebar.classList.remove('open');
      }, TRANSITION_MS);

    } else {
      // ── Opening ──────────────────────────────────────────────────────────
      // Step 1: expand the panel width first (mirrors closing, where height
      // collapses before the width).
      aboutSidebar.classList.add('open');
      this.setAttribute('aria-expanded', 'true');

      // Step 2: wait for the width transition to finish, then wipe the text
      // in downward. The rAF inside ensures layout is settled before measuring.
      setTimeout(() => {
        requestAnimationFrame(() => {
          aboutBody.style.height = aboutBody.scrollHeight + 'px';
        });
      }, TRANSITION_MS);
    }
  });
}
