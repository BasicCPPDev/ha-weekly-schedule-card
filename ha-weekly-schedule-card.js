/**
 * Weekly Schedule Card for Home Assistant
 *
 * Edits a weekly ON/OFF schedule stored as one text entity per day, in the format
 *   "07:00/ON 09:00/OFF 18:30/ON 23:00/OFF"
 * Each time gives the state FROM that time on; before the first change of a day, the state of the previous day
 * carries on (a night period is "22:00/ON" on Monday and "02:00/OFF" on Tuesday). The device runs the schedule
 * itself; this card only shows and edits it. Written for the TYZS6 programmable plug (Zigbee2MQTT converter
 * prise_tyzs6.js), usable with any device exposing the same per-day texts.
 *
 * No external dependency (plain custom element). Version: VERSION below, "YYYY.M.D-NN" like Home Assistant (NN =
 * release of the day), set by the release workflow.
 */

const VERSION = '2026.10.7-00';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_MIN = 1440;
const WEEK_MIN = 7 * DAY_MIN;
const MAX_CHANGES = 20;

console.info(
  `%c WEEKLY-SCHEDULE-CARD %c ${VERSION} `,
  'color: white; font-weight: bold; background: #03a9f4',
  'color: #03a9f4; font-weight: bold; background: white'
);

// ============================================================================
// Translations
// ============================================================================

const STRINGS = {
  en: {
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    days_short: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    manual: 'Manual', auto: 'Auto',
    manual_note: 'Manual mode: the schedule is ignored',
    override: 'Manual change until the next change of the schedule', override_chip: 'Override',
    next_change: 'Next change:', none: 'none',
    unsaved: 'Unsaved changes', save: 'Save', cancel: 'Cancel', saving: 'Saving…',
    not_confirmed: 'Not confirmed by the device:',
    period: 'ON period', new_period: 'New ON period', start: 'Start', end: 'End',
    stop: 'Stop (OFF)', start_marker: 'Start (ON)', marker: 'Single change', new_stop: 'New stop',
    type: 'Action', delete: 'Delete', add: 'Add', apply: 'Apply', close: 'Close',
    day_edit: 'Changes of the day', copy_to: 'Copy this day to', clear: 'Clear the day', add_stop: 'Add a stop',
    text_help: 'HH:MM/ON or HH:MM/OFF, separated by spaces',
    err_order: 'The end must be after the start', err_overlap: 'Overlaps another change',
    err_too_many: 'At most 20 changes per day', err_text: 'Invalid text',
    err_entities: 'Schedule entities not found for', always_on: 'ON all week',
    invalid_day: 'unreadable schedule', marker_title: 'single change (no effect if already in that state)',
  },
  fr: {
    days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    days_short: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'],
    manual: 'Manuel', auto: 'Auto',
    manual_note: 'Mode manuel : le programme est ignoré',
    override: 'Changement manuel jusqu\'au prochain changement du programme', override_chip: 'Forçage',
    next_change: 'Prochain changement :', none: 'aucun',
    unsaved: 'Modifications non enregistrées', save: 'Enregistrer', cancel: 'Annuler', saving: 'Enregistrement…',
    not_confirmed: 'Non confirmé par l\'appareil :',
    period: 'Plage ON', new_period: 'Nouvelle plage ON', start: 'Début', end: 'Fin',
    stop: 'Arrêt (OFF)', start_marker: 'Marche (ON)', marker: 'Changement isolé', new_stop: 'Nouvel arrêt',
    type: 'Action', delete: 'Supprimer', add: 'Ajouter', apply: 'Appliquer', close: 'Fermer',
    day_edit: 'Changements du jour', copy_to: 'Copier ce jour vers', clear: 'Vider le jour', add_stop: 'Ajouter un arrêt',
    text_help: 'HH:MM/ON ou HH:MM/OFF, séparés par des espaces',
    err_order: 'La fin doit être après le début', err_overlap: 'Chevauche un autre changement',
    err_too_many: '20 changements par jour au plus', err_text: 'Texte invalide',
    err_entities: 'Entités du programme introuvables pour', always_on: 'ON toute la semaine',
    invalid_day: 'programme illisible', marker_title: 'changement isolé (sans effet si déjà dans cet état)',
  },
};

