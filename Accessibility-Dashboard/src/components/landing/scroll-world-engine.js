/* ============================================================================
   scroll-world — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       sections: [
         { id, label, still, stillMobile, clip, clipMobile, accent,
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in mobile version;
   the rest of the phone handling below is always on)
     The engine is phone-aware out of the box: on a coarse-pointer / ≤860px viewport it
       - loads `clipMobile` / `connectorsMobile` when provided (encode these smaller +
         tighter-GOP — seek cost on a phone decoder is dominated by frames-from-keyframe,
         so a 720p, -g 4 file scrubs far smoother than the 1080p desktop master; see
         pipeline.md). Falls back to the desktop `clip` if no mobile variant is given.
       - uses `stillMobile` as the scene poster when provided (pair it with native 9:16
         clipMobile renders so the poster matches the portrait video's first frame instead
         of flashing from a landscape crop). Chosen once at mount; a desktop resize into
         phone width keeps the desktop poster (clips still switch via isMobile()).
       - coalesces seeks (never issues a new currentTime while the decoder is still
         `seeking`) so fast flicks can't pile up and freeze the video.
       - keeps the still as a live poster until the clip actually paints its first frame,
         and primes each video (muted play→pause) on first touch — this is what stops iOS
         from showing a blank scene before the first seek.
       - drops the drifting particles and ignores URL-bar-only resizes (no scroll jump).
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   REQUIREMENTS ON YOUR ASSETS
     - clips encoded native-res, crf~20, -g 8, +faststart, no audio (see pipeline.md)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - (optional) mobile variants at ~720p, -g 4 for smoother phone scrubbing
   The engine loads each clip as a Blob (always seekable) and scrubs currentTime; it does
   NOT depend on HTTP byte-range support.
   ========================================================================== */

