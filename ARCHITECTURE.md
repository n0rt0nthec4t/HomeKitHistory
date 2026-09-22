# HomeKitHistory Architecture

## Overview

`HomeKitHistory` is a per-accessory history and Eve protocol adapter. It sits beside a Homebridge or standalone HAP-NodeJS
accessory, converts supported service events into a small persisted schema, and optionally projects one history stream through
Eve's proprietary HAP characteristics.

**Version:** 2026.09.22  
**Primary module:** `HomeKitHistory.js`  
**Consumers:** `HomeKitDevice`, Homebridge accessory implementations, and standalone HAP-NodeJS accessories

## Position in the System

```text
┌──────────────────────────────────────────────────────────┐
│ Homebridge or standalone HAP-NodeJS                      │
│ HAP API · accessory · HAPStorage                         │
└──────────────────────────┬───────────────────────────────┘
                           │ constructor dependencies
                  ┌────────▼─────────┐
device events ───►│ HomeKitHistory   │◄─── Eve reads/writes
                  ├──────────────────┤
local queries ◄───│ validation       │───► custom HAP types
CSV export   ◄────│ ring buffer      │───► Eve history stream
                  │ protocol adapter │
                  └────────┬─────────┘
                           │ getItem / setItem
                  ┌────────▼─────────┐
                  │ HAPStorage       │
                  │ History.*.json   │
                  └──────────────────┘
```

The module has two related but separable responsibilities:

1. record and query local accessory history;
2. translate selected history and configuration into Eve's proprietary protocol.

Local history works without linking a service to Eve. Eve integration uses the same stored entries rather than maintaining a
second event store.

## Runtime Detection and Construction

The constructor signature is:

```js
new HomeKitHistory(accessory, api, log, options);
```

The API boundary supports two shapes:

- **Homebridge** — `api.version` is numeric, `api.hap` is an object, and `api.HAPLibraryVersion` is absent. `this.hap` becomes
  `api.hap`.
- **HAP-NodeJS** — `api.HAPLibraryVersion` is a function, while `api.version` and `api.hap` are absent. `this.hap` becomes `api`.

Construction then:

```text
detect HAP runtime
        │
        ├─ invalid ──► log error and leave inactive
        │
        ▼
capture accessory and validated options
        │
        ▼
derive per-accessory persistence key
        │
        ▼
load and validate persisted structure
        │
        ├─ invalid ──► reset to an empty persisted structure
        │
        ▼
roll over if the configured bound was already reached
        │
        ▼
register missing Eve and weather HAP types on the runtime
```

Custom characteristics and services are added only when the HAP API does not already provide them. This makes multiple
`HomeKitHistory` instances share one runtime safely without redefining classes.

## History Data Model

The persisted object has this shape:

```js
{
  reset: 1720000000,
  rollover: 0,
  next: 2,
  types: [
    { type: 'service-uuid', sub: 0, lastEntry: 1 },
  ],
  data: [
    { time: 1720000000, type: 'service-uuid', sub: 0, status: 0 },
    { time: 1720000060, type: 'service-uuid', sub: 0, status: 1 },
  ],
}
```

### Metadata

- `reset` — Unix timestamp when the store was created or explicitly reset.
- `rollover` — Unix timestamp of the most recent rollover, or `0` before the first rollover.
- `next` — array index where the next entry will be written.
- `types` — latest-entry index for each UUID/subtype pair; used by time-gap checks.
- `data` — bounded event array.

The startup validator requires numeric timestamps, a non-negative integer `next`, array-backed `types` and `data`, and a write
pointer inside the current data bounds. A rejected structure is not partially repaired; it is replaced by the known empty schema.

### Entry Identity

An event stream is identified by:

```text
HAP target UUID + service subtype
```

This allows multiple instances of the same service type—such as several motion sensors or irrigation valves—to share one
accessory history store without mixing their last-entry metadata.

## Write Flow

`addHistory(target, entry, timegap)` is the only public event-write path.

```text
validate target, entry, and HAP capabilities
        │
        ▼
look up metadata by target UUID
        │ unsupported
        ├────────────► ignore
        │
        ▼
validate all required fields
        │ invalid
        ├────────────► ignore without consuming restart marker
        │
        ▼
add first-valid-entry restart marker and default timestamp/subtype
        │
        ▼
apply default fields and copy only allowed fields
        │
        ▼
check minimum time gap against types[].lastEntry
        │ too soon and not a restart
        ├────────────► ignore
        │
        ▼
roll over when next reaches maxEntries
        │
        ▼
write data[next], advance next, update types, persist
```

