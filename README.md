# HomeKitHistory

Persistent history storage and Eve app protocol support for accessories built with Homebridge or standalone HAP-NodeJS.

`HomeKitHistory` records a bounded, per-accessory stream of sensor and actuator events, restores it through HAP storage, supports
filtered queries and CSV export, and can expose one selected service through Eve-compatible history characteristics.

## Features

- Homebridge and standalone HAP-NodeJS runtime detection
- persistent history using `HAPStorage`
- configurable rolling history, with 16,384 entries by default
- independent histories by HAP UUID and service subtype
- entry validation and per-service field allow-lists
- minimum time-gap suppression for noisy sensors
- chronological queries across a rolled-over ring buffer
- last-entry and count helpers
- CSV export
- Eve custom characteristics and services
- Eve history overlays for doors, switches, lights, climate, room, motion, irrigation, energy, smoke, leak, and weather accessories
- routed Eve GET/SET messages for integration with `HomeKitDevice`

## Requirements

- Node.js 18 or newer with ECMAScript module support
- either Homebridge's API object or the HAP-NodeJS API object
- an accessory with a stable `UUID`; a non-empty `username` is preferred for the persistence key when available

This repository currently ships as a source module rather than an npm package. Import `HomeKitHistory.js` from its installed or
vendored location.

## Quick Start

```js
import HomeKitHistory from './HomeKitHistory.js';

let history = new HomeKitHistory(accessory, api, log, {
  maxEntries: 16384,
});

history.addHistory(motionService, {
  status: 1,
  time: Math.floor(Date.now() / 1000),
});

let latestMotion = history.lastHistory(motionService);
```

The constructor accepts:

| Argument             | Description                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `accessory`          | Homebridge or HAP-NodeJS accessory associated with this history store                                      |
| `api`                | Homebridge API (`api.hap`) or the HAP-NodeJS API itself                                                    |
| `log`                | Optional partial or complete logger providing `info`, `success`, `warn`, `error`, and/or `debug` functions |
| `options.maxEntries` | Non-negative integer entry limit; `0` disables automatic rollover                                          |

If no valid HAP API can be detected, construction logs an error when possible and leaves the instance inactive.

## HomeKitDevice Integration

`HomeKitHistory` is designed to be supplied to `HomeKitDevice` as its Eve history implementation:

```js
import HomeKitDevice from './HomeKitDevice.js';
import HomeKitHistory from './HomeKitHistory.js';

HomeKitDevice.EVEHOME = HomeKitHistory;
```

When a device adds a service with Eve options, `HomeKitDevice` can create the history instance and call `linkToEveHome()` for that
service. Eve-originated configuration reads and writes are routed through these stable message names:

```js
HomeKitHistory.GET; // 'HomeKitHistory.onEveGet'
HomeKitHistory.SET; // 'HomeKitHistory.onEveSet'
```

`HomeKitHistory.EVE_OPTIONS` is the shared symbol used to attach temporary Eve options to a service.

## Recording History

### `addHistory(target, entry, timegap?)`

Validates and stores an entry for a supported HAP service or characteristic.

```js
history.addHistory(temperatureService, {
  temperature: 21.7,
  humidity: 48,
});
```

- `target` must have a string `UUID`.
- `entry` must contain the required fields for that target type.
- `entry.time` defaults to the current Unix timestamp in seconds.
- a missing service subtype is normalised to `0`.
- unknown entry fields are discarded.
- the first valid entry after process start receives a `restart` timestamp.
- `timegap` suppresses a new entry when the previous entry for the same UUID/subtype is too recent. Restart entries are never
  suppressed.

### Supported Entry Shapes

