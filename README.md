# Weekly Schedule Card

A Home Assistant Lovelace card to **view and edit a weekly ON/OFF schedule** that a device runs by itself, as a
**list of rules, like the Kasa (TP-Link) app**: each rule switches the device ON or OFF at a time, on chosen days
of the week, and can be **disabled without being deleted**.

The schedule is stored in the device as **one text entity per day**:

```
schedule_monday = "07:00/ON 10:30/OFF #03:00/ON"
```

Each time gives the state **from that time on**; before the first change of a day, the state of the previous day
carries on. `#` before a change means **disabled**: the device keeps it but ignores it. The card groups the same
change over several days into one rule, and writes back only the days a change touches.

Written for the **TYZS6 programmable plug** (Tuya TS011F with a custom Zigbee firmware, 1.1.0 or later for the
disabled rules, and a Zigbee2MQTT converter exposing `schedule_<day>`, `mode` and `override`), and usable with any
device that exposes the same per-day texts.

![Weekly Schedule Card](images/screenshot.png)

## Features

- Rules sorted by time: time, ON / OFF, days of the week, and a switch to **enable or disable** the rule.
- **Click a rule** to change its time (to the minute), action and days, or delete it; **Add a rule** below the list.
  Shortcuts: every day, weekdays, weekend.
- Changes are written **at once**, like in the Kasa app; the card checks that the device confirmed them.
- An enabled rule may not switch the other way at the same time as another enabled rule on the same day (refused,
  with the day); disabled rules have no such limit. At most 20 changes per day, disabled ones included.
- Header: ON/OFF button, **Manual / Auto** mode, override badge, next change with its action.
- No external dependency, English and French (follows the language of Home Assistant), light and dark themes.

![Editing a rule](images/dialog.png)

## Installation

### HACS

1. HACS → ⋮ → **Custom repositories** → `https://github.com/BasicCPPDev/ha-weekly-schedule-card`, category
   **Dashboard**.
2. Download **Weekly Schedule Card**, then reload the browser.

### Manual

Copy `ha-weekly-schedule-card.js` to `/config/www/`, then add the resource `/local/ha-weekly-schedule-card.js`
(type **JavaScript module**) in Settings → Dashboards → ⋮ → Resources.

## Configuration

```yaml
type: custom:weekly-schedule-card
entity: switch.prise_programmable
```

| Option | Default | Description |
|---|---|---|
| `entity` | (required) | Switch of the device. |
| `title` | friendly name | Card title. |
| `schedule_entities` | found | `{monday: text.…, …, sunday: text.…}` |
| `mode_entity` | found | `select` with the options `manual` / `auto`. |
| `override_entity` | found | `binary_sensor`, on while a manual change overrides the schedule. |
| `next_change_entity` | found | `sensor` with the next change (`YYYY-MM-DD HH:MM`). |

The other entities are **found automatically** on the same device as `entity` (entity ids ending with
`_schedule_monday` … `_schedule_sunday`, `_mode`, `_override`, `_next_change`), or from the entity name
(`switch.x` → `text.x_schedule_monday`, `select.x_mode`, …). The options above override them.

## Schedule format

- One text per day: changes `HH:MM/ON` or `HH:MM/OFF`, separated by spaces, at most 20 per day; `#` before a change
  = disabled (`#07:00/ON`).
- A change gives the state from that time on; the last enabled change of the week carries on to Monday.
- Order kept by the device (and written by the card): time, then enabled before disabled, then OFF before ON.
- An empty week in auto mode means OFF (on the TYZS6 plug).

## Versions

Versions follow the Home Assistant style: `YYYY.M.D-NN` (date of the release, `NN` = release of the day).
A push to `main` by the owner with `[release]` in the commit message creates the tag and the GitHub release.

## Development

- Tests of the schedule model: `node --test test/`
- Visual test page with a fake `hass` object: serve the repository (`python3 -m http.server`) and open
  `test/demo.html` (`?lang=en|fr`, `&dark=1`, `&mode=manual`, `&override=1`, `&click=rule|add|toggle|conflict`).

## License

MIT, see [LICENSE](LICENSE).
