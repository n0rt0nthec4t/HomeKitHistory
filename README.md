# HomeKitHistory

**Version:** 2026.10.18

`HomeKitHistory` is a shared module for recording accessory history with Homebridge or standalone HAP-NodeJS. Each instance
belongs to one accessory and can expose a selected HAP service through Eve-compatible history and configuration characteristics.

Accessory code supplies sensor readings and state changes. The module handles entry validation, bounded storage, persistence,
queries, CSV export, and Eve protocol encoding. It can be used directly or supplied to `HomeKitDevice` as its history implementation.

---

## Overview

History entries are separated by HAP UUID and service subtype within one accessory store. The default limit is 16,384 entries
across that store; chronological queries follow the ring-buffer order after rollover. Recording and querying history are available
without linking a service to Eve.

The `HomeKitHistory` module provides:

- History recording with per-service field allow-lists, generated timestamps, and restart markers (`addHistory()`)
- Minimum time-gap suppression for each UUID/subtype stream
- Chronological queries, latest entries, and counts (`getHistory()`, `lastHistory()`, `entryCount()`)
- Configurable retention and explicit reset/rollover methods (`resetHistory()`, `rolloverHistory()`)
- Persistence and startup recovery through the supplied HAP runtime's `HAPStorage`
- CSV export with stable columns and escaped values (`generateCSV()`)
- Eve history and configuration overlays for supported HAP services (`linkToEveHome()`, `updateEveHome()`)
- Routed Eve GET/SET messages for device-owned configuration and `HomeKitDevice` integration

Supports Homebridge plugins using `api.hap` and standalone HAP-NodeJS environments.

---

## Requirements

- Node.js 18 or newer with ECMAScript module support
- either Homebridge's API object or the HAP-NodeJS API object
- an accessory with a stable `UUID`; a non-empty `username` is preferred for the persistence key when available

This repository currently ships as a source module rather than an npm package. Import `HomeKitHistory.js` from its installed or
vendored location.

---

## Construction

Construct one instance for the accessory, then record snapshots for its services:

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

---

## HomeKitDevice Integration

`HomeKitHistory` is designed to be supplied to `HomeKitDevice` as its Eve history implementation:

```js
import HomeKitDevice from './HomeKitDevice.js';
import HomeKitHistory from './HomeKitHistory.js';

HomeKitDevice.EVEHOME = HomeKitHistory;
```

Pass `enableHistory: true` to the device's `add()` options to create its history instance. Supply Eve options through
`addService(serviceType, name, subtype, eveOptions)` to select the service to expose to Eve. HomeKitDevice links that service
after `onAdd()` completes and routes Eve configuration reads and writes through `HomeKitHistory.GET` and `HomeKitHistory.SET`.
Only one service can be linked to Eve for each history instance.

Inside a HomeKitDevice subclass, use its `history()` wrapper:

```js
await this.history(this.motionService, {
  status: 1,
}, {
  timegap: 60,
});
```

HomeKitDevice filters unchanged entries unless `force: true` is supplied. HomeKitHistory applies the time gap and returns whether
it retained the entry; HomeKitDevice then invokes `onHistory()` and registered handlers only for accepted entries.

`HomeKitHistory.EVE_OPTIONS` is the shared symbol used to attach temporary Eve options to a service. Applications using
HomeKitHistory directly can call `addHistory()` and `linkToEveHome()` without the HomeKitDevice lifecycle.

---

## Recording History

### `addHistory(target, entry, timegap?)`

Validates and stores an entry for a supported HAP service or characteristic.

Returns `true` when an entry is added to in-memory history and `false` when it is rejected or suppressed by `timegap`.
Persistence errors are logged; an accepted in-memory entry still returns `true`. This lets `HomeKitDevice` notify history
hooks only when an entry was actually recorded.

```js
history.addHistory(temperatureService, {
  temperature: 21.7,
  humidity: 48,
});
```

- `target` must have a string `UUID`.
- `entry` must contain the required fields for that target type.
- `entry.time` defaults to the current Unix timestamp in seconds unless it is a finite number.
- a missing service subtype is normalised to `0`.
- LeakSensor and WaterLevel entries and queries use subtype `0`, including service-instance queries.
- unknown entry fields are discarded.
- nested values are copied before storage; snapshots containing uncloneable values are ignored.
- the first valid entry after process start receives a `restart` timestamp.
- `timegap` suppresses a new entry when the previous entry for the same UUID/subtype is too recent. Restart entries are never
  suppressed. Non-numeric, infinite, and negative gaps are treated as zero.

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

---

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
is not mutated. Returned records and nested values are detached snapshots; changing them does not alter retained history.

### `lastHistory(service, subtype?)`

Returns the latest matching entry, or `undefined` when none exists.

### `entryCount(service, subtype?, specificKey?)`

Returns the number of matching entries.

### `resetHistory()`

Clears all history, resets ring-buffer metadata, cancels any active Eve transfer, and immediately persists the empty store.

### `rolloverHistory()`

