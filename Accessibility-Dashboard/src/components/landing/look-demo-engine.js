/**
 * 랜딩 '페이지 위에서 자세히 보기' 데모 엔진.
 * 국세청 분석 결과를 1920×1080 으로 찍은 고정 스냅샷(public/landing/look-demo)만 쓴다.
 * 국세청 페이지나 서버에 다시 접속하지 않으므로 사이트·분석 결과가 바뀌어도 랜딩은 그대로다.
 * 스냅샷은 scratchpad 의 capture7.mjs 로 찍고 실제 앱과 35개 항목을 비교 검증했다.
 *
 * 마커·설명창은 bridge-runtime.js 동작을 따른다: 올리면 대표 문제부터 열리고, 벗어나면 180ms 뒤 닫히며,
 * 누르면 고정되고, 분석한 페이지 안 다른 곳을 누르거나 Esc 로 닫힌다. 마지막으로 본 문제를 기억한다.
 * 사이드바와 '분석 결과/최종 리포트' 탭은 호버만 보여 주고 누를 수 없다.
 * 재생: 화면에 보이는 동안 커서가 장면을 시연하고, 사용자가 누르거나 스크롤하면 멈추며,
 * 움직임이 IDLE 동안 없으면 그 장면부터 다시 재생한다. 모션 축소 설정에서는 장면의 마지막 모습만 보여 준다.
 */

const DUR = 7500;
const IDLE = 5000;
const GLYPH = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
// '화면에 표시되지 않은 문제' 카드 (앱 픽셀)
const OFFSCREEN_CARD = [1535.8, 619.1, 345.2, 444.9];

