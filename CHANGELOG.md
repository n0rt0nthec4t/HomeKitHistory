# Change Log

All notable changes to the `HomeKitHistory` module are documented in this file.

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