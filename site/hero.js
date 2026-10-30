/* Contura site, index.html: pointer lean for the hero pieces and the scroll-linked growth of the demo stage.
   The load choreography is CSS (hero.css). Both moves here write only transforms or custom properties read by
   transforms. Off under prefers-reduced-motion or ?reduce=1; without this script the page is placed and still. */
(function () {
  'use strict';
  const root = document.documentElement;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => rm.matches || root.classList.contains('hx-rm');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function lean() {
    const hero = document.querySelector('.hx'), frags = hero && hero.querySelector('[data-frags]');
    if (!frags) return;
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0, inView = true;
    function step() {
      x += (tx - x) * 0.08; y += (ty - y) * 0.08;
      frags.style.setProperty('--px', x.toFixed(3)); frags.style.setProperty('--py', y.toFixed(3));
      raf = Math.abs(tx - x) > 0.002 || Math.abs(ty - y) > 0.002 ? requestAnimationFrame(step) : 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
    hero.addEventListener('pointermove', (e) => {
      if (reduced() || !inView || !fine.matches || e.pointerType !== 'mouse') return;
      const r = hero.getBoundingClientRect();
      /* -1 to 1 across the hero; each piece multiplies by its --z (at most 12 px) */
      tx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      ty = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      kick();
    });
    hero.addEventListener('pointerleave', () => { tx = 0; ty = 0; kick(); });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { inView = es[0].isIntersecting; }).observe(hero);
  }

  function grow() {
    const stage = document.querySelector('[data-grow]'), inner = stage && stage.querySelector('.hx-stage-in');
    if (!inner) return;
    const S0 = 0.8;
    let ticking = false, last = -1;
    function update() {
      ticking = false;
      if (reduced() || innerWidth <= 860) {
        if (last !== 1) { inner.style.transform = ''; stage.style.removeProperty('--g'); last = 1; }
        return;
      }
      const vh = innerHeight, top = stage.getBoundingClientRect().top;
      /* 0 when the stage's top sits at the foot of the screen, 1 once it has climbed to about a fifth from the top */
      const p = clamp((vh - top) / (vh * 0.85), 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      if (Math.abs(e - last) < 0.0005) return;
      last = e;
      /* at full size the transform is dropped so the playground's drag maths sees an untransformed window */
      inner.style.transform = e >= 0.999 ? '' : 'scale(' + (S0 + (1 - S0) * e).toFixed(4) + ')';
      stage.style.setProperty('--g', e.toFixed(4));
    }
    const req = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
    addEventListener('scroll', req, { passive: true });
    addEventListener('resize', req);
    rm.addEventListener && rm.addEventListener('change', req);
    update();
  }

  function ready() { lean(); grow(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