Per-service metadata is the authoritative definition of required, optional, and defaulted fields. Entry filtering prevents caller
objects from injecting internal `time`, `type`, or `sub` metadata and keeps persisted records predictable.

Generated timestamps, restart markers, defaults, and normalised subtypes are applied only to the stored record. Caller-owned target
and entry objects are not mutated.

## Ring Buffer and Ordering

The default maximum is 16,384 entries. `maxEntries: 0` selects unbounded append-only storage.

When the write pointer reaches the configured maximum, `rolloverHistory()`:

1. truncates data beyond the configured bound;
2. records the rollover timestamp;
3. moves `next` to `0`;
4. rebuilds the type index;
5. persists the updated store.

Subsequent writes replace the oldest array elements. Physical array order therefore differs from event order after rollover.
`getHistory()` restores chronological order by reading from `next` to the end and then from index `0` to `next`.

```text
physical data:       [new-3, new-4, old-2]
next write index:                2
chronological query: [old-2, new-3, new-4]
```

The `types` index always points at the latest physical entry for each UUID/subtype pair and is rebuilt from the complete data array
during rollover.

## Query Boundary

`getHistory()` normalises its three query inputs into an exact-match filter:

- a UUID string or HAP service type selects the UUID;
- a service instance selects its UUID and, when no subtype argument is provided, its subtype;
- explicit `null` subtype removes subtype filtering;
- `specificKey` contributes additional exact field matches.

The caller's filter object is cloned before type/subtype criteria are added. `lastHistory()` and `entryCount()` are small wrappers
over this one query path so filtering and rollover ordering remain consistent.

## Persistence Boundary

All persistence uses `hap.HAPStorage.storage()`:

```text
standalone username ──► remove ':' + uppercase ──► History.<USERNAME>.json
Homebridge accessory UUID ──────────────────────► History.<UUID>.json
```

Writes occur after successful event insertion, reset, and rollover. The storage API is synchronous from this module's perspective.
There is no independent file-format or filesystem dependency in the history path.

`generateCSV()` is the only direct filesystem feature. It queries all subtypes for a service, builds the union of value columns,
escapes CSV cells, and streams a new local-time CSV file through Node's `fs.createWriteStream()`. The returned stream exposes normal
Node completion and error events to the caller.

## Eve Protocol Boundary

`#createHomeKitServicesAndCharacteristics()` registers the proprietary characteristics used by Eve plus a small collection of
weather characteristics. `linkToEveHome()` validates the request and routes the linked service UUID to a focused `#linkEve...()`
family method. Each family method owns its service characteristics, initial state, and device-specific callbacks. Session creation
installs the common history transport callbacks at the same lifecycle boundary. Blind, Thermo, Light Strip, Smoke, Aqua, and Water
Guard SET callbacks delegate their binary command processing to matching `#setEve...Details()` methods so service wiring remains
separate from protocol decoding. Blind, Light Strip, Smoke, Aqua, and Water Guard share validated command/length/payload framing
through `#decodeEveTLVCommands()`. Thermo's `EveProgramCommand` characteristic is a distinct opcode stream whose payload width is
defined by each opcode, so it deliberately retains its separate reverse-engineered parser instead of using the TLV8 decoder.

Each adapter establishes an `EveHome` session object:

```js
{
  service,       // Eve Home History HAP service
  linkedservice, // original HAP service
  type,          // history UUID to query
  sub,           // subtype, or null for every irrigation valve
  evetype,       // Eve device family being emulated
  fields,        // ordered history field descriptors
  signature,     // generated Eve history field signature
  entry,         // requested one-based stream address
  count,
  reftime,       // seconds since Apple's 2001 epoch
  send,
  messages,      // optional owning-device router
}
```

Only one `EveHome` session is permitted per history instance. This follows Eve's history-service model and prevents ambiguous
requests across linked services.

`evetype` is stable semantic identity used by `HomeKitDevice` setup reporting and device-specific configuration. History-entry
encoding does not branch on that value. Instead, each field descriptor supplies an Eve tag, encoded byte length, source-value
lookup, conversion, and binary writer. Descriptor order determines both the advertised signature and each field's bit in the
per-entry mask. A session accepts at most seven descriptors, matching the supported Eve field bitmap. Records without any
encodable fields are excluded consistently from the advertised count and transfer address space. Device-specific configuration
reads still route by `evetype`, as described below.

