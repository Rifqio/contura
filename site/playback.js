/* Contura site: scripted playback for live demos (shared by every page).

   ConturaPlay.attach(figure, steps, opts) -> controller
     figure  the demo's <figure> (the bar goes inside it, just above its <figcaption>)
     steps   [{ caption: 'Step text, a full sentence.', run: async (ctx) => {...}, ms?: dwell after the action }]
             run() performs the real interaction through the demo's own code paths. ctx = { reduce, wait(ms), signal }.
             Await ctx.wait(ms) for any pause inside a step: it throws when playback stops, and it holds while paused.
             Under reduced motion ctx.reduce is true and ctx.wait resolves at once, so a step should jump to its end state.
     opts    { reset: async () => {} (called before the first step and on Replay),
               done: 'Caption when the run ends.', label: 'Watch it play' }
   controller = { play(), pause(), replay(), stop(reason), get state() }

   Behaviour (2026-10-22: no play, pause or replay buttons): on every screen the run starts when the figure is about
   60% in view, pauses when it leaves and goes on when it comes back; a run that ended starts again from the top when
   the figure comes back into view. It stops for good the moment the person taps or types inside the demo ("You have
   the controls."). The bar shows only the step caption and the progress line. Under prefers-reduced-motion, or with
   ?reduce=1 in the URL, nothing auto-advances: each step jumps to its end state and a Next button moves on.
   ?play=0 turns autoplay off (the caption shows the first step and nothing runs).

   Once defined it fires document event 'contura:play-ready'. */
