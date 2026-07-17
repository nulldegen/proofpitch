/* ProofPitch dashboard — live state via WS, staking via Phantom or demo wallet. */
'use strict';

const $ = (sel, el) => (el || document).querySelector(sel);
const state = { data: null, wallet: null };

const SOL = 1e9;
const fmtSol = (l) => (l / SOL).toFixed(l % SOL === 0 ? 0 : 3);
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`;

// ── data ────────────────────────────────────────────────────────────────────

async function load() {
  const res = await fetch('/api/state');
  state.data = await res.json();
  render();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') { state.data = msg.data; render(); }
  };
  ws.onclose = () => setTimeout(connectWs, 3000);
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
  render();
}

async function sendUnsigned(url) {
  const provider = window.phantom?.solana ?? window.solana;
  const res = await fetch(url);
  const { tx, error } = await res.json();
  if (error) throw new Error(error);
  const raw = Uint8Array.from(atob(tx), (c) => c.charCodeAt(0));
  const transaction = solanaWeb3.Transaction.from(raw);
  const { signature } = await provider.signAndSendTransaction(transaction);
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
      msg('stake-msg', 'Waiting for Phantom signature…');
      const sig = await sendUnsigned(`/api/join-tx?market=${m.address}&side=${side}&lamports=${lamports}&payer=${state.wallet}`);
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
    <div class="sub">Fetching the TxLINE Merkle proof and submitting it to the escrow program.
    The program CPIs into <span class="mono">txoracle.validate_stat</span>; funds unlock only if the oracle answers TRUE.</div>
    <div id="settle-msg">Working…</div>
    <div class="row"><button class="ghost" onclick="closeModal()">Close</button></div>`);
  try {
    const res = await fetch('/api/settle', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: m.address }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    msg('settle-msg', `Settled ${j.receipt.side.toUpperCase()} — proven on-chain.
      <a target="_blank" rel="noopener" href="${explorer(j.receipt.settleTx)}">Settlement transaction</a>`, true);
    setTimeout(load, 2000);
  } catch (e) { msg('settle-msg', esc(e.message), false); }
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

function render() {
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
    const rows = f.markets.map((m) => marketRow(f, m, status)).join('');
    return `<article class="fixture">
      <div class="fx-head">
        <div class="fx-teams">${esc(f.p1)} <span class="score">${scoreText(f)}</span> ${esc(f.p2)}</div>
        <div class="fx-meta">
          <span>${new Date(f.startTime).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
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
  if (sc && sc.statusId && sc.statusId >= 2 && sc.statusId < 100) return { cls: 'live', text: 'LIVE' };
  if (f.startTime < now) return { cls: '', text: 'IN PLAY / RECENT' };
  return { cls: '', text: 'UPCOMING' };
}

function scoreText(f) {
  const sc = f.score;
  if (!sc || sc.statusId === 1 || sc.statusId == null && !sc.action) return 'vs';
  return 'LIVE';
}

function marketRow(f, m, status) {
  const open = m.state === 'open';
  const locked = open && m.lockTs * 1000 < Date.now();
  const settleReady = locked && f.score && f.score.etFinal;
  const actions = [];
  if (open && !locked) {
    actions.push(`<button class="small" onclick='ppStake(${JSON.stringify(m.address)}, 1)'>Stake YES</button>`);
    actions.push(`<button class="small no" onclick='ppStake(${JSON.stringify(m.address)}, 2)'>Stake NO</button>`);
  }
  if (settleReady) actions.push(`<button class="small" onclick='ppSettle(${JSON.stringify(m.address)})'>Settle with proof</button>`);
  if (m.receipt || m.state.startsWith('settled')) actions.push(`<button class="small ghost" onclick='ppReceipt(${JSON.stringify(m.address)})'>Receipt</button>`);
  const prob = m.impliedProb != null ? `${(m.impliedProb * 100).toFixed(1)}%` : '—';
  return `<tr>
    <td><div class="m-label">${esc(m.label)}</div><div class="m-explain">${esc(m.explain)}</div></td>
    <td class="prob">${prob}</td>
    <td class="pool"><span class="yes">YES ${fmtSol(m.yesPool)}</span> / <span class="no">NO ${fmtSol(m.noPool)}</span> SOL</td>
    <td class="state-${m.state}">${m.state.replace('_', ' ').toUpperCase()}${locked && open ? ' (LOCKED)' : ''}</td>
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

$('#wallet-btn').onclick = toggleWallet;
load();
connectWs();