### Eve Read Flow

```text
Eve app reads History Status
        │
        ▼
refresh matching local history count and reference time
        │
        ▼
encode status as little-endian fields + Base64

Eve app writes History Request
        │
        ▼
decode requested one-based entry address
        │
        ▼
Eve app reads History Entries repeatedly
        │
        ▼
encode at most 11 records per response until complete
```

Unix timestamps are translated with the 978,307,200-second offset between 1970-01-01 and Apple's 2001-01-01 epoch.

### Configuration Routing

Thermo, Light Strip, Smoke, Aqua, Energy, and Water Guard adapters hold Eve-specific configuration objects. When `options.messages` exists:

- a `HomeKitHistory.GET` message lets the owning device return a full or partial state update before a characteristic read;
- a `HomeKitHistory.SET` message reports decoded changes made in the Eve app.

All GET requests pass through `#refreshEveDetails()`. It gives the router a shallow copy, accepts only a non-array object result,
and merges that result over the adapter's existing defaults. Invalid results or router failures preserve the last valid state.
`#getEveDetails()` then uses the session's `evetype` to route the refreshed state to the matching packet encoder or scalar reader.
The family functions contain only their distinct wire-format logic.

This is a narrow dependency-inversion boundary: `HomeKitHistory` understands Eve packets but does not directly control the physical
device or own its durable device configuration.

## Public API Responsibilities

| Method/property     | Responsibility                                            |
| ------------------- | --------------------------------------------------------- |
| `addHistory()`      | validate, normalise, filter, store, and persist one event |
| `getHistory()`      | return chronologically ordered exact-match results        |
| `lastHistory()`     | return the newest matching result                         |
| `entryCount()`      | count matching results                                    |
| `resetHistory()`    | replace storage with an empty history                     |
| `rolloverHistory()` | restart bounded writes at index zero and rebuild metadata |
| `generateCSV()`     | export all matching service subtypes                      |
| `linkToEveHome()`   | create one Eve overlay and its callbacks                  |
| `updateEveHome()`   | refresh supported dynamic Eve characteristics             |
| `GET`, `SET`        | stable owning-device message names                        |
| `EVE_OPTIONS`       | collision-safe service metadata key                       |

## Known Constraints

- One source module currently contains storage, query, custom HAP type, and Eve codec concerns. Private methods keep those concerns
  separated internally, but future protocol work should avoid adding unrelated behavior to the public history path.
- Only one service is exposed to Eve per `HomeKitHistory` instance.
- MotionBlinds and Smoke history payload values remain incomplete in the reverse-engineered protocol section.
- Thermo valve-protection semantics and the newer Eve Degree/Weather history layout remain incomplete.
- Water Guard encodes its captured `0x2d` leak status and returns the last alarm-test time through configuration field `0x86`, but
  any distinct alarm-test history record remains unknown. Safe transitions are encoded even though Eve currently omits them from
  its Events view.
- Eve exposes Light Strip schedule controls, but their enable state and program TLVs remain unknown. Light Strip colour-history
  fields are also unverified, so the adapter currently records only on/off history.
- CSV creation errors are reported through the returned writable stream rather than converted into logger messages.
- Eve protocol compatibility is based on observed behavior rather than a published specification.

## Verification Strategy

`HomeKitHistory.test.js` uses only `node:test`, strict assertions, and focused HAP/storage mocks. Tests exercise public behavior rather
than private protocol helpers directly.

The baseline verification command is:

```sh
node --test HomeKitHistory.test.js
```

High-value regression areas are:

- persistence validation and key derivation;
- per-target required/optional/default fields;
- restart and minimum-gap behavior;
- subtype inference and explicit all-subtype queries;
- ring-buffer ordering and type metadata rebuilding;
- Eve history service creation and callback wiring;
- descriptor-generated signatures, field masks, and binary values;
- validated TLV command framing, malformed-packet bounds, and device-specific configuration encoders;
- captured Thermo opcode streams, including schedule, temperature-offset, and valve-protection commands;
- stable message constants shared with `HomeKitDevice`.

When extending an Eve packet adapter, add a public flow test through registered characteristic callbacks where practical. When
adding a history target, test both accepted fields and discarded fields so the persisted schema remains deliberate.
