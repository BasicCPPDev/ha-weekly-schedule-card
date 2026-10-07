/**
 * Weekly Schedule Card for Home Assistant
 *
 * Shows and edits a weekly ON/OFF schedule as a list of rules, like the Kasa (TP-Link) app: each rule switches
 * the device ON or OFF at a time, on chosen days of the week, and can be disabled without being deleted.
 * The schedule is stored in the device as one text entity per day:
 *   "07:00/ON 10:30/OFF #03:00/ON"      ("#" before a change = disabled: kept but ignored by the device)
 * Each time gives the state FROM that time on; before the first change of a day, the state of the previous day
 * carries on. The device runs the schedule itself; this card only shows and edits it. Written for the TYZS6
 * programmable plug (firmware 1.1.0 or later, Zigbee2MQTT converter prise_tyzs6.js), usable with any device
 * exposing the same per-day texts.
 *
 * No external dependency (plain custom element). Version: VERSION below, "YYYY.M.D-NN" like Home Assistant (NN =
 * release of the day), set by the release workflow.
 */

const VERSION = '2026.10.7-01';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MAX_CHANGES = 20;
const CONFIRM_MS = 15000;

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
    days_letter: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    days_text: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    manual: 'Manual', auto: 'Auto', is_on: 'On', is_off: 'Off',
    auto_locked: 'Auto mode: the device follows the schedule',
    manual_note: 'Manual mode: the schedule is ignored',
    override: 'Manual change until the next change of the schedule', override_chip: 'Override',
    next_change: 'Next change:', none: 'none',
    no_rules: 'No rule yet.', add_rule: 'Add a rule', new_rule: 'New rule', edit_rule: 'Rule',
    time: 'Time', action: 'Action', days_label: 'Days', enabled: 'Enabled',
    every_day: 'Every day', weekdays: 'Weekdays', weekend: 'Weekend',
    delete: 'Delete', cancel: 'Cancel', save: 'Save', add: 'Add',
    saving: 'Saving…', not_confirmed: 'Not confirmed by the device:', disabled_rule: 'Disabled rule',
    err_no_day: 'Choose at least one day', err_time: 'Invalid time',
    err_conflict: 'An enabled rule already switches the other way at this time on',
    err_too_many: 'At most 20 rules per day (disabled ones included):',
    err_unreadable: 'The schedule of this day is unreadable:',
    err_entities: 'Schedule entities not found for', unreadable: 'Unreadable schedule:',
  },
  fr: {
    days: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    days_short: ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'],
    days_letter: ['L', 'M', 'M', 'J', 'V', 'S', 'D'],
    days_text: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'],
    manual: 'Manuel', auto: 'Auto', is_on: 'Allumée', is_off: 'Éteinte',
    auto_locked: 'Mode auto : la prise suit le programme',
    manual_note: 'Mode manuel : le programme est ignoré',
    override: 'Changement manuel jusqu\'au prochain changement du programme', override_chip: 'Forçage',
    next_change: 'Prochain changement :', none: 'aucun',
    no_rules: 'Aucune règle pour l\'instant.', add_rule: 'Ajouter une règle', new_rule: 'Nouvelle règle', edit_rule: 'Règle',
    time: 'Heure', action: 'Action', days_label: 'Jours', enabled: 'Activée',
    every_day: 'Tous les jours', weekdays: 'Semaine', weekend: 'Week-end',
    delete: 'Supprimer', cancel: 'Annuler', save: 'Enregistrer', add: 'Ajouter',
    saving: 'Enregistrement…', not_confirmed: 'Non confirmé par l\'appareil :', disabled_rule: 'Règle désactivée',
    err_no_day: 'Choisissez au moins un jour', err_time: 'Heure invalide',
    err_conflict: 'Une règle activée fait déjà l\'inverse à cette heure le',
    err_too_many: '20 règles par jour au plus (désactivées comprises) :',
    err_unreadable: 'Le programme de ce jour est illisible :',
    err_entities: 'Entités du programme introuvables pour', unreadable: 'Programme illisible :',
  },
};

// ============================================================================
// Model (pure functions, exported for the tests)
// ============================================================================
// A day is a list of changes {m: minute of the day, on, enabled}. A rule groups the same change (time, action,
// enabled) over several days: {m, on, enabled, days: [7 booleans, Monday first]}.