// ============================================================================
// Model (pure functions, exported for the tests)
// ============================================================================

const pad = (n) => String(n).padStart(2, '0');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** "07:00/ON 9:30/off" → [{m: 420, on: true}, …] sorted ; throws on invalid text */
export function parseDay(text) {
  const out = [];
  for (const item of String(text ?? '').trim().split(/[\s,;]+/).filter(Boolean)) {
    const r = /^(\d{1,2}):(\d{2})\/(ON|OFF)$/i.exec(item);
    if (!r || Number(r[1]) > 23 || Number(r[2]) > 59) throw new Error(item);
    out.push({ m: Number(r[1]) * 60 + Number(r[2]), on: r[3].toUpperCase() === 'ON' });
  }
  out.sort((a, b) => a.m - b.m);
  for (let i = 1; i < out.length; i++) if (out[i].m === out[i - 1].m) throw new Error(fmtMin(out[i].m));
  return out;
}

export const formatDay = (list) =>
  [...list].sort((a, b) => a.m - b.m).map((c) => `${fmtMin(c.m)}/${c.on ? 'ON' : 'OFF'}`).join(' ');

/**
 * Week analysis. days = 7 lists of changes. Returns
 *   events: [{t, day, m, on, edge}] sorted by week minute t (edge = the change switches the state),
 *   blocks: [{start: event, end: event|null}] ON periods (end null = ON all week),
 *   initial: state at Monday 00:00 (the last change of the week carries over).
 */
export function analyse(days) {
  const events = [];
  days.forEach((list, day) => list.forEach((c) => events.push({ t: day * DAY_MIN + c.m, day, m: c.m, on: c.on })));
  events.sort((a, b) => a.t - b.t);
  const initial = events.length ? events[events.length - 1].on : false;
  let state = initial;
  for (const e of events) {
    e.edge = e.on !== state;
    state = e.on;
  }
  const edges = events.filter((e) => e.edge);
  const blocks = [];
  if (!edges.length) {
    if (initial) blocks.push({ start: null, end: null });
  } else {
    edges.forEach((e, i) => {
      if (e.on) blocks.push({ start: e, end: edges[(i + 1) % edges.length] });
    });
  }
  return { events, blocks, initial };
}

/** Week minutes from a to b going forward (0 < result ≤ WEEK_MIN for a ≠ b) */
export const forward = (a, b) => ((b - a) % WEEK_MIN + WEEK_MIN) % WEEK_MIN || WEEK_MIN;

/** Splits a period [t0, t0 + len) into per-day segments [{day, from, to}] (minutes of the day) */
export function segments(t0, len) {
  const out = [];
  let t = t0, left = len;
  while (left > 0) {
    const day = Math.floor(t / DAY_MIN) % 7, from = t % DAY_MIN, to = Math.min(DAY_MIN, from + left);
    out.push({ day, from, to });
    left -= to - from;
    t = (day * DAY_MIN + to) % WEEK_MIN;
  }
  return out;
}

const clone = (days) => days.map((l) => l.map((c) => ({ ...c })));
const removeAt = (days, day, m) => { days[day] = days[day].filter((c) => c.m !== m); };
const insert = (days, day, m, on) => { removeAt(days, day, m); days[day].push({ m, on }); days[day].sort((a, b) => a.m - b.m); };

/**
 * Sets an ON period from (sd, sm) to (ed, em), replacing the period `old` (or adding one). A period touching another
 * one (starting exactly at its end, or ending exactly at its start) is merged with it. Refuses a period inside or
 * containing other changes. Returns the new days, or throws 'order' / 'overlap' / 'too_many'.
 */
