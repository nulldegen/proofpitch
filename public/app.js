/* ProofPitch dashboard — live state via WS, staking via Phantom or demo wallet.
 *
 * Rendering strategy: a full re-render only when the page STRUCTURE changes
 * (markets appear, states flip, wallet connects). Value-only ticks — odds,
 * pools, scores — update in place so CSS transitions can animate them, and
 * every change is diffed into the live event feed on the right.
 */
'use strict';

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const state = { data: null, wallet: null };

const SOL = 1e9;
const fmtSol = (l) => (l / SOL).toFixed(l % SOL === 0 ? 0 : 3);
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ── data ────────────────────────────────────────────────────────────────────

async function load() {
  const res = await fetch('/api/state');
  applyState(await res.json());
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    $('#feed-dot').classList.add('on');
    $('#feed-conn').textContent = 'connected';
    pushFeed([{ tag: 'FEED', cls: '', title: 'TxLINE relay connected', sub: 'odds and scores streaming' }]);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') applyState(msg.data);
  };
  ws.onclose = () => {
    $('#feed-dot').classList.remove('on');
    $('#feed-conn').textContent = 'reconnecting';
    setTimeout(connectWs, 3000);
  };
}

let lastStructSig = '';

function applyState(next) {
  const prev = state.data;
  state.data = next;
  const events = prev ? diffEvents(prev, next) : [];
  const sig = structSig(next);
  if (sig !== lastStructSig) {
    lastStructSig = sig;
    renderFull();
  } else {
    updateValues(next);
  }
  if (events.length) {
    pushFeed(events);
    eventFx(events);
  }
}

// Anything that changes WHICH elements exist (not just their numbers).
function structSig(d) {
  const now = Date.now();
  return d.network + d.programId + (state.wallet ?? '') + d.fixtures.map((f) =>
    `${f.fixtureId}:${fixtureStatus(f, now).text}:` + f.markets.map((m) =>
      m.address + m.state + (isLocked(m) ? 'L' : '') + (settleReady(f, m) ? 'S' : '') + (m.receipt ? 'R' : '')
    ).join(',')
  ).join(';');
}

function isLocked(m) { return m.state === 'open' && m.lockTs * 1000 < Date.now(); }
function settleReady(f, m) { return isLocked(m) && f.score && f.score.etFinal; }

// ── live diff → event feed ──────────────────────────────────────────────────

function diffEvents(prev, next) {
  const ev = [];
  const prevFx = new Map(prev.fixtures.map((f) => [f.fixtureId, f]));
  for (const f of next.fixtures) {
    const o = prevFx.get(f.fixtureId);
    if (!o) continue;

    const og = o.score?.goals, ng = f.score?.goals;
    if (og && ng && (ng.p1 > og.p1 || ng.p2 > og.p2)) {
      const scorer = ng.p1 > og.p1 ? f.p1 : f.p2;
      ev.push({ tag: 'GOAL', cls: 'goal', fx: f.fixtureId, goal: true, title: `${f.p1} ${ng.p1} – ${ng.p2} ${f.p2}`, sub: `${scorer} scores` });
    }

    const os = o.score?.statusId, ns = f.score?.statusId;
    if (ns != null && ns !== os) {
      const phase = { 2: 'Kick-off', 3: 'Half-time', 4: 'Second half under way', 5: 'Full time', 100: 'Result finalised' }[ns];
      if (phase) ev.push({ tag: 'MATCH', cls: '', fx: f.fixtureId, title: phase, sub: `${f.p1} vs ${f.p2}` });
    }

    const prevM = new Map(o.markets.map((m) => [m.address, m]));
    for (const m of f.markets) {
      const mo = prevM.get(m.address);
      if (!mo) continue;
      if (m.impliedProb != null && mo.impliedProb != null && Math.abs(m.impliedProb - mo.impliedProb) >= 0.01) {
        ev.push({ tag: 'ODDS', cls: 'odds', title: m.label, sub: `${(mo.impliedProb * 100).toFixed(1)}% → ${(m.impliedProb * 100).toFixed(1)}%` });
      }
      if (m.yesPool > mo.yesPool) ev.push({ tag: 'STAKE', cls: 'yes', title: m.label, sub: `+${fmtSol(m.yesPool - mo.yesPool)} SOL on YES` });
      if (m.noPool > mo.noPool) ev.push({ tag: 'STAKE', cls: 'no', title: m.label, sub: `+${fmtSol(m.noPool - mo.noPool)} SOL on NO` });
      if (m.state !== mo.state && m.state.startsWith('settled')) {
        ev.push({ tag: 'PROOF', cls: 'proof', title: m.label, sub: `Merkle proof verified — settled ${m.state === 'settled_yes' ? 'YES' : 'NO'}` });
      }
      if (m.state !== mo.state && m.state === 'void') ev.push({ tag: 'VOID', cls: '', title: m.label, sub: 'Voided — stakes refundable' });
    }
  }
  return ev;
}