Moves the write pointer to the start of the bounded history array, records the rollover time, rebuilds type metadata, and persists
the result. Normal writes invoke this automatically when `maxEntries` is reached.

### `generateCSV(service, csvfile)`

Writes all subtypes for the requested service to a CSV file. The exporter builds a stable union of value columns, escapes commas,
quotes, and line breaks, and formats timestamps in the host's local timezone. It returns the writable stream so callers can observe
`finish` and `error`. An invalid destination filename or an empty matching history returns `undefined`; filesystem failures are
emitted through the returned stream.

---

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
writes. GET updates are merged with retained configuration and committed only after validation and successful encoding;
malformed responses preserve the latest usable configuration. Overlapping partial GET responses preserve unrelated fields;
when they update the same field, the last successfully completed response wins. Initial Thermo/Aqua options are also detached
and validated; an invalid initial configuration logs a warning and uses family defaults. Aqua water usage uses unsigned 64-bit millilitre fields. Invalid
samples and contributions that would overflow the total are omitted from Eve water values while raw history is preserved.
Device-specific options use the existing `EveThermo_*`, `EveMotion_*`, `EveSmoke_*`, `EveAqua_*`,
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
Scaled sensor values that do not fit their Eve fields are omitted from the stream; their raw history values remain available.

### `updateEveHome(service)`

Refreshes dynamic proprietary characteristics for the linked Light Strip, Smoke, Thermo, Aqua, Energy, or Water Guard service.
Calls for an unlinked instance or any service other than the linked service instance are ignored.

---

## Persistence Model

History is stored through `hap.HAPStorage.storage()` under one key per accessory:

- when a non-empty username exists: `History.<USERNAME_WITHOUT_COLONS_AND_UPPERCASED>.json`
- otherwise: `History.<ACCESSORY_UUID>.json`

Persisted data is validated before use. Missing or malformed structures are replaced with a clean store so later writes do not fail
against partial data. Structurally valid but incomplete or stale type indexes are rebuilt from the retained entries. Reducing
`maxEntries` retains the newest records in logical ring order.

Persistence failures are logged while the instance continues to retain history in memory. A `true` result from `addHistory()`
reports in-memory acceptance rather than confirmation of a successful storage write.

---

## Static Constants

| Constant | Description |
| -------- | ----------- |
| `HomeKitHistory.GET` | Eve configuration read message: `HomeKitHistory.onEveGet` |
| `HomeKitHistory.SET` | Eve configuration write message: `HomeKitHistory.onEveSet` |
| `HomeKitHistory.EVE_OPTIONS` | Symbol shared with HomeKitDevice for temporary service-level Eve options |

---

## Versioning

This source module uses code-date versions in `YYYY.MM.DD` format. The version at the top of this README follows the code version
in `HomeKitHistory.js`; notable changes are recorded in `CHANGELOG.md`.

---

## Tests

The test suite uses Node.js's built-in test runner and timer mocks. No test dependencies need to be installed, and the tests do
not start Homebridge or HAP-NodeJS servers:

```sh
node --test HomeKitHistory.test.js
```

To measure coverage:

```sh
node --experimental-test-coverage --test HomeKitHistory.test.js
```

To enforce the current coverage floor:

```sh
node --experimental-test-coverage --test \
  --test-coverage-lines=99.5 \
  --test-coverage-branches=95 \
  --test-coverage-functions=100 \
  HomeKitHistory.test.js
```

The suite and coverage thresholds were verified with Node.js 24.13.1. All 87 tests pass, with no TODOs or skipped tests.
Implementation coverage is 99.65% of lines, 95.91% of branches, and 100% of functions. These measurements do not establish every
input combination or physical device compatibility. Test execution requires Node's timer-mocking APIs; the module's runtime
requirement is listed separately above.

For a fast syntax check of the implementation and tests:

```sh
node --check HomeKitHistory.js
node --check HomeKitHistory.test.js
```

It covers runtime/storage setup, malformed persistence recovery, validation, restart handling, supported fields, time-gap
suppression, subtype queries, rollover ordering, resets, Eve service wiring, descriptor-generated signatures and payloads, TLV
validation and malformed-packet bounds, captured Thermo opcode streams, device-specific configuration encoders, Light Strip and
Water Guard behavior, scaled-field bounds, and public message constants.
Protocol fixtures verify the captured layouts; they do not replace testing against physical Eve devices.

---

## Project Files

- `HomeKitHistory.js` — runtime implementation
- `HomeKitHistory.test.js` — public-behaviour regression suite
- `ARCHITECTURE.md` — data flow, storage model, Eve boundary, and design constraints
- `CHANGELOG.md` — notable changes by release date
- `LICENSE` — Apache License 2.0 terms
- `.prettierrc` — repository formatting rules
- `eslint.config.js` — repository lint rules

---

## Credits

The Eve history protocol implementation builds on the reverse-engineering work in
[fakegato-history](https://github.com/simont77/fakegato-history) and references from `homebridge-lib`'s Eve HomeKit types.