export function mountLookDemo(root, { snapshot, assetRoot }) {
  const { L, markers: MARKERS, side: SIDE, tabs: TABS, rail: RAIL } = snapshot;
  const asset = path => `${assetRoot}/${path}`;
  const part = name => root.querySelector(`[data-demo="${name}"]`);
  const ru = v => `calc(${v}*var(--u))`;
  const place = (el, x, y, w, h) => Object.assign(el.style, { left: ru(x), top: ru(y), ...(w != null && { width: ru(w) }), ...(h != null && { height: ru(h) }) });
  const pct = (v, t) => (v / t * 100) + "%";
  const app = part("app"), view = part("view"), content = part("content"), frame = part("frame"), pageScroll = part("page-scroll"), pageEl = part("page");
  const railEl = part("rail"), spot = part("spot"), ring = part("ring"), cursor = part("cursor"), tryHint = part("try"), tabsEl = part("tabs"), panel = part("panel");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const verify = window.__lookDemoVerify === true;   // 검증 스크립트용: 자동 재생 끔
  const cleanups = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  /* 배치 */
  content.style.height = ru(L.docH);
  place(frame, L.frame.x, L.frame.y, L.frame.w, L.frame.h);
  pageEl.style.aspectRatio = `${L.PW} / ${L.PH}`;
  place(part("sidebar"), 0, 0, L.sidebarW);
  place(railEl, L.rail.x, L.rail.y, L.rail.w);
  place(spot, ...OFFSCREEN_CARD);

  /* 호버 조각: 실제 앱에서 마우스를 올린 모습을 그 자리에 겹친다 */
  function hoverPiece(parent, r, clip, img, tag = "div") {
    const el = document.createElement(tag);
    el.className = "ua-demo-hot"; place(el, r[0], r[1], r[2], r[3]);
    const pic = document.createElement("img");
    pic.src = asset(`h/${img}.webp`); pic.alt = ""; pic.decoding = "async";
    place(pic, clip[0] - r[0], clip[1] - r[1], clip[2], clip[3]);
    el.appendChild(pic); parent.appendChild(el);
    return el;
  }
  SIDE.forEach(s => hoverPiece(part("side-hot"), s.r, s.clip, s.img));
  TABS.forEach(t => hoverPiece(part("tabs-hot"), t.r, t.clip, t.img));

  /* 마커·설명창 */
  const markerEls = new Map();
  let open = null, closeTimer = 0;
  for (const m of MARKERS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ua-demo-mk" + (m.kind === "approx" ? " is-approx" : "");
    b.style.setProperty("--c", m.color || "#0b6ff4");
    b.style.left = pct(m.x, L.PW); b.style.top = pct(m.y + m.h / 2, L.PH);
    b.dataset.id = m.id;
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", `${m.text} 분석 문제 ${m.count || 1}건`);
    const label = document.createElement("span"); label.textContent = m.text; b.appendChild(label);
    if (m.count) { const n = document.createElement("span"); n.className = "ua-demo-mk__n"; n.setAttribute("aria-hidden", "true"); n.textContent = m.count; b.appendChild(n); }
    b.addEventListener("pointerenter", () => { clearTimeout(closeTimer); if (!open || open.m !== m) openPop(m); });
    b.addEventListener("pointerleave", scheduleClose);
    b.addEventListener("focus", () => { if (!open || open.m !== m) openPop(m); });
    b.addEventListener("blur", scheduleClose);
    b.addEventListener("click", e => { e.stopPropagation(); if (!open || open.m !== m) openPop(m); open.pinned = true; });
    pageEl.appendChild(b); markerEls.set(m.id, b);
  }
  let hls = [];
  const clearHl = () => { hls.forEach(h => h.remove()); hls = []; };
  function drawHl(p) {
    clearHl();
    for (const [x, y, w, h, c] of p.hl) {
      const el = document.createElement("div"); el.className = "ua-demo-hl";
      Object.assign(el.style, { left: pct(x, L.PW), top: pct(y, L.PH), width: pct(w, L.PW), height: pct(h, L.PH), borderColor: c });
      pageEl.appendChild(el); hls.push(el);
    }
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    if (!open || open.pinned) return;
    closeTimer = setTimeout(() => {
      if (!open || open.pinned) return;
      const mk = markerEls.get(open.m.id);
      if (!open.el.matches(":hover") && !open.el.contains(document.activeElement) && !mk.matches(":hover") && document.activeElement !== mk) close();
    }, 180);
  }
  function close() {
    if (!open) return;
    markerEls.get(open.m.id).setAttribute("aria-expanded", "false");
    open.el.remove(); open = null; clearHl();
  }
  function openPop(m, i = m.sel ?? m.start) {
    close();
    const el = document.createElement("div");
    el.className = "ua-demo-pop"; el.setAttribute("role", "dialog");
    el.addEventListener("click", e => e.stopPropagation());
    el.addEventListener("pointerenter", () => clearTimeout(closeTimer));
    el.addEventListener("pointerdown", () => { if (open) open.pinned = true; clearTimeout(closeTimer); });
    el.addEventListener("pointerleave", scheduleClose);
    el.addEventListener("focusin", () => clearTimeout(closeTimer));
    el.addEventListener("focusout", scheduleClose);
    pageEl.appendChild(el);
    open = { m, i, el, pinned: false };
    markerEls.get(m.id).setAttribute("aria-expanded", "true");
    render();
  }
  function step(d) { if (!open) return; open.i = Math.max(0, Math.min(open.m.pages.length - 1, open.i + d)); open.m.sel = open.i; render(); }
  function render() {
    const { m, i, el } = open; const p = m.pages[i]; const n = m.pages.length;
    // 심각도·항목 코드는 글자로, 설명 본문은 실제 런타임이 만든 마크업(스냅샷)을 그대로 넣는다
    el.innerHTML = `<div class="ua-demo-pop__bar"><div class="ua-demo-pop__tags"><span class="ua-demo-pop__sev"></span><span class="ua-demo-pop__code"></span></div>` +
      (n > 1 ? `<div class="ua-demo-pop__pager" role="group" aria-label="같은 요소의 접근성 문제 이동"><button type="button" data-d="-1" aria-label="이전 문제" ${i === 0 ? "disabled" : ""}>${GLYPH("M15 6l-6 6 6 6")}</button><button type="button" data-d="1" aria-label="다음 문제" ${i === n - 1 ? "disabled" : ""}>${GLYPH("M9 6l6 6-6 6")}</button></div>` : "") +
      `</div><div class="ua-demo-pop__detail">${p.html}</div>`;
    const sev = el.querySelector(".ua-demo-pop__sev"); sev.textContent = p.sev; sev.style.background = p.sevColor;
    el.querySelector(".ua-demo-pop__code").textContent = p.code;
    const title = el.querySelector(".ap-live-popover__title")?.textContent.trim() || "";
    el.dataset.pos = n > 1 ? `총 ${n}개 중 ${i + 1}번째 문제: ${title}` : "";
    el.setAttribute("aria-label", n > 1 ? el.dataset.pos : title);
    el.querySelectorAll(".ua-demo-pop__pager button").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); step(Number(b.dataset.d)); }));
    const [x, y, w] = p.box;
    Object.assign(el.style, { left: pct(x, L.PW), top: pct(y, L.PH), width: pct(w, L.PW) });
    drawHl(p);
  }
  on(pageEl, "pointerdown", e => { if (open && !open.el.contains(e.target) && !e.target.closest(".ua-demo-mk")) close(); }, true);
  on(document, "keydown", e => { if (e.key === "Escape" && open && root.contains(document.activeElement)) { const b = markerEls.get(open.m.id); close(); b.focus({ preventScroll: true }); } });

  /* 오른쪽 분석 요약 패널: 실제 앱의 상태별 화면을 바꿔 끼운다 */
  const railImg = document.createElement("img"); railImg.className = "ua-demo-rail__state"; railImg.alt = ""; railEl.appendChild(railImg);
  let railState = "f0";
  function setRail(name) {
    const s = RAIL.states[name]; if (!s) return;
    railState = name;
    railImg.src = asset(`rail-${name}.webp`); railImg.style.height = ru(s.h);
    content.style.height = ru(Math.max(L.docH, L.rail.y + s.h + 16));
    railEl.querySelectorAll(".ua-demo-hot").forEach(h => h.remove());
    const add = (c, label, pressed, attr, fn) => {
      const r = c.r;
      const el = c.hov ? hoverPiece(railEl, r, c.hov.clip, c.hov.img, "button") : Object.assign(document.createElement("button"), { className: "ua-demo-hot" });
      if (!c.hov) { place(el, r[0], r[1], r[2], r[3]); railEl.appendChild(el); }
      el.type = "button"; el.setAttribute("aria-label", label); el.setAttribute(attr, String(pressed));
      el.addEventListener("click", e => { e.stopPropagation(); fn(); });
    };
    s.filters.forEach((f, i) => add(f, f.label + " 필터", f.on, "aria-pressed", () => setRail("f" + i)));
    s.groups.forEach(g => add(g, g.label + (g.open ? " 접기" : " 펼치기"), g.open, "aria-expanded", () => {
      if (g.open) return setRail("f" + s.filter);
      const next = Object.keys(RAIL.states).find(n => RAIL.states[n].filter === s.filter && RAIL.states[n].groups.some(y => y.open && y.label === g.label));
      if (next) setRail(next);
    }));
  }
  {
    // 점수 추이 그래프: 마우스 위치에 맞는 실제 툴팁 화면을 겹친다
    const T = RAIL.trend;
    const tip = document.createElement("img"); tip.className = "ua-demo-trend-tip"; tip.alt = "";
    place(tip, T.card[0], T.card[1], T.card[2]);
    const hit = document.createElement("div"); hit.className = "ua-demo-trend-hit"; hit.setAttribute("aria-hidden", "true");
    place(hit, T.svg[0], T.svg[1], T.svg[2], T.svg[3]);
    hit.addEventListener("pointermove", e => {
      const r = hit.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * T.svg[2];
      let point = null; for (const v of T.points) if (v.x <= x) point = v;
      if (point && point.img) { tip.src = asset(`${point.img}.webp`); tip.style.display = "block"; } else tip.style.display = "none";
    });
    hit.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    railEl.append(tip, hit);
  }
  const railHot = (kind, text) => [...railEl.querySelectorAll(`.ua-demo-hot[aria-${kind === "filter" ? "pressed" : "expanded"}]`)].find(b => b.getAttribute("aria-label").includes(text));

  /* 커서 연출 */
  const elPct = el => { const a = app.getBoundingClientRect(), r = el.getBoundingClientRect(); return [(r.left + Math.min(r.width / 2, 22) - a.left) / a.width * 100, (r.top + r.height / 2 - a.top) / a.height * 100]; };
  const moveTo = el => { if (!el) return; const [x, y] = elPct(el); cursor.style.left = x + "%"; cursor.style.top = y + "%"; };
  const tap = () => { cursor.classList.remove("is-click"); void cursor.offsetWidth; cursor.classList.add("is-click"); };
  const mk = id => markerEls.get(id);
  const byId = id => MARKERS.find(m => m.id === id);
  const pagerNext = () => open?.el.querySelector('.ua-demo-pop__pager button[data-d="1"]');
  function pressNext() { const b = pagerNext(); if (!b || b.disabled) return; b.classList.add("is-press"); later(() => step(1), 160); }
  // 어둡게 하는 연출은 데모 전용: 사용자가 화면 위에서 마우스를 움직이면 바로 걷고, 그 장면에서는 다시 켜지 않는다
  let staging = true;
  on(app, "pointermove", () => { staging = false; spot.classList.remove("is-on"); ring.classList.remove("is-on"); }, { passive: true });
  function ringOn(el) {
    if (!el) return;
    const a = content.getBoundingClientRect(), r = el.getBoundingClientRect(), k = 1920 / a.width;
    place(ring, (r.left - a.left) * k, (r.top - a.top) * k, r.width * k, r.height * k);
    ring.classList.add("is-on");
  }

  /* 장면 */
  const ITEMS = [
    { id: "locate",
      events: [[250, () => moveTo(mk("6516"))], [1350, () => { tap(); openPop(byId("6516")); open.pinned = true; }]] },
    { id: "cluster",
      events: [[250, () => moveTo(mk("6454"))], [1350, () => { tap(); openPop(byId("6454")); open.pinned = true; }],
        [2500, () => moveTo(pagerNext())], [3500, () => { tap(); pressNext(); }], [5000, () => { tap(); pressNext(); }]] },
    { id: "approx",
      events: [[250, () => moveTo(mk("6411"))], [1350, () => { tap(); openPop(byId("6411")); open.pinned = true; }]] },
    { id: "offscreen",
      events: [[200, () => { if (staging) spot.classList.add("is-on"); }], [700, () => moveTo(railHot("filter", "요소 경로 오류"))],
        [1700, () => { tap(); setRail("f2"); if (staging) ringOn(railHot("filter", "요소 경로 오류")); }],
        [3000, () => { ring.classList.remove("is-on"); spot.classList.remove("is-on"); moveTo(railHot("group", "3.1.5")); }],
        [4000, () => { tap(); setRail("f2-g1"); }]] }
  ];
  // 탭 버튼은 섹션 컴포넌트가 그린다 (id = ua-look-tab-<장면 id>)
  const tabs = ITEMS.map((it, k) => {
    const b = tabsEl.querySelector(`#ua-look-tab-${it.id}`);
    on(b, "click", e => { e.stopPropagation(); paused = reduced || verify; go(k); });
    on(b, "keydown", e => {
      const next = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: 0, End: ITEMS.length - 1 }[e.key];
      if (next === undefined) return; e.preventDefault();
      const t = (next + ITEMS.length) % ITEMS.length; go(t); tabs[t].focus();
    });
    return b;
  });

  let idx = 0, elapsed = 0, fired = 0, paused = reduced || verify, last = null, lastActive = 0, inView = false, started = false, raf = 0;
  function reset() {
    close(); clearHl(); clearTimeout(closeTimer); MARKERS.forEach(m => { delete m.sel; });
    spot.classList.remove("is-on"); ring.classList.remove("is-on"); staging = true;
    setRail("f0"); view.scrollTop = 0; pageScroll.scrollTop = 0;
    cursor.style.transition = "none"; cursor.style.left = "72%"; cursor.style.top = "88%"; void cursor.offsetWidth; cursor.style.transition = "";
  }
  function go(k) {
    idx = (k + ITEMS.length) % ITEMS.length; elapsed = 0; fired = 0;
    reset();
    tabs.forEach((t, j) => { t.setAttribute("aria-selected", String(j === idx)); t.tabIndex = j === idx ? 0 : -1; });
    panel.setAttribute("aria-labelledby", tabs[idx].id);
    if (paused) {
      // 멈춘 상태에서는 장면의 마지막 모습을 바로 보여 준다
      cursor.classList.remove("is-on");
      ITEMS[idx].events.forEach(([, fn]) => fn());
      fired = ITEMS[idx].events.length;
    } else cursor.classList.toggle("is-on", inView);
  }
  function tick(ts) {
    const dt = last == null ? 0 : Math.min(100, ts - last); last = ts;
    if (inView) {
      if (paused && !reduced && !verify && performance.now() - lastActive > IDLE) { paused = false; tryHint.classList.remove("is-gone"); go(idx); }
      if (!paused) {
        elapsed += dt;
        const ev = ITEMS[idx].events;
        while (fired < ev.length && ev[fired][0] <= elapsed) ev[fired++][1]();
        if (elapsed >= DUR) go(idx + 1);
      }
    }
    raf = requestAnimationFrame(tick);
  }
  const touch = () => { lastActive = performance.now(); };
  const takeOver = () => { touch(); tryHint.classList.add("is-gone"); if (!paused) { paused = true; cursor.classList.remove("is-on"); } };
  ["wheel", "pointerdown", "touchstart", "keydown"].forEach(t => on(app, t, takeOver, { passive: true }));
  ["pointermove", "focusin"].forEach(t => on(app, t, () => { if (paused) touch(); }, { passive: true }));

  // 화면에 보일 때만 재생한다
  const observer = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView && !started) { started = true; go(0); }
    if (inView && !paused) cursor.classList.add("is-on");
  }, { threshold: 0.35 });
  observer.observe(app);
  // 패널 상태 이미지를 미리 받아 둔다
  later(() => Object.keys(RAIL.states).forEach(n => { new Image().src = asset(`rail-${n}.webp`); }), 1500);

  go(0); raf = requestAnimationFrame(tick);
  // 검증 스크립트용 상태
  window.__lookDemo = { get paused() { return paused; }, get scene() { return ITEMS[idx].id; }, get railState() { return railState; },
    get open() { return open && { id: open.m.id, i: open.i, n: open.m.pages.length, pinned: open.pinned }; } };

  return () => {
    cancelAnimationFrame(raf); observer.disconnect(); clearTimeout(closeTimer);
    timers.forEach(clearTimeout); cleanups.forEach(fn => fn());
    delete window.__lookDemo;
  };
}
