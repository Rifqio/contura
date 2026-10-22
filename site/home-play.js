/* Contura site, index.html: phone full playback for the playground (Visual Query + Ask). Uses ConturaKit.getPlayground
   and ConturaPlay. playback.js is loaded here, so the page needs only this one script tag. */
(function () {
  'use strict';
  function start() {
    const K = window.ConturaKit, P = window.ConturaPlay;
    if (!K || !P || !K.getPlayground) return;
    const host = document.querySelector('#demo [data-playground]');
    const pg = host && K.getPlayground(host);
    if (!pg) return;
    const fig = host.closest('figure');
    const wait = (c, ms) => c.wait(ms);
    const bring = (el) => { if (!el) return; const r = el.getBoundingClientRect(); if (r.top >= 60 && r.bottom <= innerHeight - 40) return; el.scrollIntoView({ block: 'center', behavior: K.reduced() ? 'auto' : 'smooth' }); };
    P.attach(fig, [
      { caption: 'Drag customers from the tree onto the canvas. The window adds it as a card.', run: async () => { pg.reset(); bring(host); pg.addTable('customers'); }, ms: 1400 },
      { caption: 'Add invoices. The join appears from the Foreign Key, with no typing.', run: async () => { pg.addTable('invoices'); }, ms: 1600 },
      { caption: 'Tick two columns: the customer name and the invoice total. The SQL below follows.', run: async (c) => { pg.tick('customers.name'); await wait(c, 600); pg.tick('invoices.total'); }, ms: 1600 },
      { caption: 'Press Run. The rows come from a small sample copy of billing in this page.', run: async () => { await pg.run(); }, ms: 1800 },
      { caption: 'Now ask a question from the list: which invoices are still unpaid? The answer is pre-written, and it streams in.', run: async () => { bring(pg.root.querySelector('.ask')); await pg.ask('unpaid'); }, ms: 1200 },
      { caption: 'Sends shows what the next question would carry, with its size, before you press Send.', run: async () => { pg.sends(true); }, ms: 2800 },
    ], { reset: async () => { pg.sends(false); pg.newChat(); pg.reset(); } });
  }
  if (window.ConturaPlay) return start();
  const s = document.createElement('script');
  s.src = 'playback.js' + (document.currentScript && /\?v=[^&]*/.test(document.currentScript.src) ? document.currentScript.src.match(/\?v=[^&]*/)[0] : '');
  s.onload = start; document.head.appendChild(s);
})();
