/** Settle near a scene in the user's direction without capturing native scrolling. */
export function mountLandingSnap() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer = 0;
  let frame = 0;
  let armed = false;
  let touching = false;
  let lastY = window.scrollY;
  let direction = 0;

  const cancel = () => {
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = frame = 0;
    armed = false;
  };

  const settle = () => {
    timer = 0;
    if (!armed || touching || !direction) return;
    armed = false;
    const from = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const radius = Math.min(window.innerHeight, 1080) * 0.35;
    const points = [...document.querySelectorAll<HTMLElement>("[data-landing-snap], .ua-engine, .ua-faq")]
      .map(element => Math.min(max, Math.max(0, from + element.getBoundingClientRect().top)))
      .filter(point => (point - from) * direction > 2 && Math.abs(point - from) <= radius)
      .sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
    const target = points[0];
    if (target === undefined) return;
    if (reducedMotion.matches) {
      window.scrollTo({ top: target, behavior: "instant" });
      return;
    }
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - start) / 320);
      const eased = 1 - (1 - progress) ** 3;
      window.scrollTo({ top: from + (target - from) * eased, behavior: "instant" });
      frame = progress < 1 ? requestAnimationFrame(animate) : 0;
    };
    frame = requestAnimationFrame(animate);
  };

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(settle, 160);
  };
  const begin = () => {
    cancel();
    lastY = window.scrollY;
    direction = 0;
    armed = true;
  };
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    begin();
    // A passive wheel listener can run after compositor scrolling has already moved the page.
    direction = Math.sign(event.deltaY);
    schedule();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable=false])")) return;
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", " "].includes(event.key)) begin();
    else cancel();
  };
  const onTouchStart = () => { begin(); touching = true; };
  const onTouchEnd = () => { touching = false; if (armed) schedule(); };
  const onScroll = () => {
    const y = window.scrollY;
    if (armed && Math.abs(y - lastY) > 0.5) {
      direction = Math.sign(y - lastY);
      schedule();
    }
    lastY = y;
  };
  const onMotionChange = () => cancel();
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("pointerdown", cancel, { passive: true });
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", cancel);
  reducedMotion.addEventListener("change", onMotionChange);
  return () => {
    cancel();
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("pointerdown", cancel);
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("touchcancel", onTouchEnd);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", cancel);
    reducedMotion.removeEventListener("change", onMotionChange);
  };
}