export function mountScrollWorld(container, config, options = {}) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phone detection. `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches sources and seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isNarrow = () => smallMQ.matches;
  const isMobile = () => coarse || isNarrow();
  // Resolution tiers: pick ONE clip variant per visit from the viewport's device pixels, so an FHD
  // screen gets a 1080p file (crisp) instead of downscaling a 4K master by 2-4x (blurry). Config:
  //   clipVariants: [{ maxDevicePx: 2100, suffix: '-1080' }, { maxDevicePx: 3000, suffix: '-1440' }]
  // A clip URL 'x.mp4' becomes 'x-1080.mp4' etc.; no match = the master file as written.
  const devicePx = Math.round(Math.max(window.innerWidth, 320) * (window.devicePixelRatio || 1));
  const VARIANT = (config.clipVariants || []).slice().sort((p, q) => p.maxDevicePx - q.maxDevicePx).find(v => devicePx <= v.maxDevicePx);
  const tierUrl = (url) => (url && VARIANT && VARIANT.suffix) ? url.replace(/(\.[a-z0-9]+)(\?.*)?$/i, VARIANT.suffix + '$1$2') : url;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const saveData = Boolean(connection && connection.saveData);
  const useStaticMedia = () => reduce || saveData || (isMobile() && config.mobileVideo === false);
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return () => {};

  let destroyed = false;
  let rafId = 0;
  let unsubscribeScroll = () => {};
  const abortControllers = new Set();
  const objectUrls = new Set();
  const pendingTimers = new Set();

  injectCSS();
  container.replaceChildren();
  container.classList.add('sw-root');

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile, still: s.still, stillM: s.stillMobile, layout: s.layout || 'full',
                   accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, stillM: SECTIONS[i + 1].stillMobile,
                      accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const skip = el('a', 'sw-skip-link');
  skip.href = `#${config.mainId || 'uni-access-main'}`;
  skip.textContent = config.skipLabel || '본문으로 바로가기';

  const topbar = el('header', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    if (config.brand.wordmark) {
      // Typographic wordmark: strong word · accent square dot · light word (e.g. UNI · ACCESS).
      const wm = el('span', 'sw-wordmark');
      const strong = el('span', 'sw-wordmark__strong'); strong.textContent = config.brand.wordmark.strong || '';
      const dot = el('span', 'sw-wordmark__dot'); dot.setAttribute('aria-hidden', 'true');
      const light = el('span', 'sw-wordmark__light'); light.textContent = config.brand.wordmark.light || '';
      wm.append(strong, dot, light);
      brand.setAttribute('aria-label', config.brand.name || '');
      brand.appendChild(wm);
    } else {
      brand.appendChild(el('span', 'sw-brand__mark'));
      const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    }
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav');
  nav.setAttribute('aria-label', '제품 둘러보기');
  if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    if (config.cta.action) c.dataset.swAction = config.cta.action;
    topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  stage.setAttribute('aria-hidden', 'true');
  const copylayer = el('main', 'sw-copylayer');
  copylayer.id = config.mainId || 'uni-access-main';
  copylayer.tabIndex = -1;
  const route = el('nav', 'sw-route');
  route.setAttribute('aria-label', '현재 장면');
  if (config.route === false) route.style.display = 'none';   // route:false → 오른쪽 세로 진행 레일 숨김
  const hint = config.hint ? el('button', 'sw-hint') : null;
  const hintText = el('span');
  let hintAtBottom = false;
  if (hint) {
    hint.type = 'button';
    hint.setAttribute('aria-label', `${config.hint}: 아래로 스크롤`);
    const arrow = el('i');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16m-6-6 6 6 6-6"/></svg>';
    hintText.textContent = config.hint;
    hint.append(arrow, hintText);
    hint.addEventListener('click', () => {
      window.scrollTo({
        top: hintAtBottom ? 0 : window.scrollY + window.innerHeight * 0.8,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
      });
    });
  }
  const track = el('div', 'sw-track');
  track.setAttribute('aria-hidden', 'true');

  [skip, sky, topbar, stage, copylayer, route, hint, track]
    .filter(Boolean)
    .forEach(n => container.appendChild(n));

  // segment scenes
  SEGMENTS.forEach((s, segmentIndex) => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async';
    img.loading = segmentIndex === 0 ? 'eager' : 'lazy';
    if (segmentIndex === 0) img.fetchPriority = 'high';
    const poster = (isMobile() && s.stillM) ? s.stillM : s.still;
    if (poster) img.src = poster;
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false; s.cardT = 0;
  });

  // ---- card layout: a section with layout:'card' shows its clip inside a rounded box on the
  // right (copy on the left). The first card after a full-bleed section shrinks from full-bleed
  // over the first `in` fraction of its scroll band; driven by scroll, so it rewinds too.
  const CARD = Object.assign({ width: 54, right: 4, radius: 24, in: 0.22, maxH: 82 }, config.card || {});
  function applyCard(s) {
    const t = s.cardT, vw = window.innerWidth, vhh = window.innerHeight;
    // Geometry follows the viewport, not the pointer type. A wide touch display
    // should keep the desktop composition even though media loading is still
    // allowed to use the lighter mobile path.
    const narrow = isNarrow();
    const compact = !narrow && vw < 1280;
    const width = narrow ? 92 : compact ? 48 : CARD.width;
    const right = narrow ? 4 : CARD.right;
    const maxH = narrow ? 46 : CARD.maxH;
    const visualScale = Math.max(1, Math.min(2, Math.min(vw / 1920, vhh / 1080)));
    let w = vw * width / 100, h = w * 9 / 16;
    if (h > vhh * maxH / 100) { h = vhh * maxH / 100; w = h * 16 / 9; }
    const L = vw - vw * right / 100 - w, T = narrow ? Math.max(84, vhh * 0.13) : (vhh - h) / 2, lerp = (a, b) => a + (b - a) * t;
    const st = { left: lerp(0, L) + 'px', top: lerp(0, T) + 'px', width: lerp(vw, w) + 'px', height: lerp(vhh, h) + 'px',
      right: 'auto', bottom: 'auto', transform: 'none', borderRadius: lerp(0, CARD.radius * visualScale) + 'px',
      boxShadow: `0 ${(28 * visualScale * t).toFixed(1)}px ${(80 * visualScale * t).toFixed(1)}px rgba(0,0,0,${(0.16 * t).toFixed(3)})` };
    [s.img, s.video].forEach(e => { if (e) Object.assign(e.style, st); });
    s.el.classList.toggle('is-card', t > 0.001);
  }

  // per-section copy / route / nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    c.id = `sw-section-${s.id || i + 1}`;
    c.setAttribute('aria-hidden', 'true');
    c.inert = true;
    const headingTag = i === 0 ? 'h1' : 'h2';
    const headingId = i === 0 ? 'ua-hero-title' : `sw-title-${s.id || i + 1}`;
    const headingClass = 'sw-copy__title';
    c.innerHTML =
      (config.showSectionNumbers === false ? '' : `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>`) +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<${headingTag} id="${headingId}" class="${headingClass}">${esc(s.title)}</${headingTag}>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.type = 'button'; dot.style.setProperty('--sw-accent', s.accent || '');
    dot.setAttribute('aria-label', `${i + 1}. ${s.label || '장면'}`);
    dot.setAttribute('aria-controls', c.id);
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.type = 'button'; b.textContent = s.label || '';
      b.setAttribute('aria-controls', c.id);
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });
  // Extra nav links to content below the film (e.g. a normal section with id="engine"):
  //   navLinks: [{ label: '분석 엔진', href: '#engine' }]
  if (Array.isArray(config.navLinks) && config.navLinks.length) {
    // Links work even with nav:false (section pills off): the nav then holds only these links.
    if (!nav.isConnected) topbar.insertBefore(nav, topbar.querySelector('.sw-topcta'));
    config.navLinks.forEach(link => {
      const a = el('a', 'sw-nav__item sw-nav__item--link'); a.href = link.href || '#'; a.textContent = link.label || '';
      nav.appendChild(a);
    });
  }

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, totalW = 0, activeIndex = -1, ticking = false, endedState = false;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    read();
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  function onActionClick(event) {
    const action = event.currentTarget.dataset.swAction;
    if (action !== 'enter-app' || typeof options.onEnterApp !== 'function') return;
    event.preventDefault();
    options.onEnterApp();
  }

  function onSectionLinkClick(event) {
    const sectionIndex = SECTIONS.findIndex(
      section => section.id === event.currentTarget.dataset.swSection
    );
    if (sectionIndex < 0) return;
    event.preventDefault();
    jumpTo(sectionIndex);
  }

  container.querySelectorAll('[data-sw-action]').forEach(link => {
    link.addEventListener('click', onActionClick);
  });
  container.querySelectorAll('[data-sw-section]').forEach(link => {
    link.addEventListener('click', onSectionLinkClick);
  });

  function loadClip(s) {
    // Under prefers-reduced-motion we never load the clips at all — the stills stay up
    // and simply cross-dissolve as you scroll. No scrubbed video motion, no decode cost.
    if (useStaticMedia() || destroyed || s.loading || !s.clip) return;
    s.loading = true;
    // Deferring one task prevents React StrictMode's intentional first
    // setup/cleanup cycle from starting a duplicate multi-megabyte request.
    const timer = window.setTimeout(() => {
      pendingTimers.delete(timer);
      if (destroyed) {
        s.loading = false;
        return;
      }
      // Serve the lighter mobile encode on phones when one was provided.
      const url = tierUrl((isMobile() && s.clipM) ? s.clipM : s.clip);
      const controller = new AbortController();
      abortControllers.add(controller);
      fetch(url, { signal: controller.signal }).then(r => r.ok ? r.blob() : Promise.reject(new Error('404')))
        .then(blob => {
          if (destroyed) return;
          const v = document.createElement('video');
          v.className = 'sw-scene__video';
          v.muted = true; v.playsInline = true; v.preload = 'auto';
          v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
          const objectUrl = URL.createObjectURL(blob);
          objectUrls.add(objectUrl);
          v.src = objectUrl;
          v.addEventListener('loadedmetadata', () => { s.ready = true; read(); });
          // Reveal the video (hide the still poster) only once a real frame has
          // painted — on iOS a seeked-but-never-played muted video stays blank, so
          // hiding the still on metadata alone would flash an empty scene.
          v.addEventListener('seeked', () => { s.el.classList.add('has-clip'); }, { once: true });
          v.addEventListener('loadeddata', () => { try { v.pause(); } catch (e) {} if (userReady) primeVideo(v); });
          s.el.appendChild(v); s.video = v; s.hasClip = true;
          if (s.layout === 'card') applyCard(s);
        }).catch(error => {
          if (error && error.name !== 'AbortError') s.loading = false;
        }).finally(() => {
          abortControllers.delete(controller);
        });
    }, 40);
    pendingTimers.add(timer);
  }

  function read() {
    if (destroyed) return;
    const y = window.scrollY || window.pageYOffset;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (y > s.start - 0.9 * vh && y < s.end + 0.9 * vh) loadClip(s);
      const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
      s.target = s.linger ? lingerEase(local, s.linger) : local;
      if (s.kind === 'dive' && s.layout === 'card') {
        const prevFull = s.si === 0 || (SECTIONS[s.si - 1].layout || 'full') !== 'card';
        s.cardT = prevFull ? smooth(clamp(local / CARD.in)) : 1;
        applyCard(s);
      }
      let outside = 0;
      // The final scene stays fully visible past its end: it scrolls away with the page (see sw-ended).
      if (y < s.start) outside = s.start - y; else if (y > s.end && i !== NSEG - 1) outside = y - s.end;
      const op = smooth(1 - outside / fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      s.el.style.zIndex = (i === ci) ? '120' : String(100 + Math.round(op * 10));
      if ((!s.hasClip || !s.ready) && s.layout !== 'card') {
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `scale(${sc.toFixed(3)})`;
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);            // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else if ((SECTIONS[i].layout || 'full') === 'card')                 // card copy: enter after the box settles, hold, leave late
        cop = (before || after) ? 0 : smooth(clamp(Math.min(pr / Math.max(CARD.in, 0.2), (1 - pr) / 0.15)));
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      const slideX = (SECTIONS[i].layout || 'full') === 'card' ? (1 - cop) * -3 : 0;   // card copy enters from the left
      const driftY = (0.5 - pr) * 4;
      // Desktop copy is positioned from top:50%, so preserve its centering
      // translate when the scroll animation writes an inline transform. Narrow
      // layouts are bottom-anchored and therefore need no percentage offset.
      c.style.transform = reduce
        ? (isNarrow() ? 'none' : 'translateY(-50%)')
        : isNarrow()
          ? `translate(${slideX.toFixed(2)}vw, ${driftY}vh)`
          : `translate(${slideX.toFixed(2)}vw, calc(-50% + ${driftY}vh))`;
      const isInteractive = cop > 0.5;
      c.style.pointerEvents = isInteractive ? 'auto' : 'none';
      c.setAttribute('aria-hidden', String(!isInteractive));
      c.inert = !isInteractive;
    }

    // ---- end of film: hand the last frame over to the document flow ----
    // While the film plays the stage/copy are position:fixed. Once the scroll passes the last
    // band (filmEnd) they become position:absolute at exactly that document offset, so the
    // final scene scrolls away with the page and whatever follows the mount container
    // (a normal section) continues directly beneath it. Reversible on scroll-up.
    const filmEnd = totalW * vh;
    const ended = y >= filmEnd;
    if (ended !== endedState) {
      endedState = ended;
      container.classList.toggle('sw-ended', ended);
      [stage, copylayer].forEach(n => {
        n.style.position = ended ? 'absolute' : '';
        n.style.top = ended ? filmEnd + 'px' : '';
        n.style.bottom = ended ? 'auto' : '';
        n.style.height = ended ? vh + 'px' : '';
      });
    }
    // Fade the last scene's copy as it scrolls away so it never collides with the fixed topbar.
    if (ended) copylayer.style.opacity = String(clamp(1 - (y - filmEnd) / (vh * 0.45))); else copylayer.style.opacity = '';
    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => {
        const isActive = k === near;
        d.classList.toggle('is-active', isActive);
        d.classList.toggle('is-past', k < near);
        if (isActive) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
      });
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => {
        const isActive = k === near;
        n.classList.toggle('is-active', isActive);
        if (isActive) n.setAttribute('aria-current', 'step'); else n.removeAttribute('aria-current');
      });
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
      container.classList.toggle('sw-card-active', (SECTIONS[near].layout || 'full') === 'card');
    }
    // This replaces the removed horizontal page gauge, so it follows the
    // complete scroll range rather than jumping to fixed scene bands.
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const routeProgress = clamp(y / Math.max(1, maxScroll));
    route.style.setProperty('--sw-route-progress', routeProgress.toFixed(5));
    // Keep the control through the content after the film, until the document's actual end.
    const atBottom = maxScroll > 0 && maxScroll - y <= 24;
    if (hint && atBottom !== hintAtBottom) {
      hintAtBottom = atBottom;
      hint.classList.toggle('is-top', atBottom);
      hintText.textContent = atBottom ? 'TOP' : config.hint;
      hint.setAttribute('aria-label', atBottom ? 'TOP: 맨 위로 이동' : `${config.hint}: 아래로 스크롤`);
    }
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  function raf() {
    if (destroyed) return;
    const eps = isMobile() ? 0.02 : 0.008;   // coarser seek step on phones = fewer decodes
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      if (!s.hasClip || !s.ready || !s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // cur keeps lerping, so we snap to the latest target the moment it's free.
      if (s.video.seeking) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;
      s.cur += (s.target - s.cur) * (reduce ? 1 : 0.18);
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      if (Math.abs(s.video.currentTime - t) > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    rafId = requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. On the
  // first touch we prime every loaded clip (muted play→pause) so the first seek is
  // instant instead of showing a blank frame. `userReady` also makes freshly-loaded
  // clips prime themselves (see loadClip).
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => {}); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    SEGMENTS.forEach(s => primeVideo(s.video));
  }
  if (!useStaticMedia()) {
    window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
    window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });
  }

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse || config.atmosphere === false);
  function onScroll() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(read);
    }
  }
  if (typeof options.subscribeScroll === 'function') {
    unsubscribeScroll = options.subscribeScroll(onScroll) || (() => {});
  }
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) { read(); return; }
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  container.dataset.scrollWorldReady = 'true';
  if (!useStaticMedia()) rafId = requestAnimationFrame(raf);

  return () => {
    destroyed = true;
    cancelAnimationFrame(rafId);
    unsubscribeScroll();
    pendingTimers.forEach(timer => window.clearTimeout(timer));
    pendingTimers.clear();
    abortControllers.forEach(controller => controller.abort());
    abortControllers.clear();
    window.removeEventListener('pointerdown', onFirstGesture);
    window.removeEventListener('touchstart', onFirstGesture);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', layout);
    window.removeEventListener('load', layout);
    SEGMENTS.forEach(segment => {
      if (!segment.video) return;
      try { segment.video.pause(); } catch (error) {}
      segment.video.removeAttribute('src');
      segment.video.load();
    });
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls.clear();
    container.replaceChildren();
    container.classList.remove('sw-root', 'sw-card-active');
    container.removeAttribute('data-scroll-world-ready');
    container.style.removeProperty('--sw-accent');
  };

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}"${cta.primary.action ? ` data-sw-action="${esc(cta.primary.action)}"` : ''}>${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}"${cta.secondary.section ? ` data-sw-section="${esc(cta.secondary.section)}"` : ''}>${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  const existingStyle = document.getElementById('sw-css');
  const css = `
  .sw-root{--sw-bg:#f5f5f7;--sw-ink:#1d1d1f;--sw-ink-soft:#6e6e73;--sw-accent:#0071e3;
    --sw-font-display:"Pretendard Variable",Pretendard,"Noto Sans KR",system-ui,sans-serif;
    --sw-font-body:"Pretendard Variable",Pretendard,"Noto Sans KR",system-ui,sans-serif;
    position:relative;min-height:100vh;margin:0;overflow-x:clip;background:var(--sw-bg);color:var(--sw-ink);font-family:var(--sw-font-body);}
  .sw-root *{box-sizing:border-box;}
  .sw-skip-link{position:fixed;left:16px;top:12px;z-index:1000;transform:translateY(-180%);border-radius:10px;background:#fff;color:var(--sw-ink);padding:12px 16px;font-weight:700;text-decoration:none;box-shadow:0 8px 30px rgba(0,0,0,.16);transition:transform .18s ease;}
  .sw-skip-link:focus-visible{transform:translateY(0);outline:3px solid var(--sw-accent);outline-offset:3px;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;min-height:44px;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  .sw-wordmark{display:inline-flex;align-items:baseline;gap:.18em;font-family:var(--sw-font-display);font-size:1.125rem;line-height:1;letter-spacing:-.035em;color:var(--sw-ink);}
  .sw-wordmark__strong{font-weight:800;} .sw-wordmark__light{font-weight:400;}
  .sw-wordmark__dot{display:inline-block;width:.2em;height:.2em;border-radius:.05em;background:var(--sw-accent);transform:translateY(-.04em);}
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{min-height:44px;font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-nav__item--link{display:inline-flex;align-items:center;text-decoration:none;}
  .sw-topcta{display:inline-flex;min-height:44px;align-items:center;justify-content:center;text-decoration:none;font-weight:700;font-size:.9rem;color:#fff;background:var(--sw-accent);padding:10px 20px;border-radius:999px;white-space:nowrap;transition:transform .2s ease,box-shadow .2s ease;}
  .sw-topcta:hover{transform:translateY(-2px);box-shadow:0 10px 24px color-mix(in srgb,var(--sw-accent) 26%,transparent);}
  .sw-stage{position:fixed;inset:0;z-index:10;inline-size:100vw;inline-size:100dvw;block-size:100vh;block-size:100dvh;max-inline-size:none;margin:0;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;inline-size:100%;block-size:100%;overflow:hidden;opacity:0;will-change:opacity;}
  .sw-scene.is-card{background:#fff;}
  .sw-copylayer::before{transition:opacity .5s;} .sw-root.sw-card-active .sw-copylayer::before{opacity:0;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,clamp(380px,24vw,460px));opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,1.5rem + 1.667vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__title,.sw-copy__body{word-break:keep-all;overflow-wrap:break-word;}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:#fff;padding:7px 14px;border-radius:999px;background:var(--sw-ink);border:1px solid var(--sw-ink);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{display:inline-flex;min-height:48px;align-items:center;justify-content:center;text-decoration:none;font-weight:700;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s,box-shadow .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-accent);} .sw-btn--primary:hover{transform:translateY(-2px);box-shadow:0 10px 24px color-mix(in srgb,var(--sw-accent) 26%,transparent);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{--sw-route-progress:0;position:fixed;right:clamp(8px,2.1vw,26px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:4px;padding:12px 0;}
  .sw-root.sw-ended .sw-route{opacity:0;pointer-events:none;}
  .sw-route{transition:opacity .25s;}
  .sw-route::before,.sw-route::after{content:"";position:absolute;left:50%;top:30px;bottom:30px;z-index:0;width:3px;border-radius:999px;pointer-events:none;}
  .sw-route::before{transform:translateX(-50%);background:color-mix(in srgb,var(--sw-accent) 18%,transparent);}
  .sw-route::after{transform:translateX(-50%) scaleY(var(--sw-route-progress));transform-origin:50% 0;background:var(--sw-accent);will-change:transform;}
  .sw-route__dot{position:relative;z-index:1;border:0;background:transparent;cursor:pointer;width:44px;height:44px;display:grid;place-items:center;}
  .sw-hint{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));z-index:60;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-width:104px;min-height:56px;margin:0;padding:6px 8px;border:0;border-radius:4px;background:transparent;font-family:var(--sw-font-body);font-size:.625rem;font-weight:800;line-height:1.4;letter-spacing:.1em;white-space:nowrap;color:var(--sw-ink);text-shadow:0 1px 8px var(--sw-bg);cursor:pointer;}
  .sw-hint i{display:grid;place-items:center;width:20px;height:20px;transition:transform .25s ease;}
  .sw-hint svg{display:block;animation:sw-scroll-down 1.8s ease-in-out infinite;}
  .sw-hint.is-top i{transform:rotate(180deg);}
  @keyframes sw-scroll-down{0%,100%{transform:translateY(-2px)}50%{transform:translateY(3px)}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (min-width:861px) and (max-width:1279px){
    .sw-copy{width:min(40vw,clamp(380px,24vw,460px));}
  }
  /* Above 1080p, scale with the smaller viewport axis. This keeps true 4K
     legible without making short ultrawide screens disproportionately large. */
  @media (min-width:1921px) and (min-height:1001px){
    .sw-topbar{gap:clamp(16px,min(.84vw,1.48vh),28px);padding-block:clamp(26px,min(1.35vw,2.4vh),52px);padding-inline:clamp(64px,3.333vw,128px);}
    .sw-brand{min-height:clamp(44px,min(2.3vw,4.1vh),72px);gap:clamp(10px,min(.53vw,.93vh),17px);}
    .sw-brand__mark{width:clamp(24px,min(1.25vw,2.22vh),40px);height:clamp(28px,min(1.46vw,2.6vh),46px);border-radius:clamp(7px,min(.37vw,.65vh),12px) clamp(7px,min(.37vw,.65vh),12px) clamp(10px,min(.53vw,.93vh),17px) clamp(10px,min(.53vw,.93vh),17px);}
    .sw-brand__name,.sw-wordmark{font-size:clamp(1.1rem,min(.92vw,1.63vh),1.65rem);}
    .sw-topcta{min-height:clamp(44px,min(2.3vw,4.1vh),72px);font-size:clamp(.9rem,min(.75vw,1.35vh),1.3rem);padding-block:clamp(10px,min(.53vw,.93vh),17px);padding-inline:clamp(20px,min(1.05vw,1.85vh),34px);}
    .sw-copylayer::before{width:min(58vw,clamp(780px,40.625vw,1300px));}
    .sw-copy{left:clamp(64px,3.333vw,128px);width:min(42vw,clamp(460px,24vw,880px));}
    .sw-copy__num{font-size:clamp(.74rem,min(.62vw,1.1vh),1.2rem);}
    .sw-copy__eyebrow{margin-top:clamp(18px,min(.94vw,1.67vh),30px);font-size:clamp(.8rem,min(.63vw,1.2vh),1.25rem);}
    .sw-copy__title{font-size:clamp(3.5rem,min(2.9vw,5.2vh),6rem);margin-top:clamp(12px,min(.63vw,1.12vh),20px);}
    .sw-copy__body{margin-top:clamp(18px,min(.95vw,1.7vh),30px);font-size:clamp(1.14rem,min(.95vw,1.7vh),1.75rem);}
    .sw-copy__tags{gap:clamp(8px,min(.42vw,.74vh),14px);margin-top:clamp(24px,min(1.25vw,2.22vh),40px);}
    .sw-copy__tags li{font-size:clamp(.82rem,min(.68vw,1.22vh),1.25rem);padding-block:clamp(7px,min(.37vw,.65vh),12px);padding-inline:clamp(14px,min(.73vw,1.3vh),24px);}
    .sw-copy__cta{gap:clamp(12px,min(.63vw,1.12vh),20px);margin-top:clamp(28px,min(1.46vw,2.6vh),46px);}
    .sw-btn{min-height:clamp(48px,min(2.5vw,4.45vh),76px);font-size:clamp(.95rem,min(.75vw,1.35vh),1.4rem);padding-block:clamp(13px,min(.68vw,1.2vh),22px);padding-inline:clamp(24px,min(1.25vw,2.22vh),40px);}
    .sw-route{right:clamp(26px,1.35vw,52px);gap:clamp(4px,min(.21vw,.37vh),7px);padding-block:clamp(12px,min(.63vw,1.12vh),20px);}
    .sw-route::before,.sw-route::after{top:clamp(30px,min(1.57vw,2.78vh),50px);bottom:clamp(30px,min(1.57vw,2.78vh),50px);width:clamp(3px,min(.16vw,.28vh),6px);}
    .sw-route__dot{width:clamp(44px,min(2.3vw,4.1vh),72px);height:clamp(44px,min(2.3vw,4.1vh),72px);}
  }
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:calc(clamp(18px,5vw,64px) + 44px + env(safe-area-inset-right));top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:calc(6px + env(safe-area-inset-right));}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:10px 0;}
    .sw-route__dot{width:44px;height:44px;}
    .sw-btn{padding:15px 26px;}
  }
  .sw-root :where(a,button):focus-visible{outline:3px solid var(--sw-accent);outline-offset:3px;}
  @media (forced-colors:active){
    .sw-route::before{background:GrayText;}
    .sw-route::after{background:Highlight;}
  }
  @media (prefers-reduced-motion:reduce){
    .sw-root *,.sw-root *::before,.sw-root *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important;}
    .sw-hint svg{animation:none;}.sw-pt{display:none;}
  }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = existingStyle || document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  if (!existingStyle) document.head.appendChild(style);
}