export function setPeriod(days, old, sd, sm, ed, em) {
  const d = clone(days);
  if (old?.start) removeAt(d, old.start.day, old.start.m);
  if (old?.end) removeAt(d, old.end.day, old.end.m);
  const t0 = sd * DAY_MIN + sm, t1 = ed * DAY_MIN + em;
  if (t0 === t1) throw new Error('order');
  const len = forward(t0, t1);
  const { events } = analyse(d);
  for (const e of events) if (e.t !== t0 && forward(t0, e.t) < len) throw new Error('overlap');
  // state just before the start, ignoring a change exactly at t0 (cyclic : the last change of the week carries over)
  const others = events.filter((e) => e.t !== t0);
  const prev = others.filter((e) => e.t < t0).pop() ?? others[others.length - 1];
  const at0 = events.find((e) => e.t === t0), at1 = events.find((e) => e.t === t1);
  if (prev?.on) {
    if (!at0) throw new Error('overlap');            // inside another period
    removeAt(d, sd, sm);                             // starts at the end of a period: merge
  } else {
    insert(d, sd, sm, true);
  }
  if (at1?.on) removeAt(d, ed, em);                  // ends at the start of a period: merge
  else insert(d, ed, em, false);
  if (d[sd].length > MAX_CHANGES || d[ed].length > MAX_CHANGES) throw new Error('too_many');
  return d;
}

export function deletePeriod(days, block) {
  const d = clone(days);
  if (block.start) removeAt(d, block.start.day, block.start.m);
  if (block.end) removeAt(d, block.end.day, block.end.m);
  return d;
}

/** Sets a single change (marker) at (day, m), replacing `old` if given */
export function setChange(days, old, day, m, on) {
  const d = clone(days);
  if (old) removeAt(d, old.day, old.m);
  insert(d, day, m, on);
  if (d[day].length > MAX_CHANGES) throw new Error('too_many');
  return d;
}

export function deleteChange(days, ev) {
  const d = clone(days);
  removeAt(d, ev.day, ev.m);
  return d;
}

// ============================================================================
// Card
// ============================================================================

const BaseElement = globalThis.HTMLElement ?? class {};

class WeeklyScheduleCard extends BaseElement {
  static getStubConfig(hass) {
    const found = Object.keys(hass?.states ?? {}).find(
      (id) => id.startsWith('switch.') && hass.states[`text.${id.slice(7)}_schedule_monday`]);
    return { entity: found ?? 'switch.prise_programmable' };
  }

  static getConfigElement() {
    return document.createElement('weekly-schedule-card-editor');
  }

  setConfig(config) {
    if (!config?.entity) throw new Error('entity is required (the switch of the device)');
    this._config = { step: 15, ...config };
    this._pending = null;
    this._dialog = null;
    this._render(true);
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      if (this._pending && this._saving) this._checkSaved();
      if (this._dialog) this._needRender = true;   // ne pas effacer une saisie en cours
      else this._render();
    }
  }

  // --- entities -------------------------------------------------------------

  _t(key) {
    const lang = (this._hass?.locale?.language ?? this._hass?.language ?? 'en').slice(0, 2);
    return (STRINGS[lang] ?? STRINGS.en)[key] ?? STRINGS.en[key] ?? key;
  }

  _entities() {
    const c = this._config, h = this._hass;
    const base = c.entity.split('.')[1];
    const reg = h?.entities ?? {};
    const device = reg[c.entity]?.device_id;
    const sameDevice = device
      ? Object.values(reg).filter((e) => e.device_id === device).map((e) => e.entity_id) : [];
    const find = (domain, suffix, fallback) =>
      sameDevice.find((id) => id.startsWith(`${domain}.`) && id.endsWith(suffix))
      ?? (h?.states[fallback] ? fallback : undefined);
    const schedule = DAYS.map((d) => c.schedule_entities?.[d] ?? find('text', `_schedule_${d}`, `text.${base}_schedule_${d}`));
    return {
      schedule,
      mode: c.mode_entity ?? find('select', '_mode', `select.${base}_mode`),
      override: c.override_entity ?? find('binary_sensor', '_override', `binary_sensor.${base}_override`),
      next: c.next_change_entity ?? find('sensor', '_next_change', `sensor.${base}_next_change`),
    };
  }

  _signature() {
    if (!this._hass || !this._config) return '';
    const e = this._entities();
    return [this._config.entity, ...e.schedule, e.mode, e.override, e.next]
      .map((id) => `${id}=${this._hass.states[id]?.state}`).join('|') + `|${this._hass.locale?.language}`;
  }

  /** Schedule as stored in the device (from the text entities); null for an unreadable day */
  _stored() {
    return this._entities().schedule.map((id) => {
      try { return parseDay(this._hass.states[id]?.state ?? ''); } catch { return null; }
    });
  }

  _days() {
    return this._pending ?? this._stored().map((d) => d ?? []);
  }

  _changedDays() {
    if (!this._pending) return [];
    const stored = this._entities().schedule.map((id) => this._hass.states[id]?.state ?? '');
    return DAYS.map((_, i) => i).filter((i) => formatDay(this._pending[i]) !== stored[i]);
  }

  // --- actions --------------------------------------------------------------

  _edit(days) {
    this._pending = days;
    this._error = null;
    this._render();
  }

  async _save() {
    const ids = this._entities().schedule;
    const changed = this._changedDays();
    this._saving = Date.now();
    this._render();
    for (const i of changed) {
      await this._hass.callService('text', 'set_value', { entity_id: ids[i], value: formatDay(this._pending[i]) });
    }
    setTimeout(() => this._checkSaved(true), 15000);
  }

  _checkSaved(timeout = false) {
    const left = this._changedDays();
    if (!left.length) {
      this._pending = null;
      this._saving = null;
      this._error = null;
    } else if (timeout && this._saving) {
      this._saving = null;
      this._error = `${this._t('not_confirmed')} ${left.map((i) => this._t('days')[i]).join(', ')}`;
    }
    this._render();
  }

  _toggle() {
    this._hass.callService('switch', 'toggle', { entity_id: this._config.entity });
  }

  _setMode(mode) {
    const id = this._entities().mode;
    if (id) this._hass.callService('select', 'select_option', { entity_id: id, option: mode });
  }

  // --- rendering ------------------------------------------------------------

  _render(force = false) {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (!this._hass) return;
    const e = this._entities();
    const missing = e.schedule.some((id) => !id || !this._hass.states[id]);
    if (missing) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card><div class="msg">${this._t('err_entities')} ${esc(this._config.entity)}</div></ha-card>`;
      return;
    }
    const st = this._hass.states;
    const sw = st[this._config.entity];
    const on = sw?.state === 'on';
    const mode = e.mode ? st[e.mode]?.state : undefined;
    const override = e.override ? st[e.override]?.state === 'on' : false;
    const next = e.next ? st[e.next]?.state : undefined;
    const title = this._config.title ?? sw?.attributes?.friendly_name ?? this._config.entity;
    const stored = this._stored();
    const days = this._days();
    const { events, blocks, initial } = analyse(days);
    const changed = this._changedDays();

    const now = new Date();
    const today = (now.getDay() + 6) % 7, nowMin = now.getHours() * 60 + now.getMinutes();

    const rows = DAYS.map((_, i) => {
      const segs = [];
      blocks.forEach((b, bi) => {
        const parts = b.start ? segments(b.start.t, forward(b.start.t, b.end.t)) : [{ day: i, from: 0, to: DAY_MIN, all: true }];
        parts.forEach((p, pi) => {
          if (p.day !== i) return;
          const cls = [pi > 0 || p.all ? 'cont-left' : '', pi < parts.length - 1 || p.all ? 'cont-right' : ''].join(' ');
          const tip = b.start ? `${this._t('days_short')[b.start.day]} ${fmtMin(b.start.m)} → ${this._t('days_short')[b.end.day]} ${fmtMin(b.end.m)}`
            : this._t('always_on');
          segs.push(`<div class="block ${cls}" data-block="${bi}" title="${tip}"
            style="left:${(p.from / DAY_MIN) * 100}%;width:${((p.to - p.from) / DAY_MIN) * 100}%"></div>`);
        });
      });
      const marks = events.filter((ev) => ev.day === i && !ev.edge).map((ev) =>
        `<div class="marker ${ev.on ? 'on' : 'off'}" data-marker="${ev.t}" title="${fmtMin(ev.m)}/${ev.on ? 'ON' : 'OFF'} — ${this._t('marker_title')}"
          style="left:${(ev.m / DAY_MIN) * 100}%"></div>`).join('');
      const nowLine = i === today ? `<div class="now" style="left:${(nowMin / DAY_MIN) * 100}%"></div>` : '';
      const bad = stored[i] === null && !this._pending ? `<span class="bad" title="${this._t('invalid_day')}">!</span>` : '';
      return `<div class="row ${i === today ? 'today' : ''} ${changed.includes(i) ? 'changed' : ''}">
        <button class="day" data-day="${i}">${this._t('days_short')[i]}${bad}</button>
        <div class="track" data-track="${i}">${segs.join('')}${marks}${nowLine}</div></div>`;
    }).join('');

    const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) =>
      `<span style="left:${(h / 24) * 100}%">${h}</span>`).join('');
    const modeCtl = e.mode ? `<div class="seg">
        <button class="${mode === 'manual' ? 'sel' : ''}" data-mode="manual">${this._t('manual')}</button>
        <button class="${mode === 'auto' ? 'sel' : ''}" data-mode="auto">${this._t('auto')}</button></div>` : '';
    const info = [
      mode === 'manual' ? `<span class="note">${this._t('manual_note')}</span>` : '',
      override ? `<span class="chip warn" title="${this._t('override')}">⟲ ${this._t('override_chip')}</span>` : '',
      mode !== 'manual' && e.next ? `<span class="note">${this._t('next_change')} ${this._fmtNext(next)}</span>` : '',
    ].join('');
    const footer = this._pending || this._error ? `<div class="footer">
        <span class="${this._error ? 'err' : ''}">${this._error ?? (this._saving ? this._t('saving') : this._t('unsaved'))}</span>
        <button class="txt" data-act="cancel">${this._t('cancel')}</button>
        ${this._pending ? `<button class="main" data-act="save" ${this._saving ? 'disabled' : ''}>${this._t('save')}</button>` : ''}</div>` : '';

    this.shadowRoot.innerHTML = `${STYLE}<ha-card>
      <div class="head">
        <div class="title">${esc(title)}</div>
        ${modeCtl}
        <button class="power ${on ? 'on' : ''}" data-act="toggle" title="${esc(this._config.entity)}">${on ? 'ON' : 'OFF'}</button>
      </div>
      <div class="info">${info}</div>
      <div class="grid ${mode === 'manual' ? 'dim' : ''}">
        <div class="hours">${hours}</div>${rows}
      </div>
      ${footer}
      <div class="dialog-host"></div>
    </ha-card>`;
    this._bind(blocks, events);
    if (this._dialog) this._renderDialog();
  }

  _fmtNext(v) {
    const r = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(v ?? '');
    if (!r) return this._t('none');
    const d = new Date(Number(r[1]), Number(r[2]) - 1, Number(r[3]));
    return `${this._t('days_short')[(d.getDay() + 6) % 7]} ${r[4]}:${r[5]}`;
  }

  _bind(blocks, events) {
    const root = this.shadowRoot;
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this._setMode(b.dataset.mode)));
    root.querySelector('[data-act="toggle"]')?.addEventListener('click', () => this._toggle());
    root.querySelector('[data-act="save"]')?.addEventListener('click', () => this._save());
    root.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      this._pending = null; this._saving = null; this._error = null; this._render();
    });
    root.querySelectorAll('[data-day]').forEach((b) =>
      b.addEventListener('click', () => this._open({ kind: 'day', day: Number(b.dataset.day) })));
    root.querySelectorAll('[data-track]').forEach((tr) => tr.addEventListener('click', (ev) => {
      const day = Number(tr.dataset.track);
      const blockEl = ev.target.closest('[data-block]'), markEl = ev.target.closest('[data-marker]');
      if (blockEl) return this._open({ kind: 'period', block: blocks[Number(blockEl.dataset.block)] });
      if (markEl) return this._open({ kind: 'change', ev: events.find((e) => e.t === Number(markEl.dataset.marker)) });
      const rect = tr.getBoundingClientRect(), step = this._config.step;
      const m = Math.min(DAY_MIN - step, Math.round(((ev.clientX - rect.left) / rect.width) * DAY_MIN / step) * step);
      this._open({ kind: 'period', block: null, day, m });
    }));
  }

  // --- dialogs --------------------------------------------------------------

  _open(dialog) {
    this._dialog = dialog;
    this._dialogError = null;
    this._renderDialog();
  }

  _close() {
    this._dialog = null;
    this.shadowRoot.querySelector('.dialog-host').innerHTML = '';
    if (this._needRender) { this._needRender = false; this._render(); }
  }

  _daySelect(name, value) {
    return `<select name="${name}">${this._t('days').map((d, i) => `<option value="${i}" ${i === value ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
  }

  _timeInput(name, m) {
    return `<input type="time" name="${name}" step="${this._config.step * 60}" value="${fmtMin(m)}">`;
  }

  _renderDialog() {
    const host = this.shadowRoot.querySelector('.dialog-host');
    const d = this._dialog, days = this._days();
    let title, body, buttons;
    if (d.kind === 'period') {
      const b = d.block;
      const sd = b?.start?.day ?? d.day, sm = b?.start?.m ?? d.m;
      const endT = b?.end ? b.end.t : (sd * DAY_MIN + sm + 60) % WEEK_MIN;
      const ed = b?.end?.day ?? Math.floor(endT / DAY_MIN), em = b?.end?.m ?? endT % DAY_MIN;
      title = b ? this._t('period') : this._t('new_period');
      body = `<label>${this._t('start')}</label><div class="pair">${this._daySelect('sd', sd)}${this._timeInput('sm', sm)}</div>
        <label>${this._t('end')}</label><div class="pair">${this._daySelect('ed', ed)}${this._timeInput('em', em)}</div>`;
      buttons = `${b?.start ? `<button class="txt danger" data-dlg="delete">${this._t('delete')}</button>` : ''}
        <button class="txt" data-dlg="close">${this._t('cancel')}</button>
        <button class="main" data-dlg="ok">${b ? this._t('apply') : this._t('add')}</button>`;
      if (b && !b.start) {
        body = `<p>${this._t('always_on')}</p>`;
        buttons = `<button class="txt" data-dlg="close">${this._t('close')}</button>`;
      }
    } else if (d.kind === 'change') {
      const ev = d.ev;
      title = ev ? this._t('marker') : this._t('new_stop');
      body = `<label>${this._t('start')}</label><div class="pair">${this._daySelect('cd', ev?.day ?? d.day)}${this._timeInput('cm', ev?.m ?? 0)}</div>
        <label>${this._t('type')}</label><div class="pair"><select name="con">
          <option value="0" ${!ev?.on ? 'selected' : ''}>${this._t('stop')}</option>
          <option value="1" ${ev?.on ? 'selected' : ''}>${this._t('start_marker')}</option></select></div>
        <p class="help">${this._t('marker_title')}</p>`;
      buttons = `${ev ? `<button class="txt danger" data-dlg="delete">${this._t('delete')}</button>` : ''}
        <button class="txt" data-dlg="close">${this._t('cancel')}</button>
        <button class="main" data-dlg="ok">${ev ? this._t('apply') : this._t('add')}</button>`;
    } else {
      const i = d.day;
      title = `${this._t('days')[i]} — ${this._t('day_edit')}`;
      const raw = this._pending ? formatDay(days[i]) : (this._hass.states[this._entities().schedule[i]]?.state ?? '');
      body = `<input type="text" name="txt" value="${esc(raw)}" spellcheck="false"><p class="help">${this._t('text_help')}</p>
        <label>${this._t('copy_to')}</label><div class="checks">${this._t('days_short').map((n, j) => j === i ? ''
          : `<label class="chk"><input type="checkbox" name="copy" value="${j}">${n}</label>`).join('')}</div>`;
      buttons = `<button class="txt" data-dlg="stop">${this._t('add_stop')}</button>
        <button class="txt danger" data-dlg="clear">${this._t('clear')}</button>
        <button class="txt" data-dlg="close">${this._t('cancel')}</button>
        <button class="main" data-dlg="ok">${this._t('apply')}</button>`;
    }
    host.innerHTML = `<div class="overlay"><div class="dialog" role="dialog">
        <div class="dtitle">${title}</div><div class="dbody">${body}</div>
        ${this._dialogError ? `<div class="err">${this._dialogError}</div>` : ''}
        <div class="dbuttons">${buttons}</div></div></div>`;
    host.querySelector('.overlay').addEventListener('click', (ev) => { if (ev.target.classList.contains('overlay')) this._close(); });
    host.querySelectorAll('[data-dlg]').forEach((b) => b.addEventListener('click', () => this._dialogAction(b.dataset.dlg)));
  }

  _dialogAction(action) {
    const host = this.shadowRoot.querySelector('.dialog-host');
    const val = (n) => host.querySelector(`[name="${n}"]`)?.value;
    const toMin = (s) => { const [h, m] = String(s ?? '').split(':').map(Number); return h * 60 + m; };
    const d = this._dialog, days = this._days();
    if (action === 'close') return this._close();
    try {
      let next;
      if (d.kind === 'period') {
        if (action === 'delete') next = deletePeriod(days, d.block);
        else next = setPeriod(days, d.block, Number(val('sd')), toMin(val('sm')), Number(val('ed')), toMin(val('em')));
      } else if (d.kind === 'change') {
        if (action === 'delete') next = deleteChange(days, d.ev);
        else next = setChange(days, d.ev, Number(val('cd')), toMin(val('cm')), val('con') === '1');
      } else {
        if (action === 'stop') return this._open({ kind: 'change', ev: null, day: d.day });
        let list;
        if (action === 'clear') list = [];
        else {
          try { list = parseDay(val('txt')); } catch (err) { throw new Error('text'); }
          if (list.length > MAX_CHANGES) throw new Error('too_many');
        }
        next = days.map((l) => l.map((c) => ({ ...c })));
        next[d.day] = list;
        host.querySelectorAll('[name="copy"]:checked').forEach((c) => { next[Number(c.value)] = list.map((x) => ({ ...x })); });
      }
      this._dialog = null;
      this._needRender = false;
      this._edit(next);
    } catch (err) {
      const key = { order: 'err_order', overlap: 'err_overlap', too_many: 'err_too_many', text: 'err_text' }[err.message];
      this._dialogError = key ? this._t(key) : esc(err.message);
      this._renderDialog();
    }
  }
}

// ============================================================================
// Visual editor
// ============================================================================

class WeeklyScheduleCardEditor extends BaseElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.computeLabel = (s) => ({ entity: 'Switch of the device', title: 'Title', step: 'Step (minutes)' }[s.name] ?? s.name);
      this._form.addEventListener('value-changed', (ev) => {
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: ev.detail.value }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = [
      { name: 'entity', required: true, selector: { entity: { domain: 'switch' } } },
      { name: 'title', selector: { text: {} } },
      { name: 'step', selector: { number: { min: 1, max: 60, mode: 'box' } } },
    ];
  }
}

// ============================================================================
// Style
// ============================================================================

const STYLE = `<style>
  :host { --wsc-on: var(--state-switch-on-color, var(--state-active-color, var(--primary-color))); }
  ha-card { padding: 12px 14px 10px; position: relative; overflow: hidden; }
  .msg { padding: 8px; color: var(--error-color); }
  .head { display: flex; align-items: center; gap: 10px; }
  .title { flex: 1; font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; cursor: pointer; }
  .seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 16px; overflow: hidden; }
  .seg button { border: 0; background: none; color: var(--secondary-text-color); padding: 4px 12px; }
  .seg button.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .power { min-width: 54px; border: 1px solid var(--divider-color); border-radius: 16px; padding: 4px 10px;
    background: none; color: var(--secondary-text-color); font-weight: 600; }
  .power.on { background: var(--wsc-on); border-color: var(--wsc-on); color: var(--text-primary-color, #fff); }
  .info { display: flex; flex-wrap: wrap; gap: 6px 12px; min-height: 18px; margin: 6px 0 4px; font-size: .85em; color: var(--secondary-text-color); }
  .chip { border-radius: 10px; padding: 0 8px; }
  .chip.warn { background: var(--warning-color, #ff9800); color: #fff; }
  .grid { position: relative; }
  .grid.dim .track { opacity: .45; }
  .hours { position: relative; height: 14px; margin-left: 44px; font-size: .7em; color: var(--secondary-text-color); }
  .hours span { position: absolute; transform: translateX(-50%); }
  .hours span:first-child { transform: none; } .hours span:last-child { transform: translateX(-100%); }
  .row { display: flex; align-items: center; height: 26px; }
  .day { width: 40px; margin-right: 4px; padding: 0; border: 0; background: none; text-align: left;
    color: var(--secondary-text-color); font-size: .85em; }
  .today .day { color: var(--primary-text-color); font-weight: 700; }
  .changed .day::after { content: ' •'; color: var(--primary-color); }
  .bad { color: var(--error-color); font-weight: 700; margin-left: 2px; }
  .track { position: relative; flex: 1; height: 18px; border-radius: 4px; cursor: copy;
    background: repeating-linear-gradient(to right, var(--secondary-background-color, #eee) 0, var(--secondary-background-color, #eee) calc(12.5% - 1px),
      var(--divider-color) calc(12.5% - 1px), var(--divider-color) 12.5%); }
  .block { position: absolute; top: 0; bottom: 0; background: var(--wsc-on); border-radius: 4px; cursor: pointer; min-width: 2px; }
  .block.cont-left { border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .block.cont-right { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .block:hover { filter: brightness(1.15); }
  .marker { position: absolute; top: -3px; bottom: -3px; width: 8px; margin-left: -4px; cursor: pointer; }
  .marker::before { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px; border-radius: 1px; }
  .marker.off::before { background: var(--error-color, #db4437); }
  .marker.on::before { background: var(--success-color, #43a047); }
  .now { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--primary-text-color); opacity: .6; pointer-events: none; }
  .footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: .9em; color: var(--secondary-text-color); }
  .footer span { flex: 1; }
  .err { color: var(--error-color); font-size: .9em; }
  button.main { border: 0; border-radius: 16px; padding: 5px 14px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.main[disabled] { opacity: .5; cursor: default; }
  button.txt { border: 0; background: none; color: var(--primary-color); padding: 5px 8px; }
  button.txt.danger { color: var(--error-color); margin-right: auto; }
  .overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, .35); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .dialog { background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color);
    border-radius: 12px; padding: 14px 16px 10px; width: min(340px, 92%); box-shadow: 0 4px 18px rgba(0, 0, 0, .3); }
  .dtitle { font-weight: 600; margin-bottom: 8px; }
  .dbody label { display: block; font-size: .8em; color: var(--secondary-text-color); margin: 8px 0 3px; }
  .pair { display: flex; gap: 6px; }
  .dbody select, .dbody input[type=time], .dbody input[type=text] { font: inherit; padding: 4px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent); color: var(--primary-text-color); }
  .dbody select { flex: 1; } .dbody input[type=text] { width: 100%; box-sizing: border-box; font-family: monospace; }
  .help { font-size: .75em; color: var(--secondary-text-color); margin: 4px 0; }
  .checks { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .dbody label.chk { display: inline-flex; align-items: center; gap: 3px; margin: 0; font-size: .85em; color: var(--primary-text-color); }
  .dbuttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 4px; margin-top: 12px; }
</style>`;

// ============================================================================
// Registration
// ============================================================================

if (globalThis.customElements && !customElements.get('weekly-schedule-card')) {
  customElements.define('weekly-schedule-card', WeeklyScheduleCard);
  customElements.define('weekly-schedule-card-editor', WeeklyScheduleCardEditor);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'weekly-schedule-card',
    name: 'Weekly Schedule Card',
    description: 'Weekly ON/OFF schedule editor (one "HH:MM/ON HH:MM/OFF" text entity per day)',
    preview: false,
    documentationURL: 'https://github.com/BasicCPPDev/ha-weekly-schedule-card',
  });
}
