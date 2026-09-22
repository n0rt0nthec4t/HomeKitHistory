# Change Log

All notable changes to the `HomeKitHistory` module are documented in this file.

## 2026/09/22

### Added

- HomeKit `Lightbulb` services can now be presented as Eve Light Strip, with on/off history and the captured Transitions and
  Power On Behavior configuration protocol.

### Changed

- Eve Thermo retains humidity in its history signature as an intentional extension, preserving existing Eve display behaviour.
- Eve Water Guard configuration encoding now uses the same `util.format()` layout style as the other Eve adapters.

### Fixed

- Eve Thermo Valve Protection writes now decode `0x11` and `0xf2` as separate two-byte commands instead of consuming both
  as one unverified payload.
- Eve Thermo retains its complete ProgramData response when scheduling is disabled and reports that state through command
  `0x13` instead of replacing the response with the standalone `ff04f6` packet.
- Eve Water Guard now queries the same normalised LeakSensor subtype used while recording, preventing an empty history stream
  when the linked LeakSensor was constructed with a subtype.
- Eve Water Guard configuration field `0x4d` now reflects its persisted alarm-test value instead of always returning zero;
  field `0x4e` continues to report the persisted mute state.
- Eve Water Guard's simulated alarm-test timeout now uses the persisted duration directly. That duration defaults to the
  captured 180-second value and can be replaced by a preceding positive `0x4d` command.
- Eve Water Guard now keeps the boolean `alarmtest` state separate from the numeric `alarmtestduration` encoded in field `0x4d`.

## 2026/09/18

### Changed

- LeakSensor's Eve Water Guard adapter now advertises the captured `0x0045` device type, one-byte `0x2d` history field, and
  real-device configuration framing; understood mute and alarm-test writes are also forwarded through the message router.
- Eve Thermo, Aqua, Energy, Smoke, and Water Guard detail reads now share one validated message-router boundary and one
  `evetype`-based GET router while retaining their device-specific encoders.
- `linkToEveHome()` now delegates service setup to focused family linkers and installs common history callbacks separately.
- Blind, Thermo, Smoke, Aqua, and Water Guard SET packet decoders are separated from their service-linking methods.
- Blind, Smoke, and Water Guard now share validated command/length/payload decoding, including truncated-packet protection.
- Aqua configuration writes now use the same validated TLV8 decoder, including nested schedule bounds checks.
- Thermo configuration writes now log the complete decoded `EveProgramCommand` packet at debug level before parsing.
- Common Eve history callbacks are installed while creating the Eve session instead of through a single-use installer method.
- Added JSDoc for the public history API and the main Eve session and command-decoding boundaries.
- Partial Eve detail responses are merged with adapter defaults; invalid responses and router failures preserve the last valid state.

### Fixed

- Corrected the Water Guard configuration terminator and 64-bit last-alarm-test field, and removed its unmatched format placeholder.
- Corrected the Aqua configuration-read layout for its 64-bit total-water, reserved, and flow-rate fields.
- Aqua schedules that cross sunrise or sunset now encode their start and end offsets independently.

## 2026/09/17

### Added

- Comprehensive `README.md` covering setup, supported history shapes, queries, persistence, Eve integration, and testing.
- `ARCHITECTURE.md` documenting runtime detection, history flow, ring-buffer ordering, storage, and the Eve protocol boundary.
- Node test suite covering storage setup and recovery, validation, restart handling, field filtering, time-gap suppression, subtype
  queries, rollover behavior, resets, Eve service wiring, and public constants.
- History recording support for `ContactSensor` and `Door`, matching their existing Eve door integration.
- History recording and Eve on/off presentation support for `Switch` services.

### Changed

- Expanded the source header and lifecycle, persistence, descriptor, and Eve protocol comments.
- `getHistory()` now infers subtype from a service instance and no longer mutates caller-supplied filters.
- Fan, Fanv2, and HumidifierDehumidifier entries now retain their documented optional `temperature` and `humidity` fields.
- Invalid `maxEntries` values are ignored; valid values must be non-negative integers.
- Persisted history is structurally validated before use.
- History reset, rollover, and insertion now replace state snapshots instead of mutating persisted arrays in place.
- Eve adapters now share one session-state builder instead of duplicating history count and reference-time setup.
- Eve history packets are now generated from ordered field descriptors while `evetype` remains the emulated device identity.
- Outlet history accepts independent power and on/off samples for the combined Energy profile.
- `addHistory()` no longer mutates caller-owned target or entry objects.
- `generateCSV()` now uses the union of history columns, escapes CSV values, and returns its writable stream.
- Partial logger implementations are accepted, and storage read/write failures degrade to in-memory history with diagnostics.
- Replaced deprecated substring extraction with equivalent `slice()` ranges throughout Eve packet parsing.

### Fixed

- Corrected the `EveVOCLevel` UUID to `E863F10B-079E-48FF-8F27-9C2605A29F52`.
- Invalid entries no longer consume the one-time process restart marker.
- History type rebuilding now includes an entry stored at index `0`.
- Overwritten subtype metadata is removed using both UUID and subtype identity.
- Corrected the `EveMotion_sensitivity` and `EveThermo_vacationtemp` option mappings.
- Aqua program parsing no longer shadows the schedule accumulator.
- Public history and Eve methods now safely reject `null` and array inputs.

## 2025/07/24

### Added

- **LockMechanism, service support** in `addHistory()`:
  - Tracks `status`

## 2025/06/28

### Added

- Support for `HomeKitDevice.HISTORY.GET` and `.SET` message types for EveHome-compatible communication.
- Added static constants:
  - `HomeKitHistory.GET` and `HomeKitHistory.SET` to identify routed EveHome read/write requests.
  - `HomeKitHistory.EVE_OPTIONS` Symbol for tagging Eve-linked services.
- Support for dynamic `.messages()` routing via `linkToEveHome(...)` options (e.g., `{ message: this.message.bind(this) }`).

### Changed

- Replaced legacy `getcommand`/`setcommand` handler options with routed message architecture.
- `linkToEveHome()` now defers message handling to device-provided `message()` router via options.

### Fixed

- Ensured `await` support in `updateCharacteristic(..., await this.#xxxx)` via inline Promise resolution.

## 2025/06/17

### Added

- **Fan and Fanv2 service support** in `addHistory()`:
  - Tracks `status`, `temperature`, and `humidity`.
- **Dehumidifier service support** in `addHistory()`:
  - Tracks `status`, `temperature`, and `humidity`.
- **Input validation** in `addHistory()`:
  - Verifies `service.UUID` is a string and `entry` is a valid object before processing.
- **Invalid history type cleanup** in `#addEntry()`:
  - Uses `.filter()` to remove outdated `types[]` entries after rollover or pruning.
- **Safe numeric validation** for `timegap` comparison:
  - Ensures last entry's timestamp is a valid number with `isNaN(...) === false`.

### Changed

- **Replaced `switch` with flat `if` blocks** in `addHistory()`:
  - Maintains all original inline documentation and per-service logic.
- **Centralized shared logic** at the top of `addHistory()`:
  - Normalizes `entry.time`, `entry.restart`, `service.subtype`, and `timegap`.
- **Improved clarity and safety in `#addEntry()`**:
  - Explicit `entryIndex` used before incrementing `.next`.
  - Refactored type lookup logic and field assignments with consistent structure.

### Fixed

- **Resolved unsafe `forEach().splice()` pattern** in `#addEntry()`:
  - Replaced with `.filter()` to avoid mutating `types[]` during iteration.
- **Proper handling of `restart` entries**:
  - Ensures `restart` is excluded from timegap filtering and only assigned once.
