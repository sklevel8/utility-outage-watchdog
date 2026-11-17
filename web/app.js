/* Outage Watchdog — zone lookup, schedule and a working command parser demo. */
(() => {
  'use strict';

  const ZONES = [
    { id: 'johannesburg', name: 'Johannesburg — Zone 4', stage: 2, slot: 'today 18:00–20:30', subscribers: 38 },
    { id: 'sandton', name: 'Sandton — Zone 2', stage: 2, slot: 'today 14:00–16:30', subscribers: 26 },
    { id: 'pretoria-east', name: 'Pretoria East — Zone 7', stage: 1, slot: 'tomorrow 06:00–08:30', subscribers: 21 },
    { id: 'cape-town-cbd', name: 'Cape Town CBD — Zone 1', stage: 1, slot: 'tomorrow 10:00–12:30', subscribers: 30 },
    { id: 'durban-north', name: 'Durban North — Zone 3', stage: 2, slot: 'today 20:00–22:30', subscribers: 17 },
    { id: 'gqeberha', name: 'Gqeberha — Zone 5', stage: 0, slot: 'no outages scheduled', subscribers: 10 },
  ];

  const $ = (s) => document.querySelector(s);
  const el = {
    zoneForm: $('#zoneForm'),
    zoneInput: $('#zoneInput'),
    zoneResult: $('#zoneResult'),
    countdown: $('#countdown'),
    schedule: $('#scheduleBody'),
    chat: $('#chat'),
    chatForm: $('#chatForm'),
    chatInput: $('#chatInput'),
    chips: $('#chips'),
    zoneGrid: $('#zoneGrid'),
    toast: $('#toast'),
  };

  let selected = ZONES[0];
  let subscription = null;
  let secondsLeft = 2 * 3600 + 41 * 60 + 18;

  /* --------------------------------------------------------------- helpers */
  function clock() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.toast.classList.remove('is-visible'), 2100);
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function findZone(id) { return ZONES.find((z) => z.id === id.toLowerCase()); }

  function stageBadge(stage) {
    if (stage === 0) return '<span class="badge badge--ok">clear</span>';
    if (stage === 1) return '<span class="badge badge--warn">Stage 1</span>';
    return '<span class="badge badge--bad">Stage 2</span>';
  }

  /* ---------------------------------------------------------------- status */
  function renderZone(zone) {
    selected = zone;
    el.zoneResult.innerHTML = `
      <div class="zone-result__head">
        <strong>${escapeHtml(zone.name)}</strong>
        ${stageBadge(zone.stage)}
      </div>
      <p class="tiny dim">Next slot · ${escapeHtml(zone.slot)}</p>
      <div class="countdown" id="countdown">${formatCountdown()}</div>
      <p class="tiny dim">${zone.stage ? 'until the next scheduled outage' : 'no outage currently scheduled'}</p>`;
    el.countdown = $('#countdown');
    renderSchedule();
  }

  function formatCountdown() {
    if (!selected.stage) return '—';
    const h = String(Math.floor(secondsLeft / 3600)).padStart(2, '0');
    const m = String(Math.floor((secondsLeft % 3600) / 60)).padStart(2, '0');
    const s = String(secondsLeft % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  setInterval(() => {
    if (!selected.stage) return;
    secondsLeft = secondsLeft > 0 ? secondsLeft - 1 : 2 * 3600 + 41 * 60 + 18;
    if (el.countdown) el.countdown.textContent = formatCountdown();
  }, 1000);

  /* -------------------------------------------------------------- schedule */
  function renderSchedule() {
    const days = ['Today', 'Tomorrow', 'Thu', 'Fri', 'Sat'];
    const windows = ['06:00–08:30', '10:00–12:30', '14:00–16:30', '18:00–20:30', '20:00–22:30'];
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      const stage = i === 0 ? selected.stage : Math.max(0, selected.stage - 1);
      const active = i === 0 && selected.stage > 0;
      rows.push(`<tr>
        <td>${days[i]}</td>
        <td class="mono">${windows[(i + 2) % windows.length]}</td>
        <td class="dim">2h 30m</td>
        <td>${stageBadge(stage)}</td>
        <td>${active ? '<span class="badge badge--accent">next</span>' : '<span class="dim small">scheduled</span>'}</td>
      </tr>`);
    }
    el.schedule.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ chat */
  function addMessage(kind, html, bad = false) {
    const wrap = document.createElement('div');
    wrap.className = `msg msg--${kind}`;
    wrap.innerHTML = `<div class="msg__bubble ${bad ? 'msg__bubble--bad' : ''}">${html}</div><span class="msg__time">${clock()}</span>`;
    el.chat.appendChild(wrap);
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  function helpText() {
    return `Available commands:
<span class="cmd">/subscribe &lt;zone&gt;</span> — follow a zone
<span class="cmd">/status</span> — your current subscription
<span class="cmd">/stop</span> — stop all messages
<span class="cmd">/help</span> — this message

Zones: ${ZONES.map((z) => z.id).join(', ')}`;
  }

  function handleCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    addMessage('user', escapeHtml(text));

    if (!text.startsWith('/')) {
      addMessage('bot', 'I only understand commands. Try <span class="cmd">/help</span>.');
      return;
    }

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().replace(/@.*$/, '');

    switch (command) {
      case '/start':
        addMessage('bot', `Welcome to <b>Outage Watchdog</b>.\nPick a zone and I will message you when the schedule changes.\n\nTry <span class="cmd">/subscribe johannesburg</span>.`);
        break;
      case '/help':
        addMessage('bot', helpText());
        break;
      case '/subscribe': {
        if (args.length === 0) { addMessage('bot', 'Which zone? Example: <span class="cmd">/subscribe johannesburg</span>', true); break; }
        if (args.length > 1) { addMessage('bot', 'One zone at a time, please.', true); break; }
        const id = args[0].toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) { addMessage('bot', 'That is not a valid zone id. Use lowercase letters, numbers and hyphens.', true); break; }
        const zone = findZone(id);
        if (!zone) { addMessage('bot', `Unknown zone <b>${escapeHtml(id)}</b>. Try <span class="cmd">/help</span> for the list.`, true); break; }
        subscription = zone;
        addMessage('bot', `Subscribed to <b>${escapeHtml(zone.name)}</b>. ${zone.stage ? `Next slot: ${escapeHtml(zone.slot)}.` : 'No outages are scheduled right now.'}`);
        renderZone(zone);
        toast(`Subscribed to ${zone.id}`);
        break;
      }
      case '/unsubscribe':
      case '/stop':
        if (!subscription) { addMessage('bot', 'You are not subscribed to any zone.'); break; }
        addMessage('bot', `Stopped alerts for <b>${escapeHtml(subscription.name)}</b>. Send <span class="cmd">/subscribe</span> any time to resume.`);
        subscription = null;
        break;
      case '/status':
        if (!subscription) { addMessage('bot', 'No active subscription. Try <span class="cmd">/subscribe johannesburg</span>.'); break; }
        addMessage('bot', `<b>${escapeHtml(subscription.name)}</b>\nStage: ${subscription.stage}\nNext slot: ${escapeHtml(subscription.slot)}\nAlerts: on`);
        break;
      default:
        addMessage('bot', `Unknown command <span class="cmd">${escapeHtml(command)}</span>. Try <span class="cmd">/help</span>.`, true);
    }
  }

  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleCommand(el.chatInput.value);
    el.chatInput.value = '';
  });

  el.chips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    el.chatInput.value = chip.textContent;
    el.chatInput.focus();
    handleCommand(chip.textContent);
    el.chatInput.value = '';
  });

  /* ----------------------------------------------------------- zone lookup */
  el.zoneForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = el.zoneInput.value.trim().toLowerCase();
    const zone = findZone(query) || ZONES.find((z) => z.name.toLowerCase().includes(query));
    if (!zone) {
      toast('Unknown zone — try one from the list');
      el.zoneInput.focus();
      return;
    }
    secondsLeft = 2 * 3600 + 41 * 60 + 18;
    renderZone(zone);
    toast(`Showing ${zone.id}`);
  });

  document.querySelector('#refreshBtn').addEventListener('click', () => {
    secondsLeft = 1 * 3600 + 12 * 60 + 44;
    renderSchedule();
    toast('Outage plan refreshed');
  });

  /* -------------------------------------------------------------- coverage */
  el.zoneGrid.innerHTML = ZONES.map((zone) => `
    <button class="zone-card" type="button" data-zone="${zone.id}">
      <strong>${escapeHtml(zone.name)}</strong>
      <span>${zone.subscribers} subscribers · ${escapeHtml(zone.slot)}</span>
      ${stageBadge(zone.stage)}
    </button>`).join('');

  el.zoneGrid.addEventListener('click', (event) => {
    const card = event.target.closest('[data-zone]');
    if (!card) return;
    const zone = findZone(card.dataset.zone);
    secondsLeft = 2 * 3600 + 41 * 60 + 18;
    renderZone(zone);
    el.zoneInput.value = zone.id;
    document.querySelector('#status').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ------------------------------------------------------------------ boot */
  renderZone(ZONES[0]);
  addMessage('bot', '<b>Outage Watchdog</b> is online.\nSend <span class="cmd">/help</span> to see what I can do.');
})();