(function () {
  'use strict';
  if (window.ConturaPlay) return;
  const doc = document;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const q = new URLSearchParams(location.search);
  const reduce = () => rm.matches || q.get('reduce') === '1';
  const auto = () => q.get('play') !== '0';
  const STOP = { stop: true };
  const I = {
    next: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5"/></svg>',
  };
  let uid = 0;

  function attach(figure, steps, opts) {
    opts = opts || {};
    const id = 'pb' + (++uid);
    const bar = doc.createElement('div');
    bar.className = 'pb';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Playback of this demo');
    bar.innerHTML =
      '<div class="pb-full">' +
      '<div class="pb-btns" hidden>' +
      '<button type="button" class="pb-b" data-pb="next" aria-label="Next step">' + I.next + '</button>' +
      '</div>' +
      '<div class="pb-text"><p class="pb-cap" id="' + id + '-cap" aria-live="polite"></p>' +
      '<ol class="pb-prog" aria-hidden="true">' + steps.map(() => '<li></li>').join('') + '</ol></div>' +
      '</div>';
    const cap = figure.querySelector(':scope > figcaption');
    figure.insertBefore(bar, cap || null);
    figure.classList.add('has-pb');
    const $ = (s) => bar.querySelector(s);
    const btns = $('.pb-btns'), nextB = $('[data-pb="next"]'), capEl = $('.pb-cap'), prog = [...bar.querySelectorAll('.pb-prog li')];

    /* state: idle (not started), playing, paused, waiting (reduced motion, waiting for Next), done, stopped (taken over) */
    let state = 'idle', idx = 0, run = 0, userPaused = false, inView = false, gate = null, nextGate = null;
    const setCap = (t) => { capEl.textContent = t; };
    const stepCap = (i) => 'Step ' + (i + 1) + ' of ' + steps.length + ': ' + steps[i].caption;
    function paintProg() { prog.forEach((li, i) => { li.className = i < idx ? 'on' : i === idx && state !== 'done' && state !== 'idle' ? 'cur' : state === 'done' ? 'on' : ''; }); }
    function paint() {
      btns.hidden = !(reduce() && state === 'waiting');
      bar.dataset.state = state;
      paintProg();
    }
    function showFull() { bar.classList.add('open'); }

    const ctx = (my) => ({
      reduce: reduce(),
      signal: my,
      wait: (ms) => new Promise((res, rej) => {
        if (my !== run) return rej(STOP);
        if (reduce()) return res();
        let left = ms, t0 = performance.now(), tm = null;
        const tick = () => {
          if (my !== run) return rej(STOP);
          if (state === 'paused') { left -= performance.now() - t0; return (gate = gate || defer()).p.then(() => { t0 = performance.now(); tm = setTimeout(tick, Math.max(0, left)); }); }
          if (performance.now() - t0 >= left) return res();
          tm = setTimeout(tick, Math.min(120, left - (performance.now() - t0)));
        };
        tm = setTimeout(tick, Math.min(120, ms));
      }),
    });
    function defer() { let r; const p = new Promise((x) => { r = x; }); return { p, r }; }

    async function loop(my) {
      const c = ctx(my);
      try {
        while (idx < steps.length) {
          if (my !== run) return;
          const s = steps[idx];
          setCap(stepCap(idx)); paint();
          await c.wait(reduce() ? 0 : 650);
          await s.run(c);
          if (my !== run) return;
          if (reduce()) {
            state = 'waiting'; paint();
            nextGate = defer(); await nextGate.p; nextGate = null;
            if (my !== run) return;
            state = 'playing';
          } else await c.wait(s.ms != null ? s.ms : 1900);
          idx++;
        }
        state = 'done'; idx = steps.length; paint();
        setCap(opts.done || 'That is the whole run. You have the controls.');
      } catch (e) {
        if (e !== STOP) { console.error(e); state = 'stopped'; paint(); setCap('Playback stopped. You have the controls.'); }
      }
    }
    async function start(fromReset) {
      const my = ++run;
      showFull();
      if (gate) { gate.r(); gate = null; }
      if (fromReset || state === 'done' || state === 'stopped' || state === 'idle') {
        idx = 0;
        state = 'playing'; paint();
        if (opts.reset) { try { await opts.reset(); } catch (e) { console.error(e); } }
        if (my !== run) return;
      } else { state = 'playing'; paint(); }
      loop(my);
    }
    function play() {
      if (state === 'paused') { state = 'playing'; userPaused = false; paint(); if (gate) { gate.r(); gate = null; } return; }
      if (state === 'playing' || state === 'waiting') return;
      userPaused = false; start(false);
    }
    function pause(byUser) { if (state !== 'playing') return; state = 'paused'; if (byUser) userPaused = true; paint(); }
    function replay() { userPaused = false; if (nextGate) nextGate.r(); start(true); }
    function stop(reason) {
      if (state === 'idle' || state === 'done' || state === 'stopped') return;
      run++;
      if (gate) { gate.r(); gate = null; } if (nextGate) { nextGate.r(); nextGate = null; }
      state = 'stopped'; paint();
      setCap(reason || 'You have the controls.');
    }

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pb]'); if (!b) return;
      const k = b.dataset.pb;
      if (k === 'next') { if (nextGate) nextGate.r(); }
    });
    /* take-over: a real tap, click or key inside the demo (not on the bar) ends the run for good */
    const take = (e) => {
      if (!e.isTrusted || bar.contains(e.target)) return;
      if (state === 'playing' || state === 'paused' || state === 'waiting') stop('You have the controls.');
    };
    ['pointerdown', 'keydown'].forEach((t) => figure.addEventListener(t, take, true));

    /* view: start at about 60% in view (of the figure or the viewport, whichever is smaller), pause when it leaves */
    if (auto()) {
      showFull(); setCap(stepCap(0)); paint();
      if ('IntersectionObserver' in window) {
        const th = []; for (let i = 0; i <= 20; i++) th.push(i / 20);
        const io = new IntersectionObserver((es) => es.forEach((en) => {
          const need = Math.min(en.boundingClientRect.height, innerHeight);
          const ratio = need > 0 ? en.intersectionRect.height / need : 0;
          if (ratio >= 0.6 && !inView) {
            inView = true;
            if (state === 'idle' || state === 'done') start(true);
            else if (state === 'paused' && !userPaused) play();
          } else if (ratio < 0.25 && inView) { inView = false; pause(false); }
        }), { threshold: th });
        io.observe(figure);
      }
    } else { showFull(); setCap(stepCap(0)); paint(); }

    return { play, pause: () => pause(true), replay, stop, get state() { return state; }, get step() { return idx; }, bar };
  }

  window.ConturaPlay = { attach, auto, reduce };
  doc.dispatchEvent(new CustomEvent('contura:play-ready'));
})();