| HAP target                                                                     | Required fields                               | Optional/defaulted fields                               |
| ------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------- |
| `ContactSensor`, `Door`, `GarageDoorOpener`, `LockMechanism`                   | `status`                                      | —                                                       |
| `Fan`, `Fanv2`, `HumidifierDehumidifier`                                       | `status`                                      | `temperature`, `humidity`                               |
| `MotionSensor`, `Switch`, `Lightbulb`, `LeakSensor`, `Doorbell`, `SmokeSensor` | `status`                                      | —                                                       |
| `Window`, `WindowCovering`                                                     | `status`, `position`                          | —                                                       |
| `HeaterCooler`, `Thermostat`                                                   | `status`, `temperature`, `target`, `humidity` | —                                                       |
| `TemperatureSensor`, `AirQualitySensor`, `EveAirPressureSensor`                | `temperature`                                 | `humidity`, `ppm`, `voc`, and `pressure` default to `0` |
| `Valve`                                                                        | `status`, `water`, `duration`                 | —                                                       |
| `WaterLevel` characteristic                                                    | `level`                                       | —                                                       |
| `Outlet`                                                                       | at least one of `status` or `watts`           | `volts`, `amps`                                         |

Common status conventions are `0` for inactive/closed/clear and `1` for active/open/detected. Heater/cooler entries use `0` for
off, `1` for cooling, and `2` for heating. The `target` climate field is an object with `low` and `high` values.

Switch and Lightbulb history is event-driven: record an entry whenever the on/off state changes. This module does not generate
periodic filler entries, so callers that require continuous Eve graph coverage can also record the current state on their own
interval.

## Querying History

### `getHistory(service, subtype?, specificKey?)`

Returns matching entries in chronological order, including after rollover.

```js
let thisService = history.getHistory(motionService);
let allMotionServices = history.getHistory(api.hap.Service.MotionSensor.UUID, null);
let detectedOnly = history.getHistory(motionService, undefined, { status: 1 });
```

`service` may be a UUID string, a HAP service type, or a service instance. When a service instance is supplied and `subtype` is
omitted, its subtype is inferred. Pass `null` explicitly to include every subtype. `specificKey` is an exact-match field filter and
is not mutated.

### `lastHistory(service, subtype?)`

Returns the latest matching entry, or `undefined` when none exists.

### `entryCount(service, subtype?, specificKey?)`

Returns the number of matching entries.

### `resetHistory()`

Clears all history, resets ring-buffer metadata, and immediately persists the empty store.

### `rolloverHistory()`

Moves the write pointer to the start of the bounded history array, records the rollover time, rebuilds type metadata, and persists
the result. Normal writes invoke this automatically when `maxEntries` is reached.

### `generateCSV(service, csvfile)`

Writes all subtypes for the requested service to a CSV file. The exporter builds a stable union of value columns, escapes commas,
quotes, and line breaks, and formats timestamps in the host's local timezone. It returns the writable stream so callers can observe
`finish` and `error`. Invalid arguments or an empty matching history return `undefined`; filesystem failures are emitted through the
returned stream.

## Eve App Integration

### `linkToEveHome(service, options?)`

Adds the Eve history service and the characteristics appropriate for the supplied HAP service. Only one service can be linked per
`HomeKitHistory` instance. The method resolves to the Eve history service when linking succeeds, otherwise `undefined`.

```js
await history.linkToEveHome(thermostatService, {
  EveThermo_firmware: 1251,
  EveThermo_tempoffset: -2.5,
  messages: async (type, payload) => device.message(type, payload),
});
```

Supported overlays include:

| HAP service                                                            | Eve presentation                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ContactSensor`, `Door`, `Window`, `GarageDoorOpener`, `LockMechanism` | Door/contact                                                    |
| `WindowCovering`                                                       | MotionBlinds                                                    |
| `HeaterCooler`, `Thermostat`                                           | Thermo                                                          |
| `EveAirPressureSensor`                                                 | Weather                                                         |
| `AirQualitySensor`, `TemperatureSensor`                                | Room                                                            |
| `MotionSensor`                                                         | Motion                                                          |
| `Switch`                                                               | Light Switch on/off history                                     |
| `Lightbulb`                                                            | Light Strip on/off history, transitions, and power-on behaviour |
| `SmokeSensor`                                                          | Smoke                                                           |
| `Valve`, `IrrigationSystem`                                            | Aqua                                                            |
| `Outlet`                                                               | Energy                                                          |
| `LeakSensor`                                                           | Water Guard                                                     |

The `messages` callback lets the owning device supply current persisted configuration for Eve reads and receive processed Eve
writes. Device-specific options use the existing `EveThermo_*`, `EveMotion_*`, `EveSmoke_*`, `EveAqua_*`,
`EveLightStrip_*`, and `EveWaterGuard_*` names in `HomeKitHistory.js`. Light Strip accepts transition values `quick`, `default`,
`moderate`, or `calm`; power-on behaviour is `1` for the last-used colour or `2` for default white.

Some reverse-engineered Eve protocol areas remain incomplete:

- MotionBlinds and Smoke history payload values are not fully decoded.
- Thermo's `EveProgramCommand` is an opcode stream with opcode-specific payload widths rather than TLV8. Captured schedule,
  temperature-offset, and valve-protection packets are decoded, but valve-protection semantics remain incomplete.
- Water Guard uses the captured one-byte `0x2d` leak-status field and returns the last alarm-test time through configuration field
  `0x86`. Any distinct alarm-test history record remains unknown, and Eve currently omits encoded Safe transitions from its Events
  view.
- Eve exposes Light Strip schedule controls, but their enable state and program TLVs remain unknown. Colour-history fields are also
  unverified, so the Light Strip adapter currently records only on/off history.

These limitations affect Eve-specific presentation, not local history storage and queries.

Eve history layouts are assembled from ordered field descriptors. Each descriptor owns its Eve tag, byte width, source lookup,
conversion, and binary writer. `evetype` remains the identity of the Eve device family being emulated; it is also consumed by
`HomeKitDevice` for setup reporting. The descriptor list independently controls the advertised signature and per-entry field mask.
This allows combination profiles such as Energy to store periodic `watts` samples and event-driven `status` changes separately.

### `updateEveHome(service)`

Refreshes dynamic proprietary characteristics for linked Light Strip, Smoke, Thermo, Aqua, and Energy services. Calls for an
unlinked instance or an unsupported service are ignored.

## Persistence Model

History is stored through `hap.HAPStorage.storage()` under one key per accessory:

- when a non-empty username exists: `History.<USERNAME_WITHOUT_COLONS_AND_UPPERCASED>.json`
- otherwise: `History.<ACCESSORY_UUID>.json`

Persisted data is validated before use. Missing or malformed structures are replaced with a clean store so later writes do not fail
against partial data.

## Testing

The test suite uses Node's built-in test runner and does not need Homebridge or HAP-NodeJS:

```sh
node --test HomeKitHistory.test.js
```

For a fast syntax check of the implementation and tests:

```sh
node --check HomeKitHistory.js
node --check HomeKitHistory.test.js
```

It covers runtime/storage setup, malformed persistence recovery, validation, restart handling, supported fields, time-gap
suppression, subtype queries, rollover ordering, resets, Eve service wiring, descriptor-generated signatures and payloads, TLV
validation and malformed-packet bounds, captured Thermo opcode streams, device-specific configuration encoders, Light Strip and
Water Guard behavior, and public message constants.

## Project Files

- `HomeKitHistory.js` — runtime implementation
- `HomeKitHistory.test.js` — public-behaviour regression suite
- `ARCHITECTURE.md` — data flow, storage model, Eve boundary, and design constraints
- `CHANGELOG.md` — notable changes by release date
- `LICENSE` — Apache License 2.0 terms
- `.prettierrc` — repository formatting rules
- `eslint.config.js` — repository lint rules

## Credits

The Eve history protocol implementation builds on the reverse-engineering work in
[fakegato-history](https://github.com/simont77/fakegato-history) and references from `homebridge-lib`'s Eve HomeKit types.