function pushFeed(events) {
  const list = $('#feed-list');
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  for (const e of events) {
    list.append(el(`<div class="feed-item ${e.cls}">
      <span class="feed-tag">${e.tag}</span>
      <span class="feed-body"><span class="feed-title">${esc(e.title)}</span><span class="feed-sub">${esc(e.sub)}</span></span>
      <time>${t}</time></div>`));
  }
  while (list.children.length > 30) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// Visual side-effects on the cards themselves.
function eventFx(events) {
  for (const e of events) {
    if (!e.goal) continue;
    const head = $(`[data-fxhead="${e.fx}"]`);
    if (!head) continue;
    const card = head.closest('.fixture');
    if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
    const meta = $('.fx-meta', head);
    if (meta && !$('.goal-pop', meta)) {
      const pop = el('<span class="goal-pop">GOAL</span>');
      meta.prepend(pop);
      setTimeout(() => pop.remove(), 3300);
    }
    const score = $(`[data-score="${e.fx}"]`);
    if (score) { score.classList.remove('flip'); void score.offsetWidth; score.classList.add('flip'); }
  }
}

// ── in-place value updates (animate, don't rebuild) ─────────────────────────

function updateValues(d) {
  for (const f of d.fixtures) {
    const score = $(`[data-score="${f.fixtureId}"]`);
    if (score) {
      const txt = scoreText(f);
      if (score.textContent !== txt) score.textContent = txt;
    }
    for (const m of f.markets) {
      const num = $(`[data-prob="${m.address}"]`);
      if (num && m.impliedProb != null) {
        const from = parseFloat(num.dataset.v ?? '0');
        const to = m.impliedProb * 100;
        if (Math.abs(to - from) > 0.05) {
          num.dataset.v = to.toFixed(1);
          countUp(num, from, to);
          const bar = $(`[data-bar="${m.address}"]`);
          if (bar) bar.style.width = `${Math.min(100, to).toFixed(1)}%`;
        }
      }
      updateChip($(`[data-yes="${m.address}"]`), 'YES', m.yesPool);
      updateChip($(`[data-no="${m.address}"]`), 'NO', m.noPool);
    }
  }
}

function updateChip(chip, label, pool) {
  if (!chip) return;
  const txt = `${label} ${fmtSol(pool)}`;
  if (chip.textContent === txt) return;
  chip.textContent = txt;
  chip.classList.toggle('empty', !pool);
  chip.classList.remove('bump'); void chip.offsetWidth; chip.classList.add('bump');
}

function countUp(node, from, to) {
  const t0 = performance.now(), dur = 550;
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = `${(from + (to - from) * eased).toFixed(1)}%`;
    if (k < 1 && node.dataset.v === to.toFixed(1)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── wallet ──────────────────────────────────────────────────────────────────

async function toggleWallet() {
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider?.isPhantom) {
    window.open('https://phantom.app/', '_blank');
    return;
  }
  if (state.wallet) { state.wallet = null; renderWallet(); return; }
  const res = await provider.connect();
  state.wallet = res.publicKey.toString();
  renderWallet();
}

function renderWallet() {
  $('#wallet-btn').textContent = state.wallet
    ? `${state.wallet.slice(0, 4)}…${state.wallet.slice(-4)} — disconnect`
    : 'Connect Phantom';
  lastStructSig = '';
  if (state.data) applyState(state.data);
}

async function sendUnsigned(url, onStage) {
  const provider = window.phantom?.solana ?? window.solana;
  onStage?.('Building the transaction…');
  const res = await fetch(url);
  const { tx, error } = await res.json();
  if (error) throw new Error(error);
  const raw = Uint8Array.from(atob(tx), (c) => c.charCodeAt(0));
  const transaction = solanaWeb3.Transaction.from(raw);
  onStage?.('Waiting for the Phantom signature…');
  const { signature } = await provider.signAndSendTransaction(transaction);
  onStage?.('Submitted — confirming on devnet…');
  return signature;
}

// ── actions ─────────────────────────────────────────────────────────────────

function stakeModal(m, side) {
  openModal(`
    <h3>Stake ${side === 1 ? 'YES' : 'NO'} — ${esc(m.label)}</h3>
    <div class="sub">Predicate: <span class="mono">${esc(m.explain)}</span><br>
    Funds move into the market escrow PDA and unlock only on an on-chain Merkle proof of the outcome.</div>
    <label>Amount (devnet SOL)</label>
    <input id="stake-amount" type="number" min="0.001" step="0.01" value="0.05">
    <div id="stake-msg"></div>
    <div class="row">
      <button class="ghost" onclick="closeModal()">Cancel</button>
      ${state.wallet ? '' : `<button class="ghost" id="demo-stake">Demo wallet stake</button>`}
      <button id="do-stake">${state.wallet ? 'Sign with Phantom' : 'Connect Phantom first'}</button>
    </div>`);

  $('#do-stake').onclick = async () => {
    const lamports = Math.round(parseFloat($('#stake-amount').value) * SOL);
    if (!state.wallet) { await toggleWallet(); if (!state.wallet) return; }
    try {
      const sig = await sendUnsigned(
        `/api/join-tx?market=${m.address}&side=${side}&lamports=${lamports}&payer=${state.wallet}`,
        (s) => msg('stake-msg', s),
      );
      msg('stake-msg', `Staked. <a target="_blank" rel="noopener" href="${explorer(sig)}">View transaction</a>`, true);
      setTimeout(load, 2500);
    } catch (e) { msg('stake-msg', esc(e.message), false); }
  };
  const demo = $('#demo-stake');
  if (demo) demo.onclick = async () => {
    const lamports = Math.round(parseFloat($('#stake-amount').value) * SOL);
    try {
      msg('stake-msg', 'Demo wallet staking…');
      const res = await fetch('/api/demo/join', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: m.address, side, lamports }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      msg('stake-msg', `Staked by the demo wallet. <a target="_blank" rel="noopener" href="${explorer(j.sig)}">View transaction</a>`, true);
      setTimeout(load, 2500);
    } catch (e) { msg('stake-msg', esc(e.message), false); }
  };
}

async function settle(m) {
  openModal(`<h3>Settling — ${esc(m.label)}</h3>
    <div class="sub">Trustless settlement: the escrow program verifies the TxLINE Merkle proof on-chain
    and evaluates the predicate itself. No oracle multisig, no admin key.</div>
    <ol class="steps" id="settle-steps">
      <li>Fetching the Merkle proof from TxLINE <span class="mono">/scores/stat-validation</span></li>
      <li>Submitting the settle transaction to the escrow program</li>
      <li><span class="mono">txoracle.validate_stat</span> CPI — proof checked against the anchored root</li>
      <li>Outcome recorded — pool unlocked for winners</li>
    </ol>
    <div id="settle-msg"></div>
    <div class="row"><button class="ghost" onclick="closeModal()">Close</button></div>`);
  const steps = $$('#settle-steps li');
  const set = (i, cls) => { if (steps[i]) steps[i].className = cls; };
  set(0, 'active');
  const t1 = setTimeout(() => { set(0, 'done'); set(1, 'active'); }, 900);
  try {
    const res = await fetch('/api/settle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: m.address }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    clearTimeout(t1);
    set(0, 'done'); set(1, 'done'); set(2, 'active');
    await pause(600);
    set(2, 'done'); set(3, 'active');
    await pause(400);
    set(3, 'done');
    msg('settle-msg', `Settled ${j.receipt.side.toUpperCase()} — proven on-chain.
      <a target="_blank" rel="noopener" href="${explorer(j.receipt.settleTx)}">Settlement transaction</a>`, true);
    setTimeout(load, 1500);
  } catch (e) {
    clearTimeout(t1);
    const cur = steps.findIndex((s) => s.className === 'active');
    set(cur >= 0 ? cur : 0, 'fail');
    msg('settle-msg', esc(e.message), false);
  }
}

async function showReceipt(m) {
  const res = await fetch(`/api/receipt/${m.address}`);
  const r = await res.json();
  if (r.error) { openModal(`<h3>No receipt</h3><div class="sub">${esc(r.error)}</div>
    <div class="row"><button class="ghost" onclick="closeModal()">Close</button></div>`); return; }
  const stats = Object.entries(r.statValues).map(([k, v]) => `key ${k} = ${v}`).join(', ');
  openModal(`
    <h3>Settlement receipt — ${esc(m.label)}</h3>
    <div class="sub">This market was settled trustlessly: the escrow program verified the Merkle proof
    against the TxODDS root published on Solana and evaluated the predicate on-chain.</div>
    <dl class="receipt-grid">
      <dt>Outcome</dt><dd>${r.side.toUpperCase()} wins</dd>
      <dt>Proven predicate</dt><dd>${esc(r.provenPredicate)}</dd>
      <dt>Final stats</dt><dd>${esc(stats)}</dd>
      <dt>Proof batch ts</dt><dd>${new Date(r.proofTs).toISOString()}</dd>
      <dt>Settlement tx</dt><dd><a target="_blank" rel="noopener" href="${explorer(r.settleTx)}">${r.settleTx.slice(0, 32)}…</a></dd>
      <dt>Market account</dt><dd><a target="_blank" rel="noopener" href="${explorerAddr(m.address)}">${m.address.slice(0, 32)}…</a></dd>
    </dl>
    <label>Raw Merkle proof payload (as served by TxLINE /scores/stat-validation)</label>
    <div class="proof-json">${esc(JSON.stringify(r.validation, null, 1))}</div>
    <div class="row">
      <button class="ghost" onclick="closeModal()">Close</button>
      ${claimable(m) ? `<button id="do-claim">Claim winnings with Phantom</button>` : ''}
    </div>`);
  const btn = $('#do-claim');
  if (btn) btn.onclick = async () => {
    try {
      const side = r.side === 'yes' ? 1 : 2;
      const sig = await sendUnsigned(`/api/claim-tx?market=${m.address}&side=${side}&payer=${state.wallet}`);
      btn.replaceWith(el(`<span class="ok-line">Claimed — <a target="_blank" rel="noopener" href="${explorer(sig)}">tx</a></span>`));
    } catch (e) { btn.replaceWith(el(`<span class="err-line">${esc(e.message)}</span>`)); }
  };
}

function claimable(m) {
  return state.wallet && (m.state === 'settled_yes' || m.state === 'settled_no' || m.state === 'void');
}

// ── render ──────────────────────────────────────────────────────────────────

function renderFull() {
  const d = state.data;
  if (!d) return;
  $('#net').textContent = d.network.toUpperCase();
  const pl = $('#program-link');
  pl.textContent = `program ${d.programId.slice(0, 4)}…${d.programId.slice(-4)}`;
  pl.href = explorerAddr(d.programId);

  const now = Date.now();
  const fixtures = d.fixtures.filter((f) => f.markets.length || f.startTime > now - 86400000 * 2);
  const main = $('#fixtures');
  if (!fixtures.length) { main.innerHTML = '<div class="loading">No fixtures with markets yet — the engine opens them automatically as the schedule loads.</div>'; return; }

  main.innerHTML = fixtures.map((f) => {
    const status = fixtureStatus(f, now);
    const rows = f.markets.map((m) => marketRow(f, m)).join('');
    return `<article class="fixture">
      <div class="fx-head" data-fxhead="${f.fixtureId}">
        <div class="fx-teams">${esc(f.p1)} <span class="score" data-score="${f.fixtureId}">${scoreText(f)}</span> ${esc(f.p2)}</div>
        <div class="fx-meta">
          <span>${new Date(f.startTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span class="badge ${status.cls}">${status.text}</span>
        </div>
      </div>
      ${f.markets.length ? `<table class="markets">
        <tr><th>MARKET</th><th>IMPLIED (TxLINE)</th><th>POOLS</th><th>STATE</th><th></th></tr>
        ${rows}</table>` : ''}
    </article>`;
  }).join('');
}

function fixtureStatus(f, now) {
  const sc = f.score;
  if (sc && (sc.etFinal || sc.finished)) return { cls: 'final', text: 'FULL TIME' };
  if (sc && sc.statusId && sc.statusId >= 2 && sc.statusId < 100) {
    const phase = sc.statusId === 2 ? 'LIVE · 1H' : sc.statusId === 3 ? 'HALF-TIME' : sc.statusId === 4 ? 'LIVE · 2H' : 'LIVE';
    return { cls: 'live', text: phase };
  }
  if (f.startTime < now) return { cls: '', text: 'IN PLAY / RECENT' };
  return { cls: '', text: 'UPCOMING' };
}

function scoreText(f) {
  const g = f.score?.goals;
  return g ? `${g.p1} – ${g.p2}` : 'vs';
}

function marketRow(f, m) {
  const open = m.state === 'open';
  const locked = isLocked(m);
  const ready = settleReady(f, m);
  const actions = [];
  if (open && !locked) {
    actions.push(`<button class="small yes" onclick='ppStake(${JSON.stringify(m.address)}, 1)'>Stake YES</button>`);
    actions.push(`<button class="small no" onclick='ppStake(${JSON.stringify(m.address)}, 2)'>Stake NO</button>`);
  }
  if (ready) actions.push(`<button class="small" onclick='ppSettle(${JSON.stringify(m.address)})'>Settle with proof</button>`);
  if (m.receipt || m.state.startsWith('settled')) actions.push(`<button class="small ghost" onclick='ppReceipt(${JSON.stringify(m.address)})'>Receipt</button>`);
  const pct = m.impliedProb != null ? (m.impliedProb * 100).toFixed(1) : null;
  const probCell = pct != null
    ? `<div class="prob-wrap"><span class="prob-num" data-prob="${m.address}" data-v="${pct}">${pct}%</span>
       <div class="prob-bar"><i data-bar="${m.address}" style="width:${Math.min(100, +pct)}%"></i></div></div>`
    : `<div class="prob-wrap"><span class="prob-num na">—</span></div>`;
  const pillCls = locked && open ? 'locked' : m.state;
  const pillText = locked && open ? 'LOCKED' : m.state.replace('_', ' ').toUpperCase();
  return `<tr>
    <td><div class="m-label">${esc(m.label)}</div><div class="m-explain">${esc(m.explain)}</div></td>
    <td>${probCell}</td>
    <td><div class="pool">
      <span class="pool-chip yes${m.yesPool ? '' : ' empty'}" data-yes="${m.address}">YES ${fmtSol(m.yesPool)}</span>
      <span class="pool-chip no${m.noPool ? '' : ' empty'}" data-no="${m.address}">NO ${fmtSol(m.noPool)}</span>
    </div></td>
    <td><span class="pill ${pillCls}">${pillText}</span></td>
    <td><div class="actions">${actions.join('')}</div></td>
  </tr>`;
}

// global handlers for inline onclick
window.ppStake = (addr, side) => { const m = findMarket(addr); if (m) stakeModal(m, side); };
window.ppSettle = (addr) => { const m = findMarket(addr); if (m) settle(m); };
window.ppReceipt = (addr) => { const m = findMarket(addr); if (m) showReceipt(m); };

function findMarket(addr) {
  for (const f of state.data?.fixtures ?? []) {
    const m = f.markets.find((x) => x.address === addr);
    if (m) return m;
  }
  return null;
}

// ── modal + misc ────────────────────────────────────────────────────────────

function openModal(html) { $('#modal').innerHTML = html; $('#modal-back').hidden = false; }
window.closeModal = () => { $('#modal-back').hidden = true; };
$('#modal-back').addEventListener('click', (e) => { if (e.target.id === 'modal-back') closeModal(); });

function msg(id, html, ok) {
  const n = $('#' + id);
  n.className = ok === undefined ? '' : ok ? 'ok-line' : 'err-line';
  n.innerHTML = html;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function el(html) { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

// Structure also shifts with the clock (locks, settle windows) — re-check it.
setInterval(() => { if (state.data) applyState(state.data); }, 30000);

$('#wallet-btn').onclick = toggleWallet;
load();
connectWs();