const pad = (n) => String(n).padStart(2, '0');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Order required by the device: minute, then enabled before disabled, then OFF before ON */
const key = (c) => c.m * 4 + (c.enabled ? 0 : 2) + (c.on ? 1 : 0);

const fail = (code, day) => Object.assign(new Error(code), { code, day });

/** Checks a day (sorted): no change twice, one enabled change per minute, at most 20 changes */
function checkDay(list, day) {
  for (let i = 1; i < list.length; i++) {
    if (key(list[i]) === key(list[i - 1])) throw fail('duplicate', day);
    if (list[i].m === list[i - 1].m && list[i].enabled && list[i - 1].enabled) throw fail('conflict', day);
  }
  if (list.length > MAX_CHANGES) throw fail('too_many', day);
}

/** "07:00/ON 9:30/off #03:00/ON" → changes sorted ; throws on an invalid text */
export function parseDay(text, day) {
  const out = [];
  for (const item of String(text ?? '').trim().split(/[\s,;]+/).filter(Boolean)) {
    const r = /^(#?)(\d{1,2}):(\d{2})\/(ON|OFF)$/i.exec(item);
    if (!r || Number(r[2]) > 23 || Number(r[3]) > 59) throw fail('text', day);
    out.push({ m: Number(r[2]) * 60 + Number(r[3]), on: r[4].toUpperCase() === 'ON', enabled: r[1] !== '#' });
  }
  out.sort((a, b) => key(a) - key(b));
  checkDay(out, day);
  return out;
}

/** Changes → text, in the order of the device (as Zigbee2MQTT shows it back) */
export const formatDay = (list) => [...list].sort((a, b) => key(a) - key(b))
  .map((c) => `${c.enabled ? '' : '#'}${fmtMin(c.m)}/${c.on ? 'ON' : 'OFF'}`).join(' ');

/** 7 days → rules sorted by time (enabled first, OFF before ON); an unreadable day (null) is skipped */
export function rulesFromDays(days) {
  const rules = new Map();
  days.forEach((list, d) => (list ?? []).forEach((c) => {
    const k = key(c);
    if (!rules.has(k)) rules.set(k, { m: c.m, on: c.on, enabled: c.enabled, days: Array(7).fill(false) });
    rules.get(k).days[d] = true;
  }));
  return [...rules.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/**
 * Replaces the rule `old` (null: none) by `rule` (null: delete) and returns the new days. A rule equal to another one
 * on a day (same time, action and state) is merged with it. Throws {code, day}: 'no_day', 'conflict' (an enabled
 * change the other way at the same time), 'too_many', 'unreadable' (the rule touches an unreadable day).
 */
export function applyRule(days, old, rule) {
  if (rule && !rule.days.some(Boolean)) throw fail('no_day');
  if (rule && !(Number.isInteger(rule.m) && rule.m >= 0 && rule.m < 1440)) throw fail('time');
  const out = days.map((l) => (l ? l.map((c) => ({ ...c })) : null));
  const touched = new Set();
  if (old) old.days.forEach((sel, i) => { if (sel) touched.add(i); });
  if (rule) rule.days.forEach((sel, i) => { if (sel) touched.add(i); });
  for (const i of touched) {
    if (!out[i]) throw fail('unreadable', i);
    if (old?.days[i]) out[i] = out[i].filter((c) => key(c) !== key(old));
    const c = rule?.days[i] ? { m: rule.m, on: rule.on, enabled: rule.enabled } : null;
    if (c && !out[i].some((x) => key(x) === key(c))) out[i].push(c);
    out[i].sort((a, b) => key(a) - key(b));
    checkDay(out[i], i);
  }
  return out;
}

/** Days whose text changes between two schedules */
export const changedDays = (before, after) =>
  DAYS.map((_, i) => i).filter((i) => after[i] && (!before[i] || formatDay(before[i]) !== formatDay(after[i])));

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
    this._config = { ...config };
    this._writes = new Map();     // day → text written, waiting for the device to confirm it
    this._dialog = null;
    this._render();
  }

  getCardSize() {
    return 2 + Math.ceil(rulesFromDays(this._hass ? this._days() : []).length * 0.7);
  }

  set hass(hass) {
    this._hass = hass;
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._checkWrites();
      if (this._dialog) this._needRender = true;   // do not reset a dialog being filled in
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

  _texts() {
    return this._entities().schedule.map((id) => this._hass.states[id]?.state ?? '');
  }

  /** Days as shown: the device's texts, or the text just written while waiting for the confirmation; null = unreadable */
  _days() {
    return this._texts().map((t, i) => {
      try { return parseDay(this._writes.has(i) ? this._writes.get(i) : t, i); } catch { return null; }
    });
  }

  // --- actions --------------------------------------------------------------

  /** Replaces `old` by `rule` (null: delete) and writes the changed days at once, like the Kasa app */
  _apply(old, rule) {
    const before = this._days();
    const after = applyRule(before, old, rule);
    const ids = this._entities().schedule;
    for (const i of changedDays(before, after)) {
      const value = formatDay(after[i]);
      this._writes.set(i, value);
      this._hass.callService('text', 'set_value', { entity_id: ids[i], value }).catch((err) => {
        this._error = esc(err?.message ?? err);
        this._render();
      });
    }
    this._error = null;
    clearTimeout(this._timer);
    if (this._writes.size) this._timer = setTimeout(() => this._checkWrites(true), CONFIRM_MS);
    this._render();
  }

  _checkWrites(timeout = false) {
    if (!this._writes?.size || !this._hass) return;
    const texts = this._texts();
    for (const [i, value] of this._writes) if (texts[i] === value) this._writes.delete(i);
    if (timeout && this._writes.size) {
      this._error = `${this._t('not_confirmed')} ${[...this._writes.keys()].sort().map((i) => this._t('days_text')[i]).join(', ')}`;
      this._writes.clear();
    }
    if (timeout) this._render();
  }

  _toggle() {
    this._hass.callService('switch', 'toggle', { entity_id: this._config.entity });
  }

  _setMode(mode) {
    const id = this._entities().mode;
    if (id) this._hass.callService('select', 'select_option', { entity_id: id, option: mode });
  }

  _errorText(err) {
    const day = err.day !== undefined ? ` ${this._t('days_text')[err.day]}` : '';
    const msg = { no_day: 'err_no_day', time: 'err_time', conflict: 'err_conflict', too_many: 'err_too_many',
      unreadable: 'err_unreadable', duplicate: 'err_conflict' }[err.code];
    return msg ? `${this._t(msg)}${day}` : esc(err.message);
  }

  // --- rendering ------------------------------------------------------------

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (!this._hass) return;
    const e = this._entities();
    if (e.schedule.some((id) => !id || !this._hass.states[id])) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card><div class="msg">${this._t('err_entities')} ${esc(this._config.entity)}</div></ha-card>`;
      return;
    }
    const st = this._hass.states;
    const sw = st[this._config.entity];
    const on = sw?.state === 'on';
    const mode = e.mode ? st[e.mode]?.state : undefined;
    const override = e.override ? st[e.override]?.state === 'on' : false;
    const title = this._config.title ?? sw?.attributes?.friendly_name ?? this._config.entity;
    const days = this._days();
    this._rules = rulesFromDays(days);
    const letters = this._t('days_letter'), names = this._t('days');

    const unreadable = days.map((d, i) => (d ? null : i)).filter((i) => i !== null);
    const rows = this._rules.map((r, i) => `
      <div class="rule ${r.enabled ? '' : 'disabled'}" data-rule="${i}" title="${r.enabled ? '' : this._t('disabled_rule')}">
        <div class="time">${fmtMin(r.m)}</div>
        <div class="act ${r.on ? 'on' : 'off'}">${r.on ? 'ON' : 'OFF'}</div>
        <div class="days">${letters.map((l, d) => `<span class="${r.days[d] ? 'sel' : ''}" title="${names[d]}">${l}</span>`).join('')}</div>
        <label class="switch" data-toggle="${i}"><input type="checkbox" ${r.enabled ? 'checked' : ''}><span></span></label>
      </div>`).join('');

    const modeCtl = e.mode ? `<div class="seg">
        <button class="${mode === 'manual' ? 'sel' : ''}" data-mode="manual">${this._t('manual')}</button>
        <button class="${mode === 'auto' ? 'sel' : ''}" data-mode="auto">${this._t('auto')}</button></div>` : '';
    const info = [
      mode === 'manual' ? `<span class="note">${this._t('manual_note')}</span>` : '',
      override ? `<span class="chip warn" title="${this._t('override')}">⟲ ${this._t('override_chip')}</span>` : '',
      mode !== 'manual' && e.next ? `<span class="note">${this._t('next_change')} ${this._fmtNext(st[e.next]?.state)}</span>` : '',
    ].join('');
    const status = this._error ? `<div class="status err">${this._error}</div>`
      : this._writes.size ? `<div class="status">${this._t('saving')}</div>` : '';
    const bad = unreadable.length ? `<div class="status err">${this._t('unreadable')} ${unreadable.map((i) => this._t('days_text')[i]).join(', ')}</div>` : '';

    // State of the device, as a switch (its position is the state): usable in manual mode, shown only in auto mode
    const auto = mode === 'auto';
    const power = `<label class="power ${on ? 'on' : ''} ${auto ? 'locked' : ''}" title="${auto ? this._t('auto_locked') : ''}">
        <span>${on ? this._t('is_on') : this._t('is_off')}</span>
        <span class="switch"><input type="checkbox" data-act="toggle" aria-label="${esc(title)}" ${on ? 'checked' : ''}
          ${auto ? 'disabled' : ''}><span></span></span></label>`;

    this.shadowRoot.innerHTML = `${STYLE}<ha-card>
      <div class="head"><div class="title">${esc(title)}</div>${power}</div>
      <div class="info">${modeCtl}${info}</div>
      <div class="rules ${mode === 'manual' ? 'dim' : ''}">${rows || `<div class="empty">${this._t('no_rules')}</div>`}</div>
      ${bad}${status}
      <div class="foot"><button class="txt" data-act="add">+ ${this._t('add_rule')}</button></div>
      <div class="dialog-host"></div>
    </ha-card>`;
    this._bind();
    if (this._dialog) this._renderDialog();
  }

  /** "2026-10-08 07:00" → "jeu. 07:00 ON" (action of the enabled rule at that time) */
  _fmtNext(v) {
    const r = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(v ?? '');
    if (!r) return this._t('none');
    const day = (new Date(Number(r[1]), Number(r[2]) - 1, Number(r[3])).getDay() + 6) % 7;
    const m = Number(r[4]) * 60 + Number(r[5]);
    const rule = this._rules?.find((x) => x.enabled && x.m === m && x.days[day]);
    const act = rule ? ` <span class="act small ${rule.on ? 'on' : 'off'}">${rule.on ? 'ON' : 'OFF'}</span>` : '';
    return `${this._t('days_short')[day]} ${r[4]}:${r[5]}${act}`;
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this._setMode(b.dataset.mode)));
    root.querySelector('[data-act="toggle"]')?.addEventListener('click', (ev) => {
      ev.preventDefault();         // the switch moves when the device confirms its new state
      this._toggle();
    });
    root.querySelector('[data-act="add"]')?.addEventListener('click', () => this._open(null));
    root.querySelectorAll('[data-rule]').forEach((row) => row.addEventListener('click', (ev) => {
      const rule = this._rules[Number(row.dataset.rule)];
      if (ev.target.closest('[data-toggle]')) {
        if (ev.target.tagName !== 'INPUT') return;   // the click on the label comes back on the input
        ev.preventDefault();
        try { this._apply(rule, { ...rule, enabled: !rule.enabled }); } catch (err) { this._error = this._errorText(err); this._render(); }
        return;
      }
      this._open(rule);
    }));
  }

  // --- dialog ---------------------------------------------------------------

  _open(rule) {
    const now = new Date();
    this._dialog = {
      old: rule,
      form: rule ? { ...rule, days: [...rule.days] }
        : { m: now.getHours() * 60, on: true, enabled: true, days: Array(7).fill(true) },
      error: null,
    };
    this._renderDialog();
  }

  _close() {
    this._dialog = null;
    this.shadowRoot.querySelector('.dialog-host').innerHTML = '';
    this.shadowRoot.querySelector('ha-card')?.classList.remove('open');
    if (this._needRender) { this._needRender = false; this._render(); }
  }

  _renderDialog() {
    const host = this.shadowRoot.querySelector('.dialog-host');
    const { old, form, error } = this._dialog;
    this.shadowRoot.querySelector('ha-card').classList.add('open');   // room for the dialog, even with few rules
    const presets = [['every_day', [0, 1, 2, 3, 4, 5, 6]], ['weekdays', [0, 1, 2, 3, 4]], ['weekend', [5, 6]]];
    host.innerHTML = `<div class="overlay"><div class="dialog" role="dialog" aria-label="${old ? this._t('edit_rule') : this._t('new_rule')}">
        <div class="dtitle">${old ? this._t('edit_rule') : this._t('new_rule')}</div>
        <div class="dbody">
          <div class="line">
            <input type="time" name="time" step="60" value="${fmtMin(form.m)}">
            <div class="seg big">
              <button class="${form.on ? 'sel' : ''}" data-on="1">ON</button>
              <button class="${form.on ? '' : 'sel'}" data-on="0">OFF</button></div>
          </div>
          <label class="lbl">${this._t('days_label')}</label>
          <div class="daypick">${this._t('days_letter').map((l, d) =>
            `<button class="${form.days[d] ? 'sel' : ''}" data-day="${d}" title="${this._t('days')[d]}">${l}</button>`).join('')}</div>
          <div class="presets">${presets.map(([k, list]) => `<button class="txt" data-preset="${list.join('')}">${this._t(k)}</button>`).join('')}</div>
          <label class="line toggle">${this._t('enabled')}
            <span class="switch"><input type="checkbox" name="enabled" ${form.enabled ? 'checked' : ''}><span></span></span></label>
        </div>
        ${error ? `<div class="err">${error}</div>` : ''}
        <div class="dbuttons">
          ${old ? `<button class="txt danger" data-dlg="delete">${this._t('delete')}</button>` : ''}
          <button class="txt" data-dlg="close">${this._t('cancel')}</button>
          <button class="main" data-dlg="ok">${old ? this._t('save') : this._t('add')}</button>
        </div></div></div>`;
    const overlay = host.querySelector('.overlay');
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) this._close(); });
    overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') this._close(); });
    const keep = () => {           // keeps what was typed before redrawing the dialog
      const t = host.querySelector('[name="time"]').value;
      const r = /^(\d{1,2}):(\d{2})/.exec(t);
      form.m = r ? Number(r[1]) * 60 + Number(r[2]) : NaN;
      form.enabled = host.querySelector('[name="enabled"]').checked;
    };
    host.querySelectorAll('[data-on]').forEach((b) => b.addEventListener('click', () => { keep(); form.on = b.dataset.on === '1'; this._renderDialog(); }));
    host.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      keep(); form.days[Number(b.dataset.day)] = !form.days[Number(b.dataset.day)]; this._renderDialog();
    }));
    host.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      keep(); form.days = form.days.map((_, d) => b.dataset.preset.includes(String(d))); this._renderDialog();
    }));
    host.querySelectorAll('[data-dlg]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.dlg === 'close') return this._close();
      keep();
      try {
        this._apply(old, b.dataset.dlg === 'delete' ? null : { ...form });
        this._dialog = null;
        this._needRender = false;
        this._render();
      } catch (err) {
        this._dialog.error = this._errorText(err);
        this._renderDialog();
      }
    }));
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
      this._form.computeLabel = (s) => ({ entity: 'Switch of the device', title: 'Title' }[s.name] ?? s.name);
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
    ];
  }
}

// ============================================================================
// Style
// ============================================================================

const STYLE = `<style>
  :host { --wsc-on: var(--state-switch-on-color, var(--state-active-color, var(--primary-color)));
    --wsc-green: var(--success-color, #43a047); --wsc-red: var(--error-color, #db4437); }
  ha-card { padding: 12px 14px 6px; position: relative; overflow: hidden; }
  ha-card.open { min-height: 340px; }
  .msg { padding: 8px; color: var(--error-color); }
  .head { display: flex; align-items: center; gap: 10px; }
  .title { flex: 1; font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; cursor: pointer; }
  .seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 16px; overflow: hidden; flex: none; }
  .seg button { border: 0; background: none; color: var(--secondary-text-color); padding: 4px 12px; }
  .seg button.sel { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .power { display: inline-flex; align-items: center; gap: 8px; flex: none; color: var(--secondary-text-color); cursor: pointer; }
  .power.on { color: var(--primary-text-color); font-weight: 500; }
  .power.locked { cursor: default; }
  .power .switch input:checked + span { background: var(--wsc-on); }
  .info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-height: 18px; margin: 8px 0 10px; font-size: .85em; color: var(--secondary-text-color); }
  .info .seg { font-size: 1.1em; }
  .chip { border-radius: 10px; padding: 0 8px; }
  .chip.warn { background: var(--warning-color, #ff9800); color: #fff; }
  .rules { margin: 0 -14px; border-bottom: 1px solid var(--divider-color); }
  .rules.dim .rule { opacity: .6; }
  .empty { padding: 14px; color: var(--secondary-text-color); font-size: .9em; border-top: 1px solid var(--divider-color); }
  .rule { display: flex; align-items: center; gap: 12px; padding: 9px 14px; border-top: 1px solid var(--divider-color); cursor: pointer; }
  .rule:hover { background: var(--secondary-background-color); }
  .rule .time { font-size: 1.4em; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--primary-text-color); min-width: 3.1em; }
  .act { flex: none; font-size: .72em; font-weight: 700; letter-spacing: .03em; border-radius: 10px; padding: 1px 0; width: 3.4em;
    text-align: center; color: #fff; }
  .act.on { background: var(--wsc-green); } .act.off { background: var(--wsc-red); }
  .act.small { display: inline-block; width: auto; padding: 0 6px; font-size: .8em; vertical-align: 1px; }
  .days { flex: 1; display: flex; gap: 2px; min-width: 0; }
  .days span { width: 1.75em; line-height: 1.75em; text-align: center; border-radius: 50%; font-size: .8em; color: var(--secondary-text-color); opacity: .4; }
  .days span.sel { opacity: 1; font-weight: 600; color: var(--primary-color);
    background: rgba(var(--rgb-primary-color, 3, 169, 244), .14); }
  .rule.disabled .time, .rule.disabled .act, .rule.disabled .days { opacity: .38; }
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 1; }
  .switch span { position: absolute; inset: 0; border-radius: 10px; background: var(--disabled-color, #bdbdbd); transition: background .15s; }
  .switch span::before { content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .35); transition: transform .15s; }
  .switch input:checked + span { background: var(--primary-color); }
  .switch input:checked + span::before { transform: translateX(16px); }
  .switch input:disabled { cursor: default; }
  .switch input:disabled + span { opacity: .5; }
  .status { margin: 8px 0 0; font-size: .85em; color: var(--secondary-text-color); }
  .err { color: var(--error-color); font-size: .9em; }
  .foot { display: flex; justify-content: flex-end; margin-top: 4px; }
  button.main { border: 0; border-radius: 16px; padding: 5px 14px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.txt { border: 0; background: none; color: var(--primary-color); padding: 6px 8px; }
  button.txt.danger { color: var(--error-color); margin-right: auto; }
  .overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, .35); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .dialog { background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color);
    border-radius: 12px; padding: 14px 16px 10px; width: min(340px, 92%); box-shadow: 0 4px 18px rgba(0, 0, 0, .3); }
  .dtitle { font-weight: 600; margin-bottom: 10px; }
  .line { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .dbody input[type=time] { font: inherit; font-size: 1.5em; padding: 2px 6px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--secondary-background-color, transparent); color: var(--primary-text-color); }
  .seg.big button { padding: 6px 16px; font-weight: 600; }
  .seg.big button.sel[data-on="1"] { background: var(--wsc-green); } .seg.big button.sel[data-on="0"] { background: var(--wsc-red); }
  .lbl { display: block; font-size: .8em; color: var(--secondary-text-color); margin: 12px 0 5px; }
  .daypick { display: flex; justify-content: space-between; }
  .daypick button { width: 2.3em; height: 2.3em; border-radius: 50%; border: 1px solid var(--divider-color); background: none;
    color: var(--secondary-text-color); padding: 0; }
  .daypick button.sel { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 600; }
  .presets { display: flex; gap: 2px; margin: 2px -8px 0; }
  .presets button { font-size: .85em; }
  .toggle { margin-top: 8px; font-size: .95em; cursor: pointer; }
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
    description: 'Weekly ON/OFF schedule as a list of rules, like the Kasa app (one "HH:MM/ON HH:MM/OFF" text entity per day)',
    preview: false,
    documentationURL: 'https://github.com/BasicCPPDev/ha-weekly-schedule-card',
  });
}
