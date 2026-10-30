/* Contura site, index.html #boards, "Stuck on a diagram? Ask." (loaded by launch.js when the section comes near).
   The diagram tab's side panel docked beside a piece of billing.flow, as the app has them (flow/SidePanel.tsx,
   flow/ai/DiagramAssistant.tsx, ProposalCard.tsx, board/ReviewBar.tsx, proposal.ts landedSummary). When the part comes
   into view it plays once: a question and its streamed answer, then the refund request, its answer and the proposal,
   drawn on the board as the app draws waiting changes. Accept all lands the frame as one undo step, Undo takes it off,
   Reject all leaves the board as it was. Reduced motion (or html.hx-rm) shows the proposal at once, with no movement.
   The answers are pre-written; nothing is sent. Without this script the page shows the proposal, as written. */
(function () {
  'use strict';
  const doc = document, root = doc.documentElement;
  const fig = doc.querySelector('[data-ask-fig]');
  if (!fig || fig.dataset.on) return;
  fig.dataset.on = '1';
  const $ = (s, r) => (r || fig).querySelector(s);
  const side = $('[data-ask-side]'), slot = $('[data-ask-slot]'), cv = $('[data-ask-cv]'), count = $('[data-ask-count]');
  const live = $('[data-ask-live]'), replayB = $('[data-ask-replay]');
  if (!side || !slot || !cv) return;
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => RM.matches || root.classList.contains('hx-rm') || /[?&]reduce=1(&|$)/.test(location.search);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* the app's icons (components/Icon.tsx), drawn inline */
  const P = {
    plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6 6 18', arrowUp: 'M12 19V5M6 11l6-6 6 6', check: 'M20 6 9 17l-5-5',
    msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
    sidebar: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM9.5 4.5v15',
    history: 'M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 3.8v3.8h3.8M12 7.5V12l3 2',
  };
  const ic = (n, s) => '<svg class="la-i" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" aria-hidden="true" focusable="false"' + (s <= 14 ? ' style="stroke-width:1.75"' : '') + '><path d="' + P[n] + '"/></svg>';
  const kbd = (k) => '<span class="la-kbd" aria-hidden="true">' + k + '</span>';

  /* ---------------- the conversation, as pre-written for the page ---------------- */
  const FILE = 'billing.flow', FRAME = 'refund';
  const Q1 = 'Where does a card payment write?';
  const A1 = 'In checkout, Record payment inserts a row into `payments`, which points at `invoices` in billing tables. In card payment that is message 4, and message 5 marks the invoice paid. In invoice, pay moves it from open to paid.';
  const Q2 = 'Add a state diagram for a refund.';
  const A2 = 'Here is refund as a new state diagram, beside invoice. Nothing changes until you accept it.';
  /* the proposal: a new frame (add_frame) and its three lines (add_flow), as ProposalCard lists them (changeLine) */
  const CH = ['diagram state "refund"', 'Requested > Approved: review ok', 'Requested > Rejected: review failed', 'Approved > Refunded: refund sent'];
  /* the board's text from the invoice frame on, as the Editor tab shows it */
  const TEXT = ['diagram state "invoice"', '[*] > draft', 'draft > open: finalize', 'open > paid: pay', 'open > void: void', 'open > open: card declined', 'paid > [*]', 'void > [*]'];
  const FIRST = 52;

  const ORDER = ['idle', 'q1', 'a1', 'q2', 'a2', 'review', 'done'];
  let S;
  function fresh() {
    S = { phase: 'idle', end: '', a1: 0, a2: 0, off: new Set(), tab: 'assistant', band: false, undone: false, working: false, ring: false, enter: new Set() };
  }
  const past = (p) => ORDER.indexOf(S.phase) >= ORDER.indexOf(p);
  const accepted = () => [0, 1, 2, 3].filter((i) => !S.off.has(i));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  /* ProposalCard.acceptLabel and ReviewBar.reviewText */
  const acceptLabel = () => (accepted().length === CH.length ? 'Accept all' : 'Accept ' + accepted().length);
  const reviewText = () => plural(accepted().length, 'change', 'changes') + ' in ' + FRAME;
  /* proposal.ts landedSummary for one frame: the lines it added, or an empty diagram */
  function landedText() {
    const lines = accepted().filter((i) => i > 0).length;
    if (!lines) return 'Done. I added an empty diagram, as one undo step.';
    return 'Done. I added ' + plural(lines, 'line', 'lines') + ', as one undo step. The new parts are ringed on the canvas for a moment.';
  }
  /* an answer as AnswerText draws it: `code` once its closing backtick has come */
  function md(t) {
    const n = (t.match(/`/g) || []).length;
    if (n % 2) t = t.slice(0, t.lastIndexOf('`'));
    return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  let timers = [];
  const later = (f, ms) => { timers.push(setTimeout(f, ms)); };
  const halt = () => { timers.forEach(clearTimeout); timers = []; };
  const say = (t) => { if (!live) return; live.textContent = ''; setTimeout(() => { live.textContent = t; }, 40); };

  /* ---------------- the side panel ---------------- */
  side.innerHTML =
    '<div class="la-shead"><div class="la-switch right" role="tablist" aria-label="Side panel view"><span class="la-thumb" aria-hidden="true"></span>' +
    '<button type="button" class="la-tab" role="tab" id="la-tab-ed" aria-controls="la-pane-ed" data-tab="editor" data-f="tab-editor">' + ic('code', 16) + '<span>Editor</span></button>' +
    '<button type="button" class="la-tab" role="tab" id="la-tab-as" aria-controls="la-pane-as" data-tab="assistant" data-f="tab-assistant">' + ic('msg', 16) + '<span>Assistant</span><span data-badge></span></button></div>' +
    '<span class="la-ib" aria-hidden="true">' + ic('sidebar', 16) + '</span></div>' +
    '<div class="la-pane" id="la-pane-ed" role="tabpanel" aria-labelledby="la-tab-ed"><div class="la-code" role="region" tabindex="0" aria-label="' + FILE + ' text" data-code></div>' +
    '<div class="la-efoot">' + ic('check', 14) + '<span>No problems</span></div></div>' +
    '<div class="la-pane" id="la-pane-as" role="tabpanel" aria-labelledby="la-tab-as"><div class="la-ahead"><span class="la-sp"></span><span class="la-ib" aria-hidden="true">' + ic('plus', 16) + '</span><span class="la-ib" aria-hidden="true">' + ic('history', 16) + '</span></div>' +
    '<div class="la-chat" role="log" aria-live="off" aria-label="Assistant conversation" data-chat></div><div class="la-composer" data-composer></div></div>';
  const chat = $('[data-chat]'), composer = $('[data-composer]'), code = $('[data-code]'), badge = $('[data-badge]');
  const sw = $('.la-switch'), tabs = [...fig.querySelectorAll('[data-tab]')];

  function rowHTML(i, live) {
    const off = S.off.has(i);
    const acts = live
      ? '<span class="la-racts"><button type="button" class="la-ib2" aria-label="Accept this change" aria-pressed="' + !off + '" data-act="acc" data-i="' + i + '" data-f="acc' + i + '">' + ic('check', 14) + '</button>' +
        '<button type="button" class="la-ib2" aria-label="Reject this change" aria-pressed="' + off + '" data-act="rej" data-i="' + i + '" data-f="rej' + i + '">' + ic('close', 14) + '</button></span>'
      : '<span></span>';
    return '<div class="la-row' + (off && live ? ' off' : '') + '"><span class="la-mk" aria-hidden="true">+</span><span class="la-tx">' + esc(CH[i]) + '</span>' + acts + '</div>';
  }
  function cardHTML(live) {
    const head = FRAME + ', ' + plural(CH.length, 'change', 'changes');
    let h = '<div class="la-card' + (S.enter.has('card') ? ' la-in' : '') + '" role="region" aria-label="' + (live ? 'Changes to review' : 'Changes') + '">' +
      '<div class="la-card-head"><span class="la-card-title">' + plural(CH.length, 'change', 'changes') + '</span>' +
      (live ? '<button type="button" class="la-lnk" data-act="show" data-f="show">Show in the text</button>' : '') + '</div>' +
      '<div class="la-group" role="group" aria-label="' + head + '"><div class="la-group-head"><span class="la-group-title">' + head + '</span>' +
      (live ? '<span class="la-group-acts"><button type="button" class="la-lnk" data-act="rejframe" data-f="rejframe">Reject frame</button><button type="button" class="la-lnk" data-act="accframe" data-f="accframe">Accept frame</button></span>' : '') +
      '</div>' + CH.map((_, i) => rowHTML(i, live)).join('') + '</div>';
    if (live) {
      const none = accepted().length === 0;
      h += '<div class="la-card-foot"><span class="la-note">Lands as one undo step</span><span class="la-acts">' +
        '<button type="button" class="la-b" data-act="rejall" data-f="rejall">Reject all</button>' +
        '<button type="button" class="la-b pri" data-act="accall" data-f="accall" aria-keyshortcuts="Control+Enter"' + (none ? ' disabled' : '') + '>' + acceptLabel() + kbd('Ctrl+Enter') + '</button></span></div>';
    } else h += '<div class="la-outcome">Accepted 0 of ' + CH.length + '.</div>';
    return h + '</div>';
  }
  function landedHTML() {
    return '<div class="la-landed' + (S.enter.has('card') ? ' la-in' : '') + '"><p class="la-p">' + ic('check', 14) + '<span>' + landedText() + '</span></p>' +
      (S.undone ? '' : '<div class="la-landed-acts"><button type="button" class="la-b" data-act="undo" data-f="undo" aria-keyshortcuts="Control+Z">Undo' + kbd('Ctrl+Z') + '</button>' +
        '<button type="button" class="la-b" data-act="showl" data-f="showl">Show in the text</button></div>') + '</div>';
  }
  function chatHTML() {
    const ent = (k) => (S.enter.has(k) ? ' la-in' : '');
    let h = '';
    if (past('q1')) h += '<div class="la-umsg' + ent('q1') + '">' + esc(Q1) + '</div>';
    if (past('a1')) h += '<div class="la-amsg"><p class="la-p" data-stream="a1">' + md(A1.slice(0, S.a1)) + '</p></div>';
    if (past('q2')) h += '<div class="la-umsg' + ent('q2') + '">' + esc(Q2) + '</div>';
    if (past('a2')) {
      h += '<div class="la-amsg"><p class="la-p" data-stream="a2">' + md(A2.slice(0, S.a2)) + '</p>';
      if (S.phase === 'review') h += cardHTML(true);
      else if (S.end === 'landed') h += landedHTML();
      else if (S.end === 'rejected') h += cardHTML(false);
      h += '</div>';
    }
    return h;
  }
  function composerHTML() {
    if (S.working) return '<div class="la-working"><span>Working on ' + FILE + '. Stop it to type.</span><span class="la-b" aria-hidden="true">Stop' + kbd('Esc') + '</span></div>';
    return '<div class="la-crow" aria-hidden="true"><div class="la-seg"><span class="on">Review first</span><span>Auto-apply</span></div></div>' +
      '<div class="la-sends" aria-hidden="true"><b>Sends</b><span>7.9 KB</span><span class="la-sp"></span><span class="la-x">Show exactly</span></div>' +
      '<div class="la-cbox" aria-hidden="true"><div class="la-chips"><span class="la-chip">State invoice' + ic('close', 12) + '</span></div><div class="la-cin">Describe a change</div>' +
      '<div class="la-cbar"><span class="la-kbd">Shift+Enter</span><span>new line</span><span class="la-sp"></span><span class="la-pill">Sonnet 5.5</span><span class="la-send">' + ic('arrowUp', 14) + '</span></div></div>';
  }
  /* the Editor: the invoice frame's lines; the new lines marked while they wait, plain once landed, banded when shown */
  function lineHTML(n, t, cls, mark) {
    let c = esc(t);
    if (/^diagram /.test(t)) c = c.replace(/^diagram/, '<span class="k">diagram</span>').replace(/(&quot;[^&]*&quot;)/, '<span class="s">$1</span>');
    return '<div class="la-ln' + (cls ? ' ' + cls : '') + '"><span class="n">' + n + '</span><span class="m">' + (mark || '') + '</span><span class="c">' + c + '</span></div>';
  }
  function codeHTML() {
    let h = TEXT.map((t, i) => lineHTML(FIRST + i, t)).join('');
    const waiting = S.phase === 'review', landed = S.end === 'landed' && !S.undone;
    if (waiting || landed) {
      const keep = accepted();
      if (!keep.includes(0)) return h;
      let n = FIRST + TEXT.length;
      h += lineHTML(n++, '', waiting ? 'add' : '', waiting ? '+' : '');
      keep.forEach((i) => { h += lineHTML(n++, CH[i], (waiting ? 'add' : '') + (S.band ? ' band' : ''), waiting ? '+' : ''); });
    }
    return h;
  }

  /* ---------------- the refund frame on the board ---------------- */
  const NODES = { Requested: [20, 40], Approved: [220, 40], Refunded: [420, 40], Rejected: [220, 132] };
  const LINES = {
    1: { d: 'M130 58H220', at: [148, 50], t: 'review ok', ends: ['Requested', 'Approved'] },
    2: { d: 'M75 76V150H220', at: [90, 142], t: 'review failed', ends: ['Requested', 'Rejected'] },
    3: { d: 'M330 58H420', at: [338, 50], t: 'refund sent', ends: ['Approved', 'Refunded'] },
  };
  function frameHTML(waiting) {
    const keep = accepted();
    const used = new Set(keep.filter((i) => i > 0).flatMap((i) => LINES[i].ends));
    let g = '<defs><marker id="la-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" class="bd-ahp la-ahn"/></marker></defs>';
    [1, 2, 3].forEach((i) => {
      const L = LINES[i];
      g += '<g class="ba"' + (keep.includes(i) ? '' : ' data-gone') + '><path class="bl" d="' + L.d + '" marker-end="url(#la-ah)"/><text class="bx" x="' + L.at[0] + '" y="' + L.at[1] + '">' + L.t + '</text></g>';
    });
    Object.keys(NODES).forEach((k) => {
      const [x, y] = NODES[k];
      g += '<g class="bn b-state"' + (used.has(k) ? '' : ' data-gone') + '><rect x="' + x + '" y="' + y + '" width="110" height="36" rx="18"/><text x="' + (x + 55) + '" y="' + (y + 22.5) + '">' + k + '</text></g>';
    });
    const desc = 'A refund\'s lifecycle. Requested goes to Approved on review ok and to Rejected on review failed; Approved goes to Refunded on refund sent.';
    return '<figure class="bf la-bf' + (S.ring ? ' la-airing' : '') + '" style="--vw:550; --vh:180"><figcaption class="bf-t" id="la-rf-t"><b>State</b> refund' + (waiting ? '<span class="la-newtag">New</span>' : '') + '</figcaption>' +
      '<svg class="bd-svg" viewBox="0 10 550 180" role="img" aria-labelledby="la-rf-t la-rf-d"><desc id="la-rf-d">' + (waiting ? 'Proposed, not on the board yet. ' : '') + desc + '</desc>' + g + '</svg></figure>';
  }
  function slotHTML() {
    if (S.phase === 'review') {
      return '<div class="la-new is-new' + (S.enter.has('card') ? ' la-in' : '') + '"><div class="la-rbar" role="toolbar" aria-label="Assistant changes" data-rbar><span class="la-rtext">' + reviewText() + '</span>' +
        '<button type="button" class="la-b" data-act="rejall" data-f="rrej" tabindex="0" aria-keyshortcuts="Control+Backspace">Reject</button>' +
        '<button type="button" class="la-b pri" data-act="accall" data-f="racc" tabindex="-1" aria-keyshortcuts="Control+Enter"' + (accepted().length ? '' : ' disabled') + '>' + acceptLabel() + kbd('Ctrl+Enter') + '</button></div>' + frameHTML(true) + '</div>';
    }
    if (S.end === 'landed' && !S.undone) return '<div class="la-new">' + frameHTML(false) + '</div>';
    return '';
  }

  /* ---------------- paint: what the state says, keeping focus and the chat's place ---------------- */
  let follow = true;
  chat.addEventListener('scroll', () => { follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 12; }, { passive: true });
  const toEnd = () => { if (follow) chat.scrollTop = chat.scrollHeight; };
  function paint(focusKey) {
    const a = doc.activeElement;
    const keep = focusKey || (a && fig.contains(a) && a.dataset ? a.dataset.f : null);
    sw.classList.toggle('right', S.tab === 'assistant');
    tabs.forEach((t) => { const on = t.dataset.tab === S.tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    $('#la-pane-ed').hidden = S.tab !== 'editor';
    $('#la-pane-as').hidden = S.tab !== 'assistant';
    badge.innerHTML = (S.phase === 'review' ? '<span class="la-pcount">' + CH.length + '<span class="sr"> changes waiting</span></span>' : '') +
      (S.working ? '<span class="la-pdot"><span class="sr">Working</span></span>' : '');
    chat.innerHTML = chatHTML();
    composer.innerHTML = composerHTML();
    code.innerHTML = codeHTML();
    const going = slot.firstElementChild;
    const next = slotHTML();
    if (going && going.classList.contains('is-new') && S.end === 'landed' && !S.undone) {
      /* the waiting frame lands where it is drawn: its marks clear and it is ringed for a moment */
      going.classList.remove('is-new', 'la-in');
      ['[data-rbar]', '.la-newtag'].forEach((q) => { const x = going.querySelector(q); if (x) x.remove(); });
      const d = going.querySelector('desc'); if (d) d.textContent = d.textContent.replace('Proposed, not on the board yet. ', '');
      const f = going.querySelector('.la-bf'); if (f && S.ring) f.classList.add('la-airing');
    } else if (going && !next && !still()) {
      going.classList.add('la-out');
      later(() => { if (!slotHTML()) slot.innerHTML = ''; }, 320);
    } else slot.innerHTML = next;
    cv.classList.toggle('is-working', S.working);
    if (count) count.textContent = 'Board · ' + (S.end === 'landed' && !S.undone ? 7 : 6) + ' frames';
    S.enter.clear();
    toEnd();
    requestAnimationFrame(toEnd);
    if (keep) {
      const el = fig.querySelector('[data-f="' + keep + '"]');
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }
  /* the streamed answer grows in place: only its paragraph is drawn again */
  function grow(key, text) {
    const p = chat.querySelector('[data-stream="' + key + '"]');
    if (p) p.innerHTML = md(text.slice(0, S[key]));
    toEnd();
  }
  function stream(key, text, done) {
    const words = text.match(/\S+\s*/g) || [];
    let i = 0;
    const step = () => {
      i = Math.min(words.length, i + 2);
      S[key] = words.slice(0, i).join('').length;
      grow(key, text);
      if (i < words.length) later(step, 70); else done();
    };
    later(step, 450);
  }
  const plain = (t) => t.replace(/`/g, '');
  const PROPOSED = 'The assistant proposes ' + CH.length + ' changes in ' + FRAME + ', a new frame drawn on the board. Nothing changes until you accept. Accept all or Reject all.';

  /* ---------------- play, once in view; Replay plays again ---------------- */
  function endState() {
    S.phase = 'review'; S.a1 = A1.length; S.a2 = A2.length; S.working = false;
  }
  function play() {
    halt(); fresh(); follow = true;
    if (still()) { endState(); paint(); say(PROPOSED); return; }
    paint();
    later(() => {
      S.phase = 'q1'; S.working = true; S.enter.add('q1'); paint();
      later(() => {
        S.phase = 'a1'; paint();
        stream('a1', A1, () => {
          S.working = false; paint(); say('Answer: ' + plain(A1));
          later(() => {
            S.phase = 'q2'; S.working = true; S.enter.add('q2'); paint();
            later(() => {
              S.phase = 'a2'; paint();
              stream('a2', A2, () => {
                later(() => { S.phase = 'review'; S.working = false; S.enter.add('card'); paint(); say(PROPOSED); }, 350);
              });
            }, 500);
          }, 1400);
        });
      }, 500);
    }, 250);
  }

  /* ---------------- what the buttons do (useBoardAsk: accept, reject, acceptAll, rejectAll; FlowTab: onUndo) ---------------- */
  function acceptAll() {
    if (S.phase !== 'review' || !accepted().length) return;
    halt();
    S.phase = 'done'; S.end = 'landed'; S.undone = false; S.band = false; S.ring = true; S.enter.add('card');
    paint('undo');
    say(landedText());
    later(() => { S.ring = false; const f = slot.querySelector('.la-airing'); if (f) f.classList.remove('la-airing'); }, 2600);
  }
  function rejectAll() {
    if (S.phase !== 'review') return;
    halt();
    S.phase = 'done'; S.end = 'rejected'; S.band = false;
    paint();
    (replayB || tabs.find((x) => x.dataset.tab === S.tab) || fig).focus({ preventScroll: true });
    say('Rejected. Nothing changed on the board.');
  }
  function undo() {
    if (S.end !== 'landed' || S.undone) return;
    S.undone = true; S.ring = false; S.band = false;
    paint();
    (replayB || tabs.find((x) => x.dataset.tab === S.tab) || fig).focus({ preventScroll: true });
    say('Undone. ' + FRAME + ' is off the board, as it was.');
  }
  function toggle(i, off) {
    if (off) { S.off.add(i); if (i === 0) [1, 2, 3].forEach((k) => S.off.add(k)); }
    else { S.off.delete(i); if (i > 0) S.off.delete(0); }
    paint();
    say(reviewText() + '.');
  }
  function show() {
    S.tab = 'editor'; S.band = true;
    paint('tab-editor');
    const b = code.querySelector('.band');
    if (b) code.scrollTop = Math.max(0, b.offsetTop - code.clientHeight / 2);
    say('Editor. The ' + FRAME + ' lines are marked.');
  }

  fig.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { S.tab = t.dataset.tab; if (S.tab === 'assistant') S.band = false; paint(t.dataset.f); return; }
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act, i = Number(b.dataset.i);
    if (act === 'accall') acceptAll();
    else if (act === 'rejall') rejectAll();
    else if (act === 'accframe') { S.off.clear(); paint(); say(reviewText() + '.'); }
    else if (act === 'rejframe') { [0, 1, 2, 3].forEach((k) => S.off.add(k)); paint(); say(reviewText() + '.'); }
    else if (act === 'acc') toggle(i, false);
    else if (act === 'rej') toggle(i, true);
    else if (act === 'undo') undo();
    else if (act === 'show' || act === 'showl') show();
  });
  fig.addEventListener('keydown', (e) => {
    const t = e.target.closest && e.target.closest('[data-tab]');
    if (t && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      S.tab = S.tab === 'editor' ? 'assistant' : 'editor';
      paint('tab-' + S.tab);
      return;
    }
    /* the review bar is one tab stop; the arrows move along it (ReviewBar.tsx) */
    const bar = e.target.closest && e.target.closest('[data-rbar]');
    if (bar && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const bs = [...bar.querySelectorAll('button')], at = bs.indexOf(e.target);
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (at + 1) % 2;
      bs.forEach((x, k) => { x.tabIndex = k === to ? 0 : -1; });
      bs[to].focus();
      return;
    }
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (!mod) return;
    if (e.key === 'Enter' && S.phase === 'review') { e.preventDefault(); acceptAll(); }
    else if (e.key === 'Backspace' && S.phase === 'review') { e.preventDefault(); rejectAll(); }
    else if ((e.key === 'z' || e.key === 'Z') && S.end === 'landed' && !S.undone) { e.preventDefault(); undo(); }
  });
  if (replayB) replayB.addEventListener('click', () => { play(); });

  /* start: the proposal at once with reduced motion; otherwise an empty chat that plays once the part is in view */
  fresh();
  if (still() || !('IntersectionObserver' in window)) { endState(); paint(); }
  else {
    paint();
    const io = new IntersectionObserver((es) => {
      if (!es.some((x) => x.isIntersecting)) return;
      io.disconnect();
      play();
    }, { threshold: 0.2 });
    io.observe($('[data-ask]'));
  }
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(toEnd);
  window.ConturaBoardAsk = { state: () => S, play, acceptAll, rejectAll, undo };
})();
