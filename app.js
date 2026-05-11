(() => {
  'use strict';

  const STORAGE_KEY = 'chess-clock-tracker:v1';
  const DEFAULT_REASONS = ['phone', 'youtube', 'social', 'tired', 'distracted', 'other'];
  const DEFAULT_TASKS = ['focus', 'deep work', 'admin'];

  const defaultState = () => ({
    currentState: 'paused',
    stateStartedAt: Date.now(),
    accumulatedWorkMs: 0,
    accumulatedProcrastinateMs: 0,
    flipsToday: 0,
    dayStartedAt: Date.now(),
    activeTask: '',
    reasonLog: [],
    workSegments: [],
    history: [],
    settings: {
      goalMinutes: 240,
      hotkey: null,
      soundOnFlip: false,
      idleEnabled: true,
      idleMinutes: 3,
      customReasons: [...DEFAULT_REASONS],
      customTasks: [...DEFAULT_TASKS],
    },
    yesterday: null,
  });

  let state = load();
  let currentSegment = null; // { task, startedAt }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      const merged = { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
      if (!Array.isArray(merged.settings.customReasons) || !merged.settings.customReasons.length) {
        merged.settings.customReasons = [...DEFAULT_REASONS];
      }
      if (!Array.isArray(merged.settings.customTasks)) {
        merged.settings.customTasks = [...DEFAULT_TASKS];
      }
      if (!Array.isArray(merged.history)) merged.history = [];
      if (!Array.isArray(merged.reasonLog)) merged.reasonLog = [];
      if (!Array.isArray(merged.workSegments)) merged.workSegments = [];
      return merged;
    } catch (e) {
      console.warn('Load failed, starting fresh', e);
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Save failed', e);
    }
  }

  // Elements
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const viewport = $('viewport');
  const stateIndicator = $('state-indicator');
  const pauseBtn = $('pause-btn');
  const pauseIconPath = $('pause-icon-path');
  const settingsBtn = $('settings-btn');
  const statsBtn = $('stats-btn');
  const popoutBtn = $('popout-btn');
  const workTimeEl = $('work-time');
  const procTimeEl = $('proc-time');
  const progressFill = $('progress-fill');
  const progressText = $('progress-text');
  const taskChipsWrap = $('task-chips-wrap');
  const taskChipsEl = $('task-chips');
  const reasonPicker = $('reason-picker');
  const reasonButtons = $('reason-buttons');
  const reasonDismiss = $('reason-dismiss');
  const toast = $('toast');
  const settingsModal = $('settings-modal');
  const statsModal = $('stats-modal');
  const pipPlaceholder = $('pip-placeholder');
  const pipReturnBtn = $('pip-return-btn');
  const clocksEl = viewport.querySelector('.clocks');

  // Time helpers
  const formatHMS = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  };
  const formatHM = (ms) => {
    const totalMin = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  };

  function currentElapsed() {
    const now = Date.now();
    let work = state.accumulatedWorkMs;
    let proc = state.accumulatedProcrastinateMs;
    if (state.currentState === 'working') work += now - state.stateStartedAt;
    else if (state.currentState === 'procrastinating') proc += now - state.stateStartedAt;
    return { work, proc };
  }

  function freezeCurrent() {
    const now = Date.now();
    const delta = now - state.stateStartedAt;
    if (state.currentState === 'working') state.accumulatedWorkMs += delta;
    else if (state.currentState === 'procrastinating') state.accumulatedProcrastinateMs += delta;
    state.stateStartedAt = now;
  }

  // Segment tracking
  function openSegment() {
    currentSegment = { task: state.activeTask || '', startedAt: Date.now() };
  }
  function closeSegment() {
    if (!currentSegment) return;
    const endedAt = Date.now();
    const durationMs = endedAt - currentSegment.startedAt;
    if (durationMs > 0) {
      state.workSegments.push({
        task: currentSegment.task,
        startedAt: currentSegment.startedAt,
        endedAt,
        durationMs,
      });
    }
    currentSegment = null;
  }

  function setState(next, opts = {}) {
    if (next === state.currentState) return;
    const wasWorking = state.currentState === 'working';
    freezeCurrent();
    if (wasWorking) closeSegment();
    const prev = state.currentState;
    state.currentState = next;
    state.stateStartedAt = Date.now();
    if (next === 'working') openSegment();

    if ((prev === 'working' && next === 'procrastinating') || (prev === 'procrastinating' && next === 'working')) {
      state.flipsToday += 1;
      if (state.settings.soundOnFlip) playClick();
    }

    body.dataset.state = next;
    if (pipWindow) pipWindow.document.body.dataset.state = next;
    save();
    render();

    if (next === 'procrastinating' && !opts.silent) {
      showReasonPicker();
    } else {
      hideReasonPicker();
    }
  }

  function flip() {
    if (state.currentState === 'paused') return;
    setState(state.currentState === 'working' ? 'procrastinating' : 'working');
  }

  function togglePause() {
    if (state.currentState === 'paused') {
      state.currentState = 'working';
      state.stateStartedAt = Date.now();
      body.dataset.state = 'working';
      if (pipWindow) pipWindow.document.body.dataset.state = 'working';
      openSegment();
    } else {
      const wasWorking = state.currentState === 'working';
      freezeCurrent();
      if (wasWorking) closeSegment();
      state.currentState = 'paused';
      body.dataset.state = 'paused';
      if (pipWindow) pipWindow.document.body.dataset.state = 'paused';
    }
    save();
    hideReasonPicker();
    render();
  }

  // Rendering
  function render() {
    const { work, proc } = currentElapsed();
    workTimeEl.textContent = formatHMS(work);
    procTimeEl.textContent = formatHMS(proc);

    stateIndicator.textContent = state.currentState;

    pauseIconPath.setAttribute(
      'd',
      state.currentState === 'paused' ? 'M8 5v14l11-7z' : 'M6 5h4v14H6zM14 5h4v14h-4z'
    );

    const goalMs = state.settings.goalMinutes * 60_000;
    const pct = goalMs > 0 ? Math.min(100, (work / goalMs) * 100) : 0;
    progressFill.style.width = pct.toFixed(1) + '%';
    progressText.textContent = `${formatHM(work)} / ${formatHM(goalMs)}`;

    taskChipsWrap.hidden = state.currentState !== 'working';
    if (state.currentState === 'working') renderTaskChips();

    // tab title
    if (state.currentState === 'paused') {
      document.title = 'paused — Byoyomi';
    } else if (state.currentState === 'working') {
      document.title = `\u{1F7E2} ${formatHMS(work)} working`;
    } else {
      document.title = `\u{1F534} ${formatHMS(proc)} procrastinating`;
    }
  }

  function tick() {
    render();
  }

  // Task chips
  function renderTaskChips() {
    taskChipsEl.innerHTML = '';
    state.settings.customTasks.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'task-chip' + (state.activeTask === t ? ' active' : '');
      b.textContent = t;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTask(state.activeTask === t ? '' : t);
      });
      taskChipsEl.appendChild(b);
    });
  }

  function selectTask(t) {
    if (state.activeTask === t) return;
    // If in working state, switching tasks means a new segment.
    if (state.currentState === 'working') {
      closeSegment();
      state.activeTask = t;
      openSegment();
    } else {
      state.activeTask = t;
    }
    save();
    render();
  }

  // Reason picker
  function showReasonPicker() {
    renderReasonButtons();
    reasonPicker.hidden = false;
    clearTimeout(showReasonPicker._t);
    showReasonPicker._t = setTimeout(() => { reasonPicker.hidden = true; }, 8000);
  }
  function hideReasonPicker() {
    reasonPicker.hidden = true;
    clearTimeout(showReasonPicker._t);
  }
  function renderReasonButtons() {
    reasonButtons.innerHTML = '';
    state.settings.customReasons.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reason-btn';
      b.textContent = r;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        state.reasonLog.push({ t: Date.now(), reason: r });
        save();
        hideReasonPicker();
      });
      reasonButtons.appendChild(b);
    });
  }
  reasonDismiss.addEventListener('click', (e) => { e.stopPropagation(); hideReasonPicker(); });
  reasonPicker.addEventListener('click', (e) => e.stopPropagation());

  // Click-to-flip
  viewport.addEventListener('click', (e) => {
    if (e.target.closest('.icon-btn, .reason-picker, .task-chips-wrap, .modal, button, input, .pip-placeholder')) return;
    flip();
  });

  pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });
  settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
  statsBtn.addEventListener('click', (e) => { e.stopPropagation(); openStats(); });

  // Toast
  function showToast(msg, ms = 2400) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, ms);
  }

  // Idle detection
  let lastActivity = Date.now();
  let idleAlreadyFired = false;
  const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
  ACTIVITY_EVENTS.forEach((ev) => document.addEventListener(ev, () => {
    lastActivity = Date.now();
    idleAlreadyFired = false;
  }, { passive: true }));

  function checkIdle() {
    if (!state.settings.idleEnabled) return;
    if (state.currentState === 'paused') return;
    if (idleAlreadyFired) return;
    const idleMs = Date.now() - lastActivity;
    if (idleMs >= state.settings.idleMinutes * 60_000) {
      const wasWorking = state.currentState === 'working';
      freezeCurrent();
      if (wasWorking) closeSegment();
      state.currentState = 'paused';
      body.dataset.state = 'paused';
      if (pipWindow) pipWindow.document.body.dataset.state = 'paused';
      idleAlreadyFired = true;
      save();
      hideReasonPicker();
      render();
      showToast('Auto-paused due to inactivity');
    }
  }

  // Hotkey
  let bindingHotkey = false;
  document.addEventListener('keydown', (e) => {
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;

    if (bindingHotkey) {
      e.preventDefault();
      const k = e.key;
      const modifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(k);
      if (!modifierOnly && k !== 'Escape') {
        state.settings.hotkey = k;
        save();
        renderSettings();
      }
      bindingHotkey = false;
      $('hotkey-bind').textContent = 'Bind key';
      return;
    }

    if (inInput) return;
    if (state.settings.hotkey && e.key === state.settings.hotkey) {
      e.preventDefault();
      if (state.currentState === 'paused') togglePause();
      else flip();
    }
  });

  // Settings modal
  function openSettings() {
    renderSettings();
    settingsModal.hidden = false;
  }
  function closeSettings() {
    settingsModal.hidden = true;
  }
  settingsModal.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeSettings();
  });

  function renderSettings() {
    const s = state.settings;
    $('goal-hours').value = Math.floor(s.goalMinutes / 60);
    $('goal-minutes').value = s.goalMinutes % 60;
    $('hotkey-display').textContent = s.hotkey ? `bound: ${s.hotkey}` : 'none';
    $('sound-toggle').checked = !!s.soundOnFlip;
    $('idle-enabled').checked = !!s.idleEnabled;
    $('idle-minutes').value = s.idleMinutes;
    renderReasonList();
    renderTaskList();
  }

  function renderReasonList() {
    const list = $('reason-list');
    list.innerHTML = '';
    state.settings.customReasons.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.innerHTML = `<span></span><button type="button" title="Remove">x</button>`;
      li.querySelector('span').textContent = r;
      li.querySelector('button').addEventListener('click', () => {
        state.settings.customReasons = state.settings.customReasons.filter((x) => x !== r);
        save();
        renderReasonList();
        renderReasonButtons();
      });
      list.appendChild(li);
    });
  }

  function renderTaskList() {
    const list = $('task-list');
    list.innerHTML = '';
    state.settings.customTasks.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.innerHTML = `<span></span><button type="button" title="Remove">x</button>`;
      li.querySelector('span').textContent = t;
      li.querySelector('button').addEventListener('click', () => {
        state.settings.customTasks = state.settings.customTasks.filter((x) => x !== t);
        if (state.activeTask === t) {
          if (state.currentState === 'working') closeSegment();
          state.activeTask = '';
          if (state.currentState === 'working') openSegment();
        }
        save();
        renderTaskList();
        if (state.currentState === 'working') renderTaskChips();
      });
      list.appendChild(li);
    });
  }

  // Stats modal
  function openStats() {
    renderStats();
    statsModal.hidden = false;
  }
  function closeStats() {
    statsModal.hidden = true;
  }
  statsModal.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined) closeStats();
  });

  function aggregateByTask(segments, includeOpenSegment) {
    const map = new Map();
    segments.forEach((s) => {
      const k = (s.task && s.task.trim()) || 'untagged';
      map.set(k, (map.get(k) || 0) + s.durationMs);
    });
    if (includeOpenSegment && currentSegment && state.currentState === 'working') {
      const k = (currentSegment.task && currentSegment.task.trim()) || 'untagged';
      const dur = Date.now() - currentSegment.startedAt;
      if (dur > 0) map.set(k, (map.get(k) || 0) + dur);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function aggregateReasons(reasonLog) {
    const map = new Map();
    reasonLog.forEach((r) => {
      const k = r.reason || 'unknown';
      map.set(k, (map.get(k) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderPairList(host, pairs) {
    host.innerHTML = '';
    pairs.forEach(([k, v]) => {
      const r = document.createElement('div');
      r.className = 'pair';
      r.innerHTML = `<span class="key"></span><span class="val"></span>`;
      r.querySelector('.key').textContent = k;
      r.querySelector('.val').textContent = v;
      host.appendChild(r);
    });
  }

  function renderKVList(host, entries, formatter) {
    host.innerHTML = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'no data yet';
      host.appendChild(li);
      return;
    }
    entries.forEach(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="k"></span><span class="v"></span>`;
      li.querySelector('.k').textContent = k;
      li.querySelector('.v').textContent = formatter(v);
      host.appendChild(li);
    });
  }

  function todaySummaryPairs() {
    const { work, proc } = currentElapsed();
    const total = work + proc;
    const ratio = total ? (work / total * 100).toFixed(0) + '%' : '—';
    const goalMs = state.settings.goalMinutes * 60_000;
    const goalPct = goalMs ? Math.min(100, (work / goalMs) * 100).toFixed(0) + '%' : '—';
    return [
      ['work', formatHM(work)],
      ['procrastinate', formatHM(proc)],
      ['flips', String(state.flipsToday)],
      ['work ratio', ratio],
      ['goal', `${formatHM(work)} / ${formatHM(goalMs)} (${goalPct})`],
    ];
  }

  function renderStats() {
    renderPairList($('stats-today'), todaySummaryPairs());
    renderKVList($('stats-today-tasks'), aggregateByTask(state.workSegments, true), formatHM);
    renderKVList($('stats-today-reasons'), aggregateReasons(state.reasonLog), (n) => `× ${n}`);

    const yEl = $('stats-yesterday');
    const yTasks = $('stats-yesterday-tasks');
    const yReasons = $('stats-yesterday-reasons');
    if (state.yesterday) {
      const y = state.yesterday;
      const yTotal = y.workMs + y.procrastinateMs;
      const yRatio = yTotal ? (y.workMs / yTotal * 100).toFixed(0) + '%' : '—';
      renderPairList(yEl, [
        ['date', y.date],
        ['work', formatHM(y.workMs)],
        ['procrastinate', formatHM(y.procrastinateMs)],
        ['flips', String(y.flips || 0)],
        ['work ratio', yRatio],
      ]);
      renderKVList(yTasks, aggregateByTask(y.workSegments || [], false), formatHM);
      renderKVList(yReasons, aggregateReasons(y.reasons || []), (n) => `× ${n}`);
    } else {
      yEl.textContent = 'no record';
      yTasks.innerHTML = '';
      yReasons.innerHTML = '';
    }

    renderHistory();
  }

  function renderHistory() {
    const list = $('history-list');
    list.innerHTML = '';
    if (!state.history.length) {
      const li = document.createElement('li');
      li.className = 'h-empty';
      li.textContent = 'no history yet — use "New Day" to archive today';
      list.appendChild(li);
      return;
    }
    const slice = state.history.slice().reverse().slice(0, 30);
    slice.forEach((d) => {
      const total = d.workMs + d.procrastinateMs;
      const ratio = total ? (d.workMs / total * 100).toFixed(0) + '%' : '—';
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'h-row';
      row.innerHTML = `<span class="h-date"></span><span class="h-vals"></span>`;
      row.querySelector('.h-date').textContent = d.date;
      row.querySelector('.h-vals').textContent = `work ${formatHM(d.workMs)} · proc ${formatHM(d.procrastinateMs)} · ${ratio} · ${d.flips || 0} flips`;
      li.appendChild(row);

      const detail = document.createElement('div');
      detail.className = 'h-detail';
      detail.hidden = true;
      row.addEventListener('click', () => {
        if (detail.hidden) {
          buildHistoryDetail(detail, d);
          detail.hidden = false;
        } else {
          detail.hidden = true;
        }
      });
      li.appendChild(detail);
      list.appendChild(li);
    });
  }

  function buildHistoryDetail(host, d) {
    host.innerHTML = '';
    const tasks = document.createElement('div');
    tasks.className = 'sub-block';
    tasks.innerHTML = '<h4>By task</h4><ul class="kv-list"></ul>';
    renderKVList(tasks.querySelector('ul'), aggregateByTask(d.workSegments || [], false), formatHM);
    host.appendChild(tasks);

    const reasons = document.createElement('div');
    reasons.className = 'sub-block';
    reasons.innerHTML = '<h4>By reason</h4><ul class="kv-list"></ul>';
    renderKVList(reasons.querySelector('ul'), aggregateReasons(d.reasons || []), (n) => `× ${n}`);
    host.appendChild(reasons);
  }

  // Settings handlers
  $('settings-close').addEventListener('click', closeSettings);
  $('stats-close').addEventListener('click', closeStats);

  $('goal-hours').addEventListener('change', (e) => {
    const h = Math.max(0, Math.min(23, parseInt(e.target.value || '0', 10)));
    const m = state.settings.goalMinutes % 60;
    state.settings.goalMinutes = h * 60 + m;
    save();
    render();
  });
  $('goal-minutes').addEventListener('change', (e) => {
    const m = Math.max(0, Math.min(59, parseInt(e.target.value || '0', 10)));
    const h = Math.floor(state.settings.goalMinutes / 60);
    state.settings.goalMinutes = h * 60 + m;
    save();
    render();
  });

  $('hotkey-bind').addEventListener('click', () => {
    bindingHotkey = true;
    $('hotkey-bind').textContent = 'press any key…';
  });
  $('hotkey-clear').addEventListener('click', () => {
    state.settings.hotkey = null;
    save();
    renderSettings();
  });

  $('sound-toggle').addEventListener('change', (e) => {
    state.settings.soundOnFlip = e.target.checked;
    save();
  });
  $('idle-enabled').addEventListener('change', (e) => {
    state.settings.idleEnabled = e.target.checked;
    save();
  });
  $('idle-minutes').addEventListener('change', (e) => {
    const v = Math.max(1, Math.min(120, parseInt(e.target.value || '3', 10)));
    state.settings.idleMinutes = v;
    save();
  });

  $('reason-add').addEventListener('click', () => addReason());
  $('reason-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addReason(); });
  function addReason() {
    const inp = $('reason-new');
    const v = (inp.value || '').trim().toLowerCase();
    if (!v) return;
    if (state.settings.customReasons.includes(v)) return;
    state.settings.customReasons.push(v);
    inp.value = '';
    save();
    renderReasonList();
    renderReasonButtons();
  }

  $('task-add').addEventListener('click', () => addTask());
  $('task-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
  function addTask() {
    const inp = $('task-new');
    const v = (inp.value || '').trim().toLowerCase();
    if (!v) return;
    if (state.settings.customTasks.includes(v)) return;
    state.settings.customTasks.push(v);
    inp.value = '';
    save();
    renderTaskList();
    if (state.currentState === 'working') renderTaskChips();
  }

  $('new-day-btn').addEventListener('click', () => {
    if (!confirm('Archive today\'s totals and start a new day?')) return;
    archiveDay();
  });

  $('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `chess-clock-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Reset ALL data? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Everything will be wiped.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    currentSegment = null;
    body.dataset.state = state.currentState;
    save();
    renderSettings();
    render();
    showToast('All data reset');
  });

  function archiveDay() {
    const wasWorking = state.currentState === 'working';
    freezeCurrent();
    if (wasWorking) closeSegment();
    const { work, proc } = currentElapsed();
    const date = new Date(state.dayStartedAt).toISOString().slice(0, 10);
    const today = {
      date,
      workMs: work,
      procrastinateMs: proc,
      flips: state.flipsToday,
      ratio: (work + proc) ? work / (work + proc) : 0,
      task: state.activeTask || '',
      reasons: state.reasonLog.slice(),
      workSegments: state.workSegments.slice(),
    };
    state.history.push(today);
    state.yesterday = today;
    state.accumulatedWorkMs = 0;
    state.accumulatedProcrastinateMs = 0;
    state.flipsToday = 0;
    state.reasonLog = [];
    state.workSegments = [];
    state.activeTask = '';
    state.dayStartedAt = Date.now();
    state.currentState = 'paused';
    state.stateStartedAt = Date.now();
    body.dataset.state = 'paused';
    if (pipWindow) pipWindow.document.body.dataset.state = 'paused';
    save();
    renderSettings();
    render();
    showToast('Day archived');
  }

  // Sound
  let audioCtx = null;
  function playClick() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 660;
      g.gain.value = 0.0001;
      o.connect(g).connect(audioCtx.destination);
      const t = audioCtx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.start(t);
      o.stop(t + 0.13);
    } catch (e) { /* noop */ }
  }

  // Document Picture-in-Picture
  let pipWindow = null;
  let clocksOrigParent = null;
  let clocksOrigNext = null;

  if (!('documentPictureInPicture' in window)) {
    popoutBtn.hidden = true;
  } else {
    popoutBtn.hidden = false;
    popoutBtn.addEventListener('click', (e) => { e.stopPropagation(); openPip(); });
  }

  async function openPip() {
    if (pipWindow) return;
    try {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 260, height: 200 });
    } catch (err) {
      console.warn('PiP failed', err);
      return;
    }
    // Copy stylesheet so the clock looks the same
    [...document.styleSheets].forEach((sheet) => {
      try {
        const cssText = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const style = pipWindow.document.createElement('style');
        style.textContent = cssText;
        pipWindow.document.head.appendChild(style);
      } catch (err) {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    });
    // PiP-specific layout tweaks
    const pipStyle = pipWindow.document.createElement('style');
    pipStyle.textContent = `
      html, body { height: 100%; margin: 0; padding: 0; }
      body { display: grid; place-items: center; cursor: pointer; user-select: none; container-type: size; container-name: vp; }
      .clocks { width: 100%; padding: 8px; }
    `;
    pipWindow.document.head.appendChild(pipStyle);

    pipWindow.document.body.dataset.state = state.currentState;

    // Move .clocks element into the PiP doc — preserves DOM refs in app.js
    clocksOrigParent = clocksEl.parentNode;
    clocksOrigNext = clocksEl.nextSibling;
    pipWindow.document.body.appendChild(clocksEl);

    // Click-to-flip in PiP
    pipWindow.document.body.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      flip();
    });

    // Show placeholder in main viewport
    pipPlaceholder.hidden = false;

    pipWindow.addEventListener('pagehide', closePip, { once: true });
  }

  function closePip() {
    if (!pipWindow) return;
    // Move .clocks back
    if (clocksOrigParent) {
      if (clocksOrigNext && clocksOrigNext.parentNode === clocksOrigParent) {
        clocksOrigParent.insertBefore(clocksEl, clocksOrigNext);
      } else {
        clocksOrigParent.appendChild(clocksEl);
      }
    }
    clocksOrigParent = null;
    clocksOrigNext = null;
    pipPlaceholder.hidden = true;
    try { pipWindow.close(); } catch (e) { /* noop */ }
    pipWindow = null;
  }

  pipReturnBtn.addEventListener('click', (e) => { e.stopPropagation(); closePip(); });

  // Service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* fine offline-less */ });
    });
  }

  // Visibility — recompute on return
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });

  // Init
  body.dataset.state = state.currentState;
  if (state.currentState === 'working') openSegment();
  render();
  setInterval(tick, 250);
  setInterval(checkIdle, 10_000);
  setInterval(save, 5_000);
})();
