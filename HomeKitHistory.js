// HomeKitHistory
//
// Purpose:
// - Validate and retain bounded, per-accessory HomeKit event history.
// - Persist that history through the active HAP runtime's storage provider.
// - Query or export stored events independently of Eve support.
// - Overlay one selected HAP service with Eve-compatible history and configuration characteristics.
//
// Public lifecycle:
// 1. Construct one history instance for an accessory.
// 2. Record service snapshots with addHistory().
// 3. Optionally call linkToEveHome() once to expose one history stream to Eve.
// 4. Use updateEveHome() when the owning device needs to refresh dynamic Eve characteristics.
//
// Storage invariants:
// - Unix timestamps are stored in seconds; Eve timestamps use Apple's 2001 epoch on the wire.
// - Service UUID plus subtype identifies an independent history stream.
// - historyData.next is the next insertion index and becomes zero after rollover.
// - Mutations replace state snapshots before persistence so stored and in-memory state stay aligned.
//
// Eve protocol model:
// - EveHome.evetype identifies the Eve product family being emulated and is consumed by HomeKitDevice diagnostics.
// - Ordered field descriptors generate the advertised signature, entry bitmap, conversions, and binary values.
// - A descriptor index maps directly to its bit in the one-byte field bitmap; at most seven fields are accepted.
// - Only one Eve history service can be linked per HomeKitHistory instance.
//
// Known protocol gaps:
// - MotionBlinds and Smoke history payload values are not fully decoded.
// - Thermo valve protection and the newer Eve Degree/Weather history layout remain incomplete.
// - Water Guard returns the last alarm-test time through configuration field 0x86, but any distinct alarm-test history record
//   remains unknown; zero-valued Safe transitions are encoded in history even though Eve currently omits them from Events.
// - Eve Light Strip schedule controls are exposed by Eve, but their enable state and program TLVs remain unknown.
// - Eve Light Strip colour history is not fully decoded, and the colour-history fields are unverified.
//
// Eve protocol research builds on fakegato-history:
// https://github.com/simont77/fakegato-history
//
// Code version 2026.09.22
// Mark Hulskamp

// Node.js dependencies.
import { setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import util from 'util';
import fs from 'fs';

// Storage and wire-protocol limits.
const MAX_HISTORY_SIZE = 16384; // 16k entries
const EPOCH_OFFSET = 978307200; // Seconds since 1/1/1970 to 1/1/2001
const EVEHOME_MAX_STREAM = 11; // Maximum number of history events we can stream to EveHome
const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const EMPTY_SCHEDULE = 'ffffffffffffffff';
const EVE_WATER_GUARD_ALARM_TEST_SECONDS = 180;
const HISTORY_INTERNAL_FIELDS = new Set(['time', 'type', 'sub', 'restart']);
const EVE_LIGHT_STRIP_TRANSITIONS = Object.freeze({
  quick: Object.freeze([80, 80, 120]),
  default: Object.freeze([150, 150, 400]),
  moderate: Object.freeze([400, 400, 800]),
  calm: Object.freeze([1200, 800, 1600]),
});

// Eve history fields are ordered protocol data points. Each field owns its tag, byte width,
// source lookup, conversion, and little-endian binary encoding. Returning undefined from a
// writer clears that field's bit for the current entry without changing the advertised signature.
const EVE_HISTORY_FIELDS = Object.freeze({
  temperature: createEveHistoryField(0x01, 2, (entry) => encodeScaledEveNumber(entry.temperature, 100, 2)),
  humidity: createEveHistoryField(0x02, 2, (entry) => encodeScaledEveNumber(entry.humidity, 100, 2)),
  pressure: createEveHistoryField(0x03, 2, (entry) => encodeScaledEveNumber(entry.pressure, 10, 2)),
  ppm: createEveHistoryField(0x04, 2, (entry) => encodeScaledEveNumber(entry.ppm, 10, 2)),
  contact: createEveHistoryField(0x06, 1, (entry) => encodeBinaryEveStatus(entry.status, false)),
  invertedContact: createEveHistoryField(0x06, 1, (entry) => encodeBinaryEveStatus(entry.status, true)),
  power: createEveHistoryField(0x07, 2, (entry) => encodeScaledEveNumber(entry.watts, 10, 2)),
  onOff: createEveHistoryField(0x0e, 1, (entry) => encodeBinaryEveStatus(entry.status, false)),
  vocHeatSense: createEveHistoryField(0x0f, 3, () => numberToEveHexString(0, 6)),
  valvePosition: createEveHistoryField(0x10, 1, (entry) => numberToEveHexString(entry.status === 2 ? 100 : 0, 2)),
  targetTemperature: createEveHistoryField(0x11, 2, (entry) => encodeScaledEveNumber(eveThermoTargetTemperature(entry), 100, 2)),
  thermoTarget: createEveHistoryField(0x12, 1, () => numberToEveHexString(0, 2)),
  // Signature-only fields are advertised but omitted from entries until their payload semantics are verified.
  motionDetected: createEveHistoryField(0x13, 1),
  smokeStatus: createEveHistoryField(0x16, 1),
  currentPosition: createEveHistoryField(0x17, 2),
  targetPosition: createEveHistoryField(0x18, 2),
  positionState: createEveHistoryField(0x19, 1),
  smokeDetail: createEveHistoryField(0x1b, 2),
  smokeVocHeatSense: createEveHistoryField(0x0f, 3),
  motionActive: createEveHistoryField(0x1c, 1, (entry) => encodeBinaryEveStatus(entry.status, false)),
  openWindow: createEveHistoryField(0x1d, 1, () => numberToEveHexString(0, 2)),
  inUse: createEveHistoryField(0x1f, 1, (entry) => encodeBinaryEveStatus(entry.status, false)),
  vocDensity: createEveHistoryField(0x22, 2, (entry) => encodeScaledEveNumber(entry.voc, 1, 2)),
  batteryVoltage: createEveHistoryField(0x23, 2, () => numberToEveHexString(3120, 4)),
  smokeBatteryVoltage: createEveHistoryField(0x23, 2),
  room2BatteryVoltage: createEveHistoryField(0x23, 2, () => numberToEveHexString(4771, 4)),
  batteryLevel: createEveHistoryField(0x25, 1, () => numberToEveHexString(100, 2)),
  room2Unknown28: createEveHistoryField(0x28, 1, () => numberToEveHexString(1, 2)),
  room2Unknown29: createEveHistoryField(0x29, 1, () => numberToEveHexString(0, 2)),
  waterUsage: createEveHistoryField(0x2a, 8, (entry) => {
    if (entry.status !== 0 || typeof entry.water !== 'number') {
      return;
    }
    return numberToEveHexString(Math.floor(entry.water * 1000), 16);
  }),
  leakStatus: createEveHistoryField(0x2d, 1, (entry) => encodeBinaryEveStatus(entry.status, false)),
});

/**
 * Stores bounded HomeKit service history and optionally exposes one Eve-compatible history session.
 */
export default class HomeKitHistory {
  static GET = 'HomeKitHistory.onEveGet'; // for EveHome read requests
  static SET = 'HomeKitHistory.onEveSet'; // for EveHome write requests

  // Symbol used to temporarily store EveHome options on a service
  static EVE_OPTIONS = Symbol('eveOptions');

  historyData = {
    reset: Math.floor(Date.now() / 1000),
    rollover: 0,
    next: 0,
    types: [],
    data: [],
  }; // Valid in-memory baseline, replaced when persisted history is available
  restart = Math.floor(Date.now() / 1000); // time we restarted object or created
  EveHome = undefined;

  accessory = undefined; // Accessory service for this history
  hap = undefined; // HomeKit Accessory Protocol API stub
  log = undefined; // Logging function object

  // Persistence internals are intentionally private so callers cannot bypass validation.
  #persistStorage = undefined;
  #persistKey = undefined;
  #maxEntries = MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover

  /**
   * Resolves the HAP runtime, restores persisted history, and registers the custom Eve HAP types.
   * Construction degrades to a valid in-memory store when persistence is unavailable or malformed.
   *
   * @param {object} [accessory] HAP accessory that owns this history store.
   * @param {object} [api] Homebridge API or standalone HAP-NodeJS API.
   * @param {object|Function} [log] Optional partial logger.
   * @param {object} [options] History storage options.
   * @param {number} [options.maxEntries] Maximum retained entries; zero disables rollover.
   */
  constructor(accessory = undefined, api = undefined, log = undefined, options = {}) {
    // Keep partial loggers usable; every call site already checks the individual logging method.
    if ((typeof log === 'object' && log !== null) || typeof log === 'function') {
      this.log = log;
    }

    // Get the actual HAP entry point from passed in api object, either Homebridge or HAP-NodeJS
    this.hap =
      isNaN(api?.version) === false && typeof api?.hap === 'object' && api?.HAPLibraryVersion === undefined
        ? api.hap
        : typeof api?.HAPLibraryVersion === 'function' && api?.version === undefined && api?.hap === undefined
          ? api
          : undefined;

    if (this.hap === undefined) {
      this?.log?.error?.('Missing HAP library API, cannot use class');
      return;
    }

    if (typeof accessory === 'object' && accessory !== null) {
      this.accessory = accessory;
    }

    if (Number.isInteger(options?.maxEntries) === true && options.maxEntries >= 0) {
      this.#maxEntries = options.maxEntries;
    }

    // Determine the persistent storage key from the stable identity supplied by the active runtime.
    if (typeof accessory?.username === 'string' && accessory.username !== '') {
      // Since we have a username for the accessory, we'll assume this is not running under Homebridge
      // Use its persist folder for storing history files.
      this.#persistKey = util.format('History.%s.json', accessory.username.replace(/:/g, '').toUpperCase());
    }

    // Setup HomeKitHistory under Homebridge
    if (this.#persistKey === undefined && typeof accessory?.UUID === 'string' && accessory.UUID !== '') {
      this.#persistKey = util.format('History.%s.json', accessory.UUID);
    }

    if (this.#persistKey === undefined) {
      this?.log?.error?.('Missing accessory identity, history storage is unavailable');
      return;
    }

    // Storage access is fallible. A read failure starts a clean in-memory history and later writes can still recover.
    try {
      this.#persistStorage = this.hap?.HAPStorage?.storage?.();
    } catch (error) {
      this?.log?.warn?.('Unable to initialise history storage: %s', formatError(error));
    }
    this.historyData = this.#readHistory();
    if (this.#isHistoryDataValid(this.historyData) === false) {
      // Missing or malformed persisted data cannot be used safely, so replace it with a known-good history structure.
      this.resetHistory(); // Start with blank history
    }

    // perform rollover if needed when starting service
    if (this.#maxEntries !== 0 && this.historyData.next >= this.#maxEntries) {
      this.rolloverHistory();
    }

    // Dynamically create the additional services and characteristics
    this.#createHomeKitServicesAndCharacteristics();
  }

  // Persistence validation and I/O boundary.
  #isHistoryDataValid(historyData) {
    if (
      typeof historyData !== 'object' ||
      historyData === null ||
      Array.isArray(historyData) === true ||
      typeof historyData.reset !== 'number' ||
      typeof historyData.rollover !== 'number' ||
      Number.isInteger(historyData.next) === false ||
      historyData.next < 0 ||
      Array.isArray(historyData.types) === false ||
      Array.isArray(historyData.data) === false ||
      historyData.next > historyData.data.length
    ) {
      return false;
    }
    return true;
  }

  #readHistory() {
    if (typeof this.#persistStorage?.getItem !== 'function') {
      return;
    }

    try {
      return this.#persistStorage.getItem(this.#persistKey);
    } catch (error) {
      this?.log?.warn?.('Unable to read history storage "%s": %s', this.#persistKey, formatError(error));
    }
  }

  #persistHistory() {
    if (typeof this.#persistStorage?.setItemSync !== 'function') {
      return false;
    }

    try {
      this.#persistStorage.setItemSync(this.#persistKey, this.historyData);
      return true;
    } catch (error) {
      this?.log?.error?.('Unable to write history storage "%s": %s', this.#persistKey, formatError(error));
      return false;
    }
  }

  /**
   * Validates and records one service or characteristic snapshot.
   * Unsupported targets and entries missing their required shape are ignored without consuming the restart marker.
   *
   * @param {object} target HAP Service or Characteristic whose UUID identifies the history type.
   * @param {object} entry Snapshot values with an optional Unix timestamp in seconds.
   * @param {number} [timegap] Minimum seconds between records for the same UUID and subtype.
   * @returns {void}
   */
  addHistory(target, entry, timegap) {
    // Validate that target is a Service or Characteristic with a UUID string,
    // entry is an object, and hap.Service exists (class/function)
    if (
      typeof target !== 'object' ||
      target === null ||
      Array.isArray(target) === true ||
      typeof target.UUID !== 'string' ||
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) === true ||
      typeof this.hap?.Service !== 'function' ||
      typeof this.hap?.Characteristic !== 'function'
    ) {
      return;
    }

    // Metadata map keyed by Service or Characteristic UUID
    let SERVICE_HISTORY_META = {
      [this.hap.Service.ContactSensor.UUID]: {
        required: ['status'],
        comment: 'status => 0 = contact detected, 1 = contact not detected',
      },
      [this.hap.Service.Door.UUID]: {
        required: ['status'],
        comment: 'status => 0 = closed, 1 = open',
      },
      [this.hap.Service.GarageDoorOpener.UUID]: {
        required: ['status'],
        comment: 'status => 0 = closed, 1 = open',
      },
      [this.hap.Service.LockMechanism.UUID]: {
        required: ['status'],
        comment: 'status => 0 = locked, 1 = unlocked',
      },
      [this.hap.Service.Fan.UUID]: {
        required: ['status'],
        optional: ['temperature', 'humidity'],
        comment: 'status => 0 = off, 1 = on; optional: temperature, humidity',
      },
      [this.hap.Service.Fan.Fanv2.UUID]: {
        required: ['status'],
        optional: ['temperature', 'humidity'],
        comment: 'status => 0 = off, 1 = on; optional: temperature, humidity',
      },
      [this.hap.Service.HumidifierDehumidifier.UUID]: {
        required: ['status'],
        optional: ['temperature', 'humidity'],
        comment: 'status => 0 = off, 1 = on; optional: temperature, humidity',
      },
      [this.hap.Service.MotionSensor.UUID]: {
        required: ['status'],
        comment: 'status => 0 = motion cleared, 1 = motion detected',
      },
      [this.hap.Service.Switch.UUID]: {
        required: ['status'],
        comment: 'status => 0 = off, 1 = on',
      },
      [this.hap.Service.Lightbulb.UUID]: {
        required: ['status'],
        comment: 'status => 0 = off, 1 = on',
      },
      [this.hap.Service.Window.UUID]: {
        required: ['status', 'position'],
        comment: 'status => 0 = closed, 1 = open; position => % open (0–100)',
      },
      [this.hap.Service.WindowCovering.UUID]: {
        required: ['status', 'position'],
        comment: 'status => 0 = closed, 1 = open; position => % open (0–100)',
      },
      [this.hap.Service.HeaterCooler.UUID]: {
        required: ['status', 'temperature', 'target', 'humidity'],
        comment: 'status => 0 = off, 1 = cooling, 2 = heating; includes temperature, target {low/high}, humidity',
      },
      [this.hap.Service.Thermostat.UUID]: {
        required: ['status', 'temperature', 'target', 'humidity'],
        comment: 'status => 0 = off, 1 = cooling, 2 = heating; includes temperature, target {low/high}, humidity',
      },
      [this.hap.Service.TemperatureSensor.UUID]: {
        required: ['temperature'],
        defaults: { humidity: 0, ppm: 0, voc: 0, pressure: 0 },
        comment: 'temperature required; humidity, ppm, voc, pressure default to 0',
      },
      [this.hap.Service.AirQualitySensor.UUID]: {
        required: ['temperature'],
        defaults: { humidity: 0, ppm: 0, voc: 0, pressure: 0 },
        comment: 'temperature required; humidity, ppm, voc, pressure default to 0',
      },
      [this.hap.Service.EveAirPressureSensor.UUID]: {
        required: ['temperature'],
        defaults: { humidity: 0, ppm: 0, voc: 0, pressure: 0 },
        comment: 'temperature required; humidity, ppm, voc, pressure default to 0',
      },
      [this.hap.Service.Valve.UUID]: {
        required: ['status', 'water', 'duration'],
        comment: 'status => 0 = valve closed, 1 = open; includes water (L) and duration (s)',
      },
      [this.hap.Characteristic.WaterLevel.UUID]: {
        required: ['level'],
        comment: 'level => water level percentage (0–100)',
      },
      [this.hap.Service.LeakSensor.UUID]: {
        required: ['status'],
        comment: 'status => 0 = no leak, 1 = leak detected',
      },
      [this.hap.Service.Outlet.UUID]: {
        requiredAny: ['status', 'watts'],
        optional: ['volts', 'amps'],
        comment: 'at least one of status or watts is required; volts and amps are optional',
      },
      [this.hap.Service.Doorbell.UUID]: {
        required: ['status'],
        comment: 'status => 0 = not pressed, 1 = pressed',
      },
      [this.hap.Service.SmokeSensor.UUID]: {
        required: ['status'],
        comment: 'status => 0 = smoke cleared, 1 = smoke detected',
      },
    };

    // Lookup metadata for this target UUID (service or characteristic)
    let meta = SERVICE_HISTORY_META[target.UUID];
    if (typeof meta !== 'object') {
      return;
    }

    // Validate required keys exist on entry
    let required = [].concat(meta.required || []);
    for (let i = 0; i < required.length; i++) {
      if (typeof entry[required[i]] === 'undefined') {
        return;
      }
    }

    // Combination profiles accept independent samples when at least one advertised field is present.
    let requiredAny = [].concat(meta.requiredAny || []);
    let hasRequiredAny = requiredAny.some((key) => {
      if (typeof entry[key] !== 'undefined') {
        return true;
      }
      return false;
    });
    if (requiredAny.length !== 0 && hasRequiredAny === false) {
      return;
    }

    // Resolve generated metadata locally so recording history does not mutate caller-owned objects.
    let restart = entry.restart;
    if (isNaN(this.restart) === false && typeof restart === 'undefined') {
      restart = this.restart;
      this.restart = undefined;
    }

    let time = isNaN(entry.time) === true ? Math.floor(Date.now() / 1000) : entry.time;
    let subtype =
      target.UUID === this.hap.Characteristic.WaterLevel.UUID || target.UUID === this.hap.Service.LeakSensor.UUID
        ? 0
        : typeof target.subtype === 'undefined'
          ? 0
          : target.subtype;

    // Default timegap if invalid
    if (isNaN(timegap) === true) {
      timegap = 0;
    }

    // Compose the allow-list of fields persisted for this history type.
    let keys = [].concat(required, requiredAny, meta.optional || []);
    if (typeof meta.defaults === 'object') {
      for (let key in meta.defaults) {
        if (keys.indexOf(key) === -1) {
          keys.push(key);
        }
      }
    }

    // Build the filtered history entry
    let historyEntry = {};
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      if (typeof entry[key] !== 'undefined') {
        historyEntry[key] = entry[key];
      } else if (typeof meta.defaults?.[key] !== 'undefined') {
        historyEntry[key] = meta.defaults[key];
      }
    }

    // Include restart if set
    if (isNaN(restart) === false) {
      historyEntry.restart = restart;
    }

    // Call internal add entry handler
    this.#addEntry(target.UUID, subtype, time, timegap, historyEntry);
  }

  /**
   * Replaces all retained history with a new empty store and persists it.
   *
   * @returns {void}
   */
  resetHistory() {
    // Replace the complete store so callers never observe a partially reset structure.
    this.historyData = {
      reset: Math.floor(Date.now() / 1000),
      rollover: 0,
      next: 0,
      types: [],
      data: [],
    };
    this.#persistHistory();
  }

  /**
   * Restarts bounded writes at index zero and rebuilds subtype metadata.
   *
   * @returns {void}
   */
  rolloverHistory() {
    // Preserve the bounded data snapshot while moving the next write back to index zero.
    let data = this.historyData.data.slice(0, this.#maxEntries === 0 ? undefined : this.#maxEntries);
    this.historyData = {
      ...this.historyData,
      rollover: Math.floor(Date.now() / 1000),
      next: 0,
      types: this.#buildHistoryTypes(data),
      data,
    };
    this.#persistHistory();
  }

  #addEntry(type, sub, time, timegap, entry) {
    let historyEntry = {};
    let recordEntry = true; // always record entry unless we don't need to

    historyEntry.time = time;
    historyEntry.type = type;
    historyEntry.sub = sub;

    // Filter out reserved keys
    Object.entries(entry).forEach(([key, value]) => {
      if (key !== 'time' && key !== 'type' && key !== 'sub') {
        historyEntry[key] = value;
      }
    });

    // If we have a minimum time gap specified, find the last time entry for this type and if less than min gap, ignore
    if (timegap !== 0) {
      let typeIndex = this.historyData.types.findIndex((t) => t.type === type && t.sub === sub);
      let entryTime = this.historyData.data?.[this.historyData.types?.[typeIndex]?.lastEntry]?.time;
      if (typeIndex >= 0 && typeof entryTime === 'number' && time - entryTime < timegap && typeof historyEntry.restart === 'undefined') {
        // time between last recorded entry and new entry is less than minimum gap and it's not a 'restart' entry
        // so don't log it
        recordEntry = false;
      }
    }

    if (recordEntry === true) {
      // Work out where this goes in the history data array
      if (this.#maxEntries !== 0 && this.historyData.next >= this.#maxEntries) {
        // roll over history data as we've reached the defined max entry size
        this.rolloverHistory();
      }

      let entryIndex = this.historyData.next;
      let data = this.historyData.data.slice();
      data[entryIndex] = historyEntry;

      // Update types we have in history. This will just be the main type and its latest location in history
      let types = this.historyData.types.map((typeEntry) => ({ ...typeEntry }));
      let typeIndex = types.findIndex((typeEntry) => typeEntry.type === type && typeEntry.sub === sub);
      if (typeIndex === -1) {
        types.push({ type, sub, lastEntry: entryIndex });
      } else {
        types[typeIndex] = { ...types[typeIndex], lastEntry: entryIndex };
      }

      // Validate types last entries. Helps with rolled over data etc. If we cannot find the type anymore, remove from known types
      types = types.filter((typeEntry) => {
        let latestEntry = data[typeEntry?.lastEntry];
        return latestEntry?.type === typeEntry.type && latestEntry?.sub === typeEntry.sub;
      });

      this.historyData = {
        ...this.historyData,
        next: entryIndex + 1,
        types,
        data,
      };

      // Save to persistent storage
      this.#persistHistory();
    }
  }

  /**
   * Returns matching entries in chronological order.
   *
   * @param {object|string|null} [service] HAP service instance, service UUID, or null for all service types.
   * @param {*} [subtype] Optional exact subtype filter.
   * @param {object} [specificKey] Optional exact-match field filters.
   * @returns {Array<object>} Detached history entry snapshots.
   */
  getHistory(service, subtype, specificKey) {
    // Return chronologically ordered history matching the requested type, subtype, and exact field values.
    let historyFilter =
      typeof specificKey === 'object' && specificKey !== null && Array.isArray(specificKey) === false ? { ...specificKey } : {};

    if (typeof service === 'string' && service !== '') {
      historyFilter.type = service;
    } else if (typeof service?.UUID === 'string' && service.UUID !== '') {
      historyFilter.type = service.UUID;
    }

    // An omitted subtype follows a service instance; a missing HAP subtype is normalised to zero.
    if (subtype === undefined && typeof service === 'object' && service !== null && typeof service.UUID === 'string') {
      historyFilter.sub = typeof service.subtype === 'undefined' ? 0 : service.subtype;
    }

    if (subtype !== undefined && subtype !== null) {
      historyFilter.sub = subtype;
    }

    return this.historyData.data
      .slice(this.historyData.next, this.historyData.data.length)
      .concat(this.historyData.data.slice(0, this.historyData.next))
      .filter((historyEntry) => {
        return Object.entries(historyFilter).every(([key, value]) => historyEntry[key] === value);
      });
  }

  /**
   * Streams all matching service subtypes to a local-time CSV file.
   *
   * @param {object|string} service HAP service instance or service UUID.
   * @param {string} csvfile Destination filename.
   * @returns {import('node:fs').WriteStream|undefined} Writable stream, or undefined for invalid arguments.
   */
  generateCSV(service, csvfile) {
    const escapeCSVValue = (value) => {
      // Quote CSV cells only when required, preserving commas, quotes, and line breaks in values.
      let stringValue = value === undefined || value === null ? '' : String(value);
      if (/[",\r\n]/.test(stringValue) === true) {
        return '"' + stringValue.replace(/"/g, '""') + '"';
      }
      return stringValue;
    };

    // Export all subtypes with a stable union of value columns and RFC 4180-compatible escaping.
    let history = this.getHistory(service, null);
    if (history.length === 0 || typeof csvfile !== 'string' || csvfile === '') {
      return;
    }

    let columns = [];
    history.forEach((historyEntry) => {
      Object.keys(historyEntry).forEach((key) => {
        if (HISTORY_INTERNAL_FIELDS.has(key) === false && columns.includes(key) === false) {
          columns.push(key);
        }
      });
    });

    let writer = fs.createWriteStream(csvfile, { flags: 'w', autoClose: true });
    writer.write(['time', 'subtype'].concat(columns).map(escapeCSVValue).join(',') + '\n');

    history.forEach((historyEntry) => {
      let row = [new Date(historyEntry.time * 1000).toLocaleString(), historyEntry.sub];
      columns.forEach((key) => row.push(historyEntry[key]));
      writer.write(row.map(escapeCSVValue).join(',') + '\n');
    });
    writer.end();
    return writer;
  }

  /**
   * Returns the newest entry matching a service and optional subtype.
   *
   * @param {object|string|null} [service] HAP service instance, service UUID, or null for all service types.
   * @param {*} [subtype] Optional exact subtype filter.
   * @returns {object|undefined} Detached newest entry when available.
   */
  lastHistory(service, subtype) {
    let lastHistory = this.getHistory(service, subtype);
    return lastHistory.length > 0 ? lastHistory?.[lastHistory.length - 1] : undefined;
  }

  /**
   * Counts entries matching a service, optional subtype, and optional exact field filters.
   *
   * @param {object|string|null} [service] HAP service instance, service UUID, or null for all service types.
   * @param {*} [subtype] Optional exact subtype filter.
   * @param {object} [specificKey] Optional exact-match field filters.
   * @returns {number} Number of matching entries.
   */
  entryCount(service, subtype, specificKey) {
    return this.getHistory(service, subtype, specificKey).length;
  }

  #buildHistoryTypes(data) {
    // Rebuild latest-entry metadata after rollover without mutating the active history object.
    let types = [];
    for (let index = data.length - 1; index >= 0; index--) {
      if (
        types.findIndex(
          (type) =>
            (typeof type.sub !== 'undefined' && type.type === data[index].type && type.sub === data[index].sub) ||
            (typeof type.sub === 'undefined' && type.type === data[index].type),
        ) === -1
      ) {
        types.push({
          type: data[index].type,
          sub: data[index].sub,
          lastEntry: index,
        });
      }
    }
    return types;
  }

  // Eve descriptor and session layer. Device identity remains separate from binary field layout.
  #EveFieldSignature(fields) {
    return fields
      .map((field) => {
        return field.tag.toString(16).padStart(2, '0') + field.length.toString(16).padStart(2, '0');
      })
      .join(' ');
  }

  #encodeEveFields(entry, fields) {
    // Each bit in the one-byte mask corresponds to the descriptor at the same array index.
    let mask = 0;
    let values = [];

    fields.forEach((field, index) => {
      // Signature-only descriptors deliberately advertise a field without supplying entry data.
      if (typeof field.write !== 'function') {
        return;
      }

      // A writer returns little-endian hex when its source value is available, or undefined to omit it.
      let encoded = field.write(entry);
      if (typeof encoded === 'string') {
        // Preserve descriptor order in both the mask and the values appended after it.
        mask |= 1 << index;
        values.push(encoded);
      }
    });

    // An entry with none of the advertised fields cannot be represented in the Eve stream.
    if (mask === 0) {
      return;
    }

    // Eve entries start with the inclusion mask followed by only the values whose bits are set.
    return numberToEveHexString(mask, 2) + (values.length === 0 ? '' : ' ' + values.join(' '));
  }

  #getEveHistory(type, subtype, fields) {
    // Keep transfer addresses and advertised counts aligned by excluding records with no encodable fields.
    return this.getHistory(type, subtype).filter((entry) => {
      if (typeof this.#encodeEveFields(entry, fields) === 'string') {
        return true;
      }
      return false;
    });
  }

  /**
   * Creates one Eve transfer session and installs its common history transport callbacks.
   *
   * @param {object} historyService Eve history service exposed through HAP.
   * @param {object} linkedService Original HAP service represented by the Eve adapter.
   * @param {string} type History service UUID queried by this session.
   * @param {*} subtype History subtype, normalised to zero when omitted.
   * @param {string} evetype Eve product family identity used by diagnostics and configuration routing.
   * @param {Array<object>} fields Ordered Eve history field descriptors.
   * @param {object} options Adapter options, including an optional messages router.
   * @returns {object} Mutable Eve session and transfer state.
   * @private
   */
  #createEveSession(historyService, linkedService, type, subtype, evetype, fields, options) {
    // evetype identifies the Eve product family; fields independently define its binary history layout.

    // HomeKit services without an explicit subtype use zero as their stable history identity.
    let historySubtype = typeof subtype === 'undefined' ? 0 : subtype;
    let historyFields = [];

    // Eve uses a one-byte inclusion bitmap, with this implementation reserving at most seven field positions.
    // Validate every descriptor before accepting the layout so malformed internal profiles cannot corrupt packets.
    if (
      Array.isArray(fields) === true &&
      fields.length <= 7 &&
      fields.every((field) => {
        if (
          typeof field !== 'object' ||
          field === null ||
          Number.isInteger(field.tag) === false ||
          field.tag < 0 ||
          field.tag > 0xff ||
          Number.isInteger(field.length) === false ||
          field.length <= 0
        ) {
          return false;
        }
        return true;
      }) === true
    ) {
      // Copy the array so later changes to an adapter's source configuration cannot mutate an active session.
      historyFields = fields.slice();
    } else {
      this?.log?.error?.('Invalid Eve history field configuration for "%s"', evetype);
    }

    // Count only records that contain at least one value supported by the selected descriptor layout.
    let history = this.#getEveHistory(type, historySubtype, historyFields);

    // The session combines immutable adapter identity with mutable one-based transfer progress.
    let session = {
      service: historyService,
      linkedservice: linkedService,
      type,
      sub: historySubtype,
      evetype,
      fields: historyFields,
      // Generate the advertised tag/length sequence from the same descriptors used to encode entries.
      signature: this.#EveFieldSignature(historyFields),
      entry: 0,
      count: history.length,
      // Eve timestamps are relative to the first transferable entry, or the history reset when empty.
      reftime: history.length === 0 ? this.historyData.reset - EPOCH_OFFSET : history[0].time - EPOCH_OFFSET,
      send: 0,
      // The optional router lets the owning device handle Eve configuration without coupling it to this module.
      messages: typeof options?.messages === 'function' ? options.messages : undefined,
    };

    // Callback closures resolve this.EveHome when invoked, after the adapter has stored the returned session.
    if (typeof historyService === 'object' && historyService !== null) {
      historyService.getCharacteristic(this.hap.Characteristic.EveResetTotal).onGet(() => {
        return this.historyData.reset - EPOCH_OFFSET;
      });
      historyService.getCharacteristic(this.hap.Characteristic.EveHistoryStatus).onGet(() => {
        return this.#EveHistoryStatus();
      });
      historyService.getCharacteristic(this.hap.Characteristic.EveHistoryEntries).onGet(() => {
        return this.#EveHistoryEntries();
      });
      historyService.getCharacteristic(this.hap.Characteristic.EveHistoryRequest).onSet((value) => {
        this.#EveHistoryRequest(value);
      });
      historyService.getCharacteristic(this.hap.Characteristic.EveSetTime).onSet((value) => {
        this.#EveSetTime(value);
      });
    }

    return session;
  }

  /**
   * Overlays a supported HAP service with an emulated Eve device family and history protocol.
   * Only one service history can be exposed to Eve for each HomeKitHistory instance.
   *
   * @param {object} service HAP service whose UUID selects the Eve adapter.
   * @param {object} [options] Device-specific Eve settings and optional GET/SET messages router.
   * @returns {Promise<object|undefined>} Eve history service, or undefined when unsupported or already linked.
   */
  async linkToEveHome(service, options) {
    if (
      typeof service !== 'object' ||
      service === null ||
      Array.isArray(service) === true ||
      typeof this?.EveHome?.service !== 'undefined'
    ) {
      return;
    }

    if (typeof options !== 'object' || options === null || Array.isArray(options) === true) {
      options = {};
    }

    switch (service.UUID) {
      case this.hap.Service.Switch.UUID:
        this.#linkEveSwitch(service, options);
        break;

      case this.hap.Service.Lightbulb.UUID:
        await this.#linkEveLightStrip(service, options);
        break;

      case this.hap.Service.ContactSensor.UUID:
      case this.hap.Service.Door.UUID:
      case this.hap.Service.Window.UUID:
      case this.hap.Service.GarageDoorOpener.UUID:
      case this.hap.Service.LockMechanism.UUID:
        this.#linkEveDoor(service, options);
        break;

      case this.hap.Service.WindowCovering.UUID:
        this.#linkEveBlind(service, options);
        break;

      case this.hap.Service.HeaterCooler.UUID:
      case this.hap.Service.Thermostat.UUID:
        await this.#linkEveThermo(service, options);
        break;

      case this.hap.Service.EveAirPressureSensor.UUID:
        this.#linkEveWeather(service, options);
        break;

      case this.hap.Service.AirQualitySensor.UUID:
      case this.hap.Service.TemperatureSensor.UUID:
        this.#linkEveRoom(service, options);
        break;

      case this.hap.Service.MotionSensor.UUID:
        this.#linkEveMotion(service, options);
        break;

      case this.hap.Service.SmokeSensor.UUID:
        await this.#linkEveSmoke(service, options);
        break;

      case this.hap.Service.Valve.UUID:
      case this.hap.Service.IrrigationSystem.UUID:
        await this.#linkEveAqua(service, options);
        break;

      case this.hap.Service.Outlet.UUID:
        await this.#linkEveEnergy(service, options);
        break;

      case this.hap.Service.LeakSensor.UUID:
        await this.#linkEveWaterGuard(service, options);
        break;
    }

    return this.EveHome?.service;
  }

  #linkEveSwitch(service, options) {
    // Eve Light Switch history uses field 0e for its one-byte on/off state.
    let historyService = this.#createHistoryService(service, []);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'switch',
      [EVE_HISTORY_FIELDS.onOff],
      options,
    );
  }

  async #linkEveLightStrip(service, options) {
    // Eve Light Strip uses Light Switch on/off history plus its own configuration protocol.
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveGetConfiguration,
      this.hap.Characteristic.EveSetConfiguration,
      this.hap.Characteristic.EveFirmware,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'lightstrip',
      [EVE_HISTORY_FIELDS.onOff],
      options,
    );

    this.EveLightStripPersist = {
      firmware: typeof options?.EveLightStrip_firmware === 'number' ? options.EveLightStrip_firmware : 500,
      poweronbehavior: options?.EveLightStrip_poweronbehavior === 2 ? 2 : 1,
      transition:
        typeof options?.EveLightStrip_transition === 'string' && EVE_LIGHT_STRIP_TRANSITIONS[options.EveLightStrip_transition] !== undefined
          ? options.EveLightStrip_transition
          : 'default',
    };

    // Product byte 0x36 identifies Eve Light Strip; the following UINT16 is its firmware build.
    service.updateCharacteristic(
      this.hap.Characteristic.EveFirmware,
      encodeEveData(util.format('36 %s be', numberToEveHexString(this.EveLightStripPersist.firmware, 4))),
    );
    service.updateCharacteristic(this.hap.Characteristic.EveGetConfiguration, await this.#getEveDetails());
    service.getCharacteristic(this.hap.Characteristic.EveGetConfiguration).onGet(async () => {
      return await this.#getEveDetails();
    });
    service.getCharacteristic(this.hap.Characteristic.EveSetConfiguration).onSet((value) => {
      return this.#setEveLightStripDetails(value);
    });
  }

  #linkEveDoor(service, options) {
    // treat these as EveHome Door
    // Inverse status used for all UUID types except this.hap.Service.ContactSensor.UUID

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveLastActivation,
      this.hap.Characteristic.EveOpenedDuration,
      this.hap.Characteristic.EveTimesOpened,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      service.UUID === this.hap.Service.ContactSensor.UUID ? 'contact' : 'door',
      [service.UUID === this.hap.Service.ContactSensor.UUID ? EVE_HISTORY_FIELDS.contact : EVE_HISTORY_FIELDS.invertedContact],
      options,
    );

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(
      this.hap.Characteristic.EveTimesOpened,
      this.entryCount(this.EveHome.type, this.EveHome.sub, { status: 1 }),
    );
    service.updateCharacteristic(this.hap.Characteristic.EveLastActivation, this.#EveLastEventTime());

    // Setup callbacks for characteristics
    service.getCharacteristic(this.hap.Characteristic.EveTimesOpened).onGet(() => {
      // Count of entries based upon status = 1, opened
      return this.entryCount(this.EveHome.type, this.EveHome.sub, { status: 1 });
    });

    service.getCharacteristic(this.hap.Characteristic.EveLastActivation).onGet(() => {
      return this.#EveLastEventTime(); // time of last event in seconds since first event
    });
  }

  #linkEveBlind(service, options) {
    // Treat as Eve MotionBlinds

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveGetConfiguration,
      this.hap.Characteristic.EveSetConfiguration,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'blind',
      [EVE_HISTORY_FIELDS.currentPosition, EVE_HISTORY_FIELDS.targetPosition, EVE_HISTORY_FIELDS.positionState],
      options,
    );

    //17      CurrentPosition
    //18      TargetPosition
    //19      PositionState

    service.getCharacteristic(this.hap.Characteristic.EveGetConfiguration).onGet(() => {
      let value = util.format(
        '0002 5500 0302 %s 9b04 %s 1e02 5500 0c',
        numberToEveHexString(2979, 4), // firmware version (build xxxx)
        numberToEveHexString(Math.floor(Date.now() / 1000), 8),
      ); // 'now' time

      return encodeEveData(value);
    });

    service.getCharacteristic(this.hap.Characteristic.EveSetConfiguration).onSet((value) => this.#setEveBlindDetails(service, value));
  }

  async #linkEveThermo(service, options) {
    // treat these as EveHome Thermo

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveValvePosition,
      this.hap.Characteristic.EveFirmware,
      this.hap.Characteristic.EveProgramData,
      this.hap.Characteristic.EveProgramCommand,
      this.hap.Characteristic.StatusActive,
      this.hap.Characteristic.CurrentTemperature,
      this.hap.Characteristic.TemperatureDisplayUnits,
      this.hap.Characteristic.LockPhysicalControls,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'thermo',
      [
        // Keep humidity as an intentional extension to the physical Eve Thermo signature
        // so existing integrations retain their Eve humidity display behaviour.
        EVE_HISTORY_FIELDS.temperature,
        EVE_HISTORY_FIELDS.humidity,
        EVE_HISTORY_FIELDS.targetTemperature,
        EVE_HISTORY_FIELDS.valvePosition,
        EVE_HISTORY_FIELDS.thermoTarget,
        EVE_HISTORY_FIELDS.openWindow,
      ],
      options,
    );

    // Need some internal storage to track Eve Thermo configuration from EveHome app
    this.EveThermoPersist = {
      firmware: typeof options?.EveThermo_firmware === 'number' ? options.EveThermo_firmware : 1251, // 1251 (2015), 2834 (2020) thermo
      attached: options?.EveThermo_attached === true, // attached to base?
      tempoffset: typeof options?.EveThermo_tempoffset === 'number' ? options.EveThermo_tempoffset : -2.5, // Temperature offset
      enableschedule: options?.EveThermo_enableschedule === true, // Schedules on/off
      pause: options?.EveThermo_pause === true, // Paused on/off
      vacation: options?.EveThermo_vacation === true, // Vacation status - disabled ie: Home
      vacationtemp: typeof options?.EveThermo_vacationtemp === 'number' ? options.EveThermo_vacationtemp : null, // Vacation temp
      programs: typeof options?.EveThermo_programs === 'object' ? options.EveThermo_programs : [],
    };

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(
      this.hap.Characteristic.EveFirmware,
      encodeEveData(util.format('2c %s be', numberToEveHexString(this.EveThermoPersist.firmware, 4))),
    ); // firmware version (build xxxx)));

    service.updateCharacteristic(this.hap.Characteristic.EveProgramData, await this.#getEveDetails());
    service.getCharacteristic(this.hap.Characteristic.EveProgramData).onGet(async () => {
      return await this.#getEveDetails();
    });

    service.getCharacteristic(this.hap.Characteristic.EveProgramCommand).onSet((value) => this.#setEveThermoDetails(value));
  }

  #linkEveWeather(service, options) {
    // treat these as EveHome Weather (2015)

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [this.hap.Characteristic.EveFirmware]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'weather',
      [EVE_HISTORY_FIELDS.temperature, EVE_HISTORY_FIELDS.humidity, EVE_HISTORY_FIELDS.pressure],
      options,
    );

    service.updateCharacteristic(this.hap.Characteristic.EveFirmware, encodeEveData(util.format('01 %s be', numberToEveHexString(809, 4))));
  }

  #linkEveRoom(service, options) {
    // treat these as EveHome Room(s)

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveFirmware,
      service.UUID === this.hap.Service.AirQualitySensor.UUID
        ? this.hap.Characteristic.VOCDensity
        : this.hap.Characteristic.TemperatureDisplayUnits,
    ]);

    if (service.UUID === this.hap.Service.AirQualitySensor.UUID) {
      // Eve Room 2 (2018)
      this.EveHome = this.#createEveSession(
        historyService,
        service,
        service.UUID,
        service.subtype,
        'room2',
        [
          EVE_HISTORY_FIELDS.temperature,
          EVE_HISTORY_FIELDS.humidity,
          EVE_HISTORY_FIELDS.vocDensity,
          EVE_HISTORY_FIELDS.room2Unknown29,
          EVE_HISTORY_FIELDS.batteryLevel,
          EVE_HISTORY_FIELDS.room2BatteryVoltage,
          EVE_HISTORY_FIELDS.room2Unknown28,
        ],
        options,
      );

      service.updateCharacteristic(
        this.hap.Characteristic.EveFirmware,
        encodeEveData(util.format('27 %s be', numberToEveHexString(1416, 4))),
      ); // firmware version (build xxxx)));

      // Need to ensure HomeKit accessory which has Air Quality service also has temperature & humidity services.
      // Temperature service needs characteristic this.hap.Characteristic.TemperatureDisplayUnits set to CELSIUS
    }

    if (service.UUID === this.hap.Service.TemperatureSensor.UUID) {
      // Eve Room (2015)
      this.EveHome = this.#createEveSession(
        historyService,
        service,
        service.UUID,
        service.subtype,
        'room',
        [EVE_HISTORY_FIELDS.temperature, EVE_HISTORY_FIELDS.humidity, EVE_HISTORY_FIELDS.ppm, EVE_HISTORY_FIELDS.vocHeatSense],
        options,
      );

      service.updateCharacteristic(
        this.hap.Characteristic.EveFirmware,
        encodeEveData(util.format('02 %s be', numberToEveHexString(1151, 4))),
      ); // firmware version (build xxxx)));

      // Temperature needs to be in Celsius
      service.updateCharacteristic(
        this.hap.Characteristic.TemperatureDisplayUnits,
        this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS,
      );
    }
  }

  #linkEveMotion(service, options) {
    // treat these as EveHome Motion

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveMotionSensitivity,
      this.hap.Characteristic.EveMotionDuration,
      this.hap.Characteristic.EveLastActivation,
      // this.hap.Characteristic.EveGetConfiguration,
      // this.hap.Characteristic.EveSetConfiguration,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'motion',
      [EVE_HISTORY_FIELDS.motionDetected, EVE_HISTORY_FIELDS.motionActive],
      options,
    );

    // Need some internal storage to track Eve Motion configuration from EveHome app
    this.EveMotionPersist = {
      duration: typeof options?.EveMotion_duration === 'number' ? options.EveMotion_duration : 5, // default 5 seconds
      sensitivity:
        typeof options?.EveMotion_sensitivity === 'number'
          ? options.EveMotion_sensitivity
          : this.hap.Characteristic.EveMotionSensitivity.HIGH, // default sensitivity
      ledmotion: options?.EveMotion_ledmotion === true, // off
    };

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(this.hap.Characteristic.EveLastActivation, this.#EveLastEventTime());

    service.getCharacteristic(this.hap.Characteristic.EveLastActivation).onGet(() => {
      return this.#EveLastEventTime(); // time of last event in seconds since first event
    });

    service.updateCharacteristic(this.hap.Characteristic.EveMotionSensitivity, this.EveMotionPersist.sensitivity);
    service.getCharacteristic(this.hap.Characteristic.EveMotionSensitivity).onGet(() => {
      return this.EveMotionPersist.sensitivity;
    });
    service.getCharacteristic(this.hap.Characteristic.EveMotionSensitivity).onSet((value) => {
      this.EveMotionPersist.sensitivity = value;
    });

    service.updateCharacteristic(this.hap.Characteristic.EveMotionDuration, this.EveMotionPersist.duration);
    service.getCharacteristic(this.hap.Characteristic.EveMotionDuration).onGet(() => {
      return this.EveMotionPersist.duration;
    });
    service.getCharacteristic(this.hap.Characteristic.EveMotionDuration).onSet((value) => {
      this.EveMotionPersist.duration = value;
    });
  }

  async #linkEveSmoke(service, options) {
    // treat these as EveHome Smoke

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveGetConfiguration,
      this.hap.Characteristic.EveSetConfiguration,
      this.hap.Characteristic.EveDeviceStatus,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'smoke',
      [
        EVE_HISTORY_FIELDS.smokeStatus,
        EVE_HISTORY_FIELDS.smokeDetail,
        EVE_HISTORY_FIELDS.smokeVocHeatSense,
        EVE_HISTORY_FIELDS.smokeBatteryVoltage,
      ],
      options,
    );

    // TODO: Determine the complete Eve Smoke history field signature.
    // Also, how to make alarm test button active in Eve app and not say 'Eve Smoke is not mounted correctly'

    // Need some internal storage to track Eve Smoke configuration from EveHome app
    this.EveSmokePersist = {
      firmware: typeof options?.EveSmoke_firmware === 'number' ? options.EveSmoke_firmware : 1208, // Firmware version
      lastalarmtest: typeof options?.EveSmoke_lastalarmtest === 'number' ? options.EveSmoke_lastalarmtest : 0, // Seconds of alarm test
      alarmtest: options?.EveSmoke_alarmtest === true, // Is alarmtest running
      heatstatus: options.EveSmoke_heatstatus === true, // Heat sensor status
      statusled: options?.EveSmoke_statusled === false, // Status LED flash/enabled
      smoketestpassed: options?.EveSmoke_smoketestpassed === false, // Passed smoke test?
      heattestpassed: options?.EveSmoke_heattestpassed === false, // Passed smoke test?
      hushedstate: options.EveSmoke_hushedstate === true, // Alarms muted
    };

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(
      this.hap.Characteristic.EveDeviceStatus,
      await this.#getEveDetails(this.hap.Characteristic.EveDeviceStatus),
    );
    service.getCharacteristic(this.hap.Characteristic.EveDeviceStatus).onGet(async () => {
      return await this.#getEveDetails(this.hap.Characteristic.EveDeviceStatus);
    });

    service.updateCharacteristic(
      this.hap.Characteristic.EveGetConfiguration,
      await this.#getEveDetails(this.hap.Characteristic.EveGetConfiguration),
    );
    service.getCharacteristic(this.hap.Characteristic.EveGetConfiguration).onGet(async () => {
      return await this.#getEveDetails(this.hap.Characteristic.EveGetConfiguration);
    });

    service.getCharacteristic(this.hap.Characteristic.EveSetConfiguration).onSet((value) => this.#setEveSmokeDetails(value));
  }

  async #linkEveAqua(service, options) {
    // treat an irrigation system as EveHome Aqua
    // Under this, any valve history will be presented under this. We don't log our History under irrigation service ID at all

    // TODO - see if we can add history per valve service under the irrigation system????. History service per valve???

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveGetConfiguration,
      this.hap.Characteristic.EveSetConfiguration,
      this.hap.Characteristic.LockPhysicalControls,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      this.hap.Service.Valve.UUID,
      service.UUID === this.hap.Service.IrrigationSystem.UUID ? null : service.subtype,
      'aqua',
      [EVE_HISTORY_FIELDS.inUse, EVE_HISTORY_FIELDS.waterUsage, EVE_HISTORY_FIELDS.batteryVoltage],
      options,
    );

    // Need some internal storage to track Eve Aqua configuration from EveHome app
    this.EveAquaPersist = {
      firmware: typeof options?.EveAqua_firmware === 'number' ? options.EveAqua_firmware : 1208, // Firmware version
      flowrate: typeof options?.EveAqua_flowrate === 'number' ? options.EveAqua_flowrate : 18, // 18 L/Min default
      latitude: typeof options?.EveAqua_latitude === 'number' ? options.EveAqua_latitude : 0.0, // Latitude
      longitude: typeof options?.EveAqua_longitude === 'number' ? options.EveAqua_longitude : 0.0, // Longitude
      utcoffset: typeof options?.EveAqua_utcoffset === 'number' ? options.EveAqua_utcoffset : new Date().getTimezoneOffset() * -60, // UTC offset in seconds
      enableschedule: options.EveAqua_enableschedule === true, // Schedules on/off
      pause: typeof options?.EveAqua_pause === 'number' ? options.EveAqua_pause : 0, // Day pause
      programs: typeof options?.EveAqua_programs === 'object' ? options.EveAqua_programs : [], // Schedules
    };

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(this.hap.Characteristic.EveGetConfiguration, await this.#getEveDetails());
    service.getCharacteristic(this.hap.Characteristic.EveGetConfiguration).onGet(async () => {
      return this.#getEveDetails();
    });

    service.getCharacteristic(this.hap.Characteristic.EveSetConfiguration).onSet((value) => this.#setEveAquaDetails(service, value));
  }

  async #linkEveEnergy(service, options) {
    // treat these as EveHome energy
    // TODO - schedules

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveFirmware,
      this.hap.Characteristic.EveElectricalVoltage,
      this.hap.Characteristic.EveElectricalCurrent,
      this.hap.Characteristic.EveElectricalWattage,
      this.hap.Characteristic.EveTotalConsumption,
    ]);

    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      service.subtype,
      'energy',
      [EVE_HISTORY_FIELDS.power, EVE_HISTORY_FIELDS.onOff],
      options,
    );

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(this.hap.Characteristic.EveFirmware, encodeEveData(util.format('29 %s be', numberToEveHexString(807, 4))));

    service.updateCharacteristic(
      this.hap.Characteristic.EveElectricalCurrent,
      await this.#getEveDetails(this.hap.Characteristic.EveElectricalCurrent),
    );
    service.getCharacteristic(this.hap.Characteristic.EveElectricalCurrent).onGet(async () => {
      return await this.#getEveDetails(this.hap.Characteristic.EveElectricalCurrent);
    });

    service.updateCharacteristic(
      this.hap.Characteristic.EveElectricalVoltage,
      await this.#getEveDetails(this.hap.Characteristic.EveElectricalVoltage),
    );
    service.getCharacteristic(this.hap.Characteristic.EveElectricalVoltage).onGet(async () => {
      return await this.#getEveDetails(this.hap.Characteristic.EveElectricalVoltage);
    });

    service.updateCharacteristic(
      this.hap.Characteristic.EveElectricalWattage,
      await this.#getEveDetails(this.hap.Characteristic.EveElectricalWattage),
    );
    service.getCharacteristic(this.hap.Characteristic.EveElectricalWattage).onGet(async () => {
      return await this.#getEveDetails(this.hap.Characteristic.EveElectricalWattage);
    });
  }

  async #linkEveWaterGuard(service, options) {
    // Treat a standard HomeKit LeakSensor as an Eve Water Guard.

    // Setup the history service and the required characteristics for this service UUID type
    // Callbacks setup below after this is created
    let historyService = this.#createHistoryService(service, [
      this.hap.Characteristic.EveGetConfiguration,
      this.hap.Characteristic.EveSetConfiguration,
      this.hap.Characteristic.StatusFault,
    ]);

    // A real Water Guard advertises one one-byte history field: tag 0x2d.
    this.EveHome = this.#createEveSession(
      historyService,
      service,
      service.UUID,
      // LeakSensor history is normalised to subtype zero when recorded.
      0,
      'waterguard',
      [EVE_HISTORY_FIELDS.leakStatus],
      options,
    );

    // Need some internal storage to track Eve Water Guard configuration from EveHome app
    this.EveWaterGuardPersist = {
      firmware: typeof options?.EveWaterGuard_firmware === 'number' ? options.EveWaterGuard_firmware : 2866, // Firmware version
      lastalarmtest: typeof options?.EveWaterGuard_lastalarmtest === 'number' ? options.EveWaterGuard_lastalarmtest : 0, // In seconds
      alarmtest: options?.EveWaterGuard_alarmtest === true, // Alarm test currently active
      alarmtestduration:
        typeof options?.EveWaterGuard_alarmtestduration === 'number'
          ? options.EveWaterGuard_alarmtestduration
          : EVE_WATER_GUARD_ALARM_TEST_SECONDS,
      muted: options?.EveWaterGuard_muted === true, // Leak alarms are not muted
    };

    // Set initial values and callbacks for the characteristics used by this adapter.
    service.updateCharacteristic(this.hap.Characteristic.EveGetConfiguration, await this.#getEveDetails());
    service.getCharacteristic(this.hap.Characteristic.EveGetConfiguration).onGet(async () => {
      return await this.#getEveDetails();
    });

    service.getCharacteristic(this.hap.Characteristic.EveSetConfiguration).onSet((value) => this.#setEveWaterGuardDetails(service, value));
  }

  /**
   * Decodes Eve TLV8 command streams while rejecting malformed or truncated trailing data.
   *
   * @param {string} value Base64-encoded HomeKit characteristic value.
   * @param {string} deviceName Device family used in diagnostics.
   * @returns {Array<{command: string, data: string}>} Valid command payloads in wire order.
   * @private
   */
  #decodeEveTLVCommands(value, deviceName) {
    // Eve sends the proprietary command stream as Base64; parsing is performed on its hexadecimal byte representation.
    let valHex = decodeEveData(value);
    let commands = [];

    // A missing or non-string HomeKit value contains no commands and must not reach Buffer or string operations below.
    if (typeof valHex !== 'string') {
      return commands;
    }

    let index = 0;
    while (index < valHex.length) {
      // Each TLV record needs two header bytes: one command byte followed by one payload-length byte.
      if (index + 4 > valHex.length) {
        this?.log?.warn?.('Truncated Eve %s command header', deviceName);
        break;
      }

      let command = valHex.slice(index, index + 2);
      let byteLength = Number.parseInt(valHex.slice(index + 2, index + 4), 16);
      let payloadStart = index + 4;

      // Hex uses two characters per byte, so convert the advertised byte length before locating the next record.
      let payloadEnd = payloadStart + byteLength * 2;

      // Stop at the first malformed record; continuing from a partial payload would desynchronise every following command.
      if (Number.isInteger(byteLength) === false || payloadEnd > valHex.length) {
        this?.log?.warn?.('Invalid Eve %s command "%s"', deviceName, command);
        break;
      }

      commands.push({ command, data: valHex.slice(payloadStart, payloadEnd) });

      // Advance directly to the next command header, including zero-length payloads.
      index = payloadEnd;
    }

    return commands;
  }

  #setEveBlindDetails(service, value) {
    for (let { command, data } of this.#decodeEveTLVCommands(value, 'MotionBlinds')) {
      switch (command) {
        case '00': {
          // end of command?
          break;
        }

        case 'f0': {
          // set limits
          // data
          // 02 bottom position set
          // 01 top position set
          // 04 favourite position set
          break;
        }

        case 'f1': {
          // orientation set??
          break;
        }

        case 'f3': {
          // move window covering to set limits
          // xxyyyy - xx = move command (01 = up, 02 = down, 03 = stop), yyyy - distance/time/ticks/increment to move??
          //let moveCommand = data.substring(0, 2);
          //let moveAmount = EveHexStringToNumber(data.substring(2));

          let currentPosition = service.getCharacteristic(this.hap.Characteristic.CurrentPosition).value;
          if (data === '015802') {
            currentPosition = currentPosition + 1;
          }
          if (data === '025802') {
            currentPosition = currentPosition - 1;
          }
          service.updateCharacteristic(this.hap.Characteristic.CurrentPosition, currentPosition);
          service.updateCharacteristic(this.hap.Characteristic.TargetPosition, currentPosition);
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve MotionBlinds command "%s" with data "%s"', command, data);
          break;
        }
      }
    }
  }

  async #setEveThermoDetails(value) {
    let programs = [];
    let processedData = {};
    let valHex = decodeEveData(value);

    // Preserve the complete packet in debug output because Thermo command widths remain partly reverse-engineered.
    // Logging before parsing keeps captures usable even when an unknown command desynchronises the decoder.
    this?.log?.debug?.('Eve Thermo ProgramCommand "%s"', valHex);

    let index = 0;
    while (index < valHex.length) {
      let command = valHex.slice(index, index + 2);
      index += 2; // skip over command value, and this is where data starts.
      switch (command) {
        case '00': {
          // start of command string ??
          break;
        }

        case '06': {
          // end of command string ??
          break;
        }

        case '7f': {
          // end of command string ??
          break;
        }

        case '11': {
          // Valve Protection produces `00 11 ff00 f2 2076`. Command 0x11 owns
          // the first two bytes; 0xf2 is a separate command in the same stream.
          this?.log?.debug?.('Eve Thermo command 0x11 data "%s"', valHex.slice(index, index + 4));
          index += 4;
          break;
        }

        case '10': {
          // OK to remove
          break;
        }

        case '12': {
          // temperature offset
          // 8bit signed value. Divide by 10 to get float value
          this.EveThermoPersist.tempoffset = EveHexStringToNumber(valHex.slice(index, index + 2)) / 10;
          processedData.tempoffset = this.EveThermoPersist.tempoffset;
          index += 2;
          break;
        }

        case '13': {
          // schedules enabled/disable
          this.EveThermoPersist.enableschedule = valHex.slice(index, index + 2) === '01' ? true : false;
          processedData.enableschedule = this.EveThermoPersist.enableschedule;
          index += 2;
          break;
        }

        case '14': {
          // Installed status
          index += 2;
          break;
        }

        case '18': {
          // Pause/resume via HomeKit automation/scene
          // 20 - pause thermostat operation
          // 10 - resume thermostat operation
          this.EveThermoPersist.pause = valHex.slice(index, index + 2) === '20' ? true : false;
          processedData.pause = this.EveThermoPersist.pause;
          index += 2;
          break;
        }

        case '19': {
          // Vacation on/off, vacation temperature via HomeKit automation/scene
          this.EveThermoPersist.vacation = valHex.slice(index, index + 2) === '01' ? true : false;
          this.EveThermoPersist.vacationtemp =
            valHex.slice(index, index + 2) === '01' ? parseInt(valHex.slice(index + 2, index + 4), 16) * 0.5 : null;
          processedData.vacation = {
            status: this.EveThermoPersist.vacation,
            temp: this.EveThermoPersist.vacationtemp,
          };
          index += 4;
          break;
        }

        case 'f4': {
          // Temperature Levels for schedule
          let ecoTemp = valHex.slice(index + 2, index + 4) === '80' ? null : parseInt(valHex.slice(index + 2, index + 4), 16) * 0.5;
          let comfortTemp = valHex.slice(index + 4, index + 6) === '80' ? null : parseInt(valHex.slice(index + 4, index + 6), 16) * 0.5;
          processedData.scheduleTemps = {
            eco: ecoTemp,
            comfort: comfortTemp,
          };
          index += 6;
          break;
        }

        case 'fc': {
          // Date/Time mmhhDDMMYY
          index += 10;
          break;
        }

        case 'fa': {
          // Programs (week - mon, tue, wed, thu, fri, sat, sun)
          // index += 112;
          for (let index2 = 0; index2 < 7; index2++) {
            let times = [];
            for (let index3 = 0; index3 < 4; index3++) {
              // decode start time
              let start = parseInt(valHex.slice(index, index + 2), 16);
              //let start_min = null;
              //let start_hr = null;
              let start_offset = null;
              if (start !== 0xff) {
                //start_min = (start * 10) % 60;   // Start minute
                //start_hr = ((start * 10) - start_min) / 60;    // Start hour
                start_offset = start * 10 * 60; // Seconds since 00:00
              }

              // decode end time
              let end = parseInt(valHex.slice(index + 2, index + 4), 16);
              //let end_min = null;
              //let end_hr = null;
              let end_offset = null;
              if (end !== 0xff) {
                //end_min = (end * 10) % 60;   // End minute
                //end_hr = ((end * 10) - end_min) / 60;    // End hour
                end_offset = end * 10 * 60; // Seconds since 00:00
              }

              if (start_offset !== null && end_offset !== null) {
                times.push({
                  start: start_offset,
                  duration: end_offset - start_offset,
                  ecotemp: processedData.scheduleTemps.eco,
                  comforttemp: processedData.scheduleTemps.comfort,
                });
              }
              index += 4;
            }
            programs.push({
              id: programs.length + 1,
              days: DAYS_OF_WEEK[index2],
              schedule: times,
            });
          }

          this.EveThermoPersist.programs = programs;
          processedData.programs = this.EveThermoPersist.programs;
          break;
        }

        case '1a': {
          // Free-day program: one daily schedule containing four start/end pairs.
          index += 16;
          break;
        }

        case 'f2': {
          // Valve Protection companion command. Its state meaning remains unknown,
          // but consuming its two-byte payload preserves following command boundaries.
          this?.log?.debug?.('Eve Thermo command 0xf2 data "%s"', valHex.slice(index, index + 4));
          index += 4;
          break;
        }

        case 'f6': {
          //??
          index += 6;
          break;
        }

        case 'ff': {
          // Eve sends the complete special packet `ff04f6` around schedule reads.
          // Its purpose and the meanings of 0x04 and 0xf6 remain unknown.
          index += 4;
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve Thermo command "%s"', command);
          break;
        }
      }
    }

    // Send complete processed command data via message router if defined
    if (typeof this.EveHome?.messages === 'function' && Object.keys(processedData).length !== 0) {
      await this.EveHome.messages(HomeKitHistory.SET, processedData);
    }
  }

  async #setEveSmokeDetails(value) {
    let processedData = {};
    for (let { command, data } of this.#decodeEveTLVCommands(value, 'Smoke')) {
      switch (command) {
        case '40': {
          let subCommand = EveHexStringToNumber(data.slice(0, 2));
          if (subCommand === 0x02) {
            // Alarm test start/stop
            this.EveSmokePersist.alarmtest = data === '0201' ? true : false;
            processedData.alarmtest = this.EveSmokePersist.alarmtest;
          }
          if (subCommand === 0x05) {
            // Flash status Led on/off
            this.EveSmokePersist.statusled = data === '0501' ? true : false;
            processedData.statusled = this.EveSmokePersist.statusled;
          }
          if (subCommand !== 0x02 && subCommand !== 0x05) {
            this?.log?.debug?.('Unknown Eve Smoke command "%s" with data "%s"', command, data);
          }
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve Smoke command "%s" with data "%s"', command, data);
          break;
        }
      }
    }

    // Send complete processed command data via message router if defined
    if (typeof this.EveHome?.messages === 'function' && Object.keys(processedData).length !== 0) {
      await this.EveHome.messages(HomeKitHistory.SET, processedData);
    }
  }

  async #setEveAquaDetails(service, value) {
    // Aqua configuration writes are TLV8 records containing a command byte, payload length, and payload.
    let programs = [];
    let processedData = {};
    for (let { command, data } of this.#decodeEveTLVCommands(value, 'Aqua')) {
      switch (command) {
        case '2e': {
          // flow rate in L/Minute
          this.EveAquaPersist.flowrate = Number(((EveHexStringToNumber(data) * 60) / 1000).toFixed(1));
          processedData.flowrate = this.EveAquaPersist.flowrate;
          break;
        }

        case '2f': {
          // reset timestamp in seconds since EPOCH
          this.EveAquaPersist.timestamp = EPOCH_OFFSET + EveHexStringToNumber(data);
          processedData.timestamp = this.EveAquaPersist.timestamp;
          break;
        }

        case '44': {
          // Schedules on/off and Timezone/location information
          let subCommand = EveHexStringToNumber(data.slice(2, 6));
          this.EveAquaPersist.enableschedule = (subCommand & 0x01) === 0x01; // Flag 0x01 is schedule status on/off
          if ((subCommand & 0x10) === 0x10) {
            this.EveAquaPersist.utcoffset = EveHexStringToNumber(data.slice(10, 18)) * 60; // Flag 0x10 includes UTC offset in minutes
          }
          if ((subCommand & 0x04) === 0x04) {
            // Flag 0x04 includes both IEEE-754 location coordinates.
            this.EveAquaPersist.latitude = EveHexStringToNumber(data.slice(18, 26), 5);
            this.EveAquaPersist.longitude = EveHexStringToNumber(data.slice(26, 34), 5);
          }
          if ((subCommand & 0x02) === 0x02) {
            // If bit 2 is set, indicates just a schedule on/off command
            processedData.enabled = this.EveAquaPersist.enableschedule;
          }
          if ((subCommand & 0x02) !== 0x02) {
            // If bit 2 is not set, this command includes Timezone/location information
            processedData.utcoffset = this.EveAquaPersist.utcoffset;
            processedData.latitude = this.EveAquaPersist.latitude;
            processedData.longitude = this.EveAquaPersist.longitude;
          }
          break;
        }

        case '45': {
          // Eve App Scheduling Programs
          let index2 = 14; // Program schedules start at offset 14 in data
          programs = [];
          while (index2 + 4 <= data.length) {
            let scheduleSize = parseInt(data.slice(index2 + 2, index2 + 4), 16) * 8;
            let schedule = data.substring(index2 + 4, index2 + 4 + scheduleSize);

            // Ignore an incomplete nested program rather than decoding partial schedule words.
            if (Number.isInteger(scheduleSize) === false || index2 + 4 + scheduleSize > data.length) {
              this?.log?.warn?.('Invalid Eve Aqua schedule program');
              break;
            }

            if (schedule !== '' && schedule.length % 8 === 0) {
              let times = [];
              for (let index3 = 0; index3 < schedule.length / 8; index3++) {
                // schedules appear to be a 32bit word
                // after swapping 16bit words
                // 1st 16bits = start time
                // 2nd 16bits = end time
                // starttime decode
                // bit 1-5 specific time or sunrise/sunset 05 = time, 07 = sunrise/sunset
                // if sunrise/sunset
                //      bit 6, sunrise = 1, sunset = 0
                //      bit 7, before = 1, after = 0
                //      bit 8 - 16 - minutes for sunrise/sunset
                // if time
                //      bit 6 - 16 - minutes from 00:00
                //
                // endtime decode
                // bit 1-5 specific time or sunrise/sunset 01 = time, 03 = sunrise/sunset
                // if sunrise/sunset
                //      bit 6, sunrise = 1, sunset = 0
                //      bit 7, before = 1, after = 0
                //      bit 8 - 16 - minutes for sunrise/sunset
                // if time
                //      bit 6 - 16 - minutes from 00:00
                // decode start time
                let start = parseInt(
                  schedule
                    .substring(index3 * 8, index3 * 8 + 4)
                    .match(/[a-fA-F0-9]{2}/g)
                    .reverse()
                    .join(''),
                  16,
                );
                // let start_min = null;
                //let start_hr = null;
                let start_offset = null;
                let start_sunrise = null;
                if ((start & 0x1f) === 5) {
                  // specific time
                  //start_min = (start >>> 5) % 60;   // Start minute
                  //start_hr = ((start >>> 5) - start_min) / 60;    // Start hour
                  start_offset = (start >>> 5) * 60; // Seconds since 00:00
                } else if ((start & 0x1f) === 7) {
                  // sunrise/sunset
                  start_sunrise = (start >>> 5) & 0x01; // 1 = sunrise, 0 = sunset
                  start_offset = (start >>> 6) & 0x01 ? ~((start >>> 7) * 60) + 1 : (start >>> 7) * 60; // offset from sunrise/sunset (plus/minus value)
                }

                // decode end time
                let end = parseInt(
                  schedule
                    .substring(index3 * 8 + 4, index3 * 8 + 8)
                    .match(/[a-fA-F0-9]{2}/g)
                    .reverse()
                    .join(''),
                  16,
                );
                //let end_min = null;
                //let end_hr = null;
                let end_offset = null;
                //let end_sunrise = null;
                if ((end & 0x1f) === 1) {
                  // specific time
                  //end_min = (end >>> 5) % 60;   // End minute
                  //end_hr = ((end >>> 5) - end_min) / 60;    // End hour
                  end_offset = (end >>> 5) * 60; // Seconds since 00:00
                } else if ((end & 0x1f) === 3) {
                  //end_sunrise = ((end >>> 5) & 0x01);    // 1 = sunrise, 0 = sunset
                  end_offset = (end >>> 6) & 0x01 ? ~((end >>> 7) * 60) + 1 : (end >>> 7) * 60; // offset sunrise/sunset (+/- value)
                }
                times.push({
                  start: start_sunrise === null ? start_offset : start_sunrise ? 'sunrise' : 'sunset',
                  duration: end_offset - start_offset,
                  offset: start_offset,
                });
              }
              programs.push({
                id: programs.length + 1,
                days: [],
                schedule: times,
              });
            }
            index2 = index2 + 4 + scheduleSize; // Move to next program
          }
          break;
        }

        case '46': {
          // Eve App active days across programs
          // Three-bit values map each weekday to an Eve program identifier.
          let daysbitmask = EveHexStringToNumber(data.slice(8, 14)) >>> 4;
          programs.forEach((program) => {
            for (let index2 = 0; index2 < DAYS_OF_WEEK.length; index2++) {
              if (((daysbitmask >>> (index2 * 3)) & 0x7) === program.id) {
                program.days.push(DAYS_OF_WEEK[index2]);
              }
            }
          });

          processedData.programs = programs;
          break;
        }

        case '47': {
          // Eve App DST information
          this.EveAquaPersist.command47 = command + numberToEveHexString(data.length / 2, 2) + data;
          break;
        }

        case '4b': {
          // Eve App suspension scene triggered from HomeKit
          // 1440 mins in a day. Zero based day, so we add one
          this.EveAquaPersist.pause = EveHexStringToNumber(data.slice(0, 8)) / 1440 + 1;
          processedData.pause = this.EveAquaPersist.pause;
          break;
        }

        case 'b1': {
          // Child lock on/off. Seems data packet is always same (0100)
          // inspect 'this.hap.Characteristic.LockPhysicalControls)' for actual status
          this.EveAquaPersist.childlock =
            service.getCharacteristic(this.hap.Characteristic.LockPhysicalControls).value === this.hap.Characteristic.CONTROL_LOCK_ENABLED
              ? true
              : false;
          processedData.childlock = this.EveAquaPersist.childlock;
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve Aqua command "%s" with data "%s"', command, data);
          break;
        }
      }
    }

    // Send complete processed command data via message router if defined
    if (typeof this.EveHome?.messages === 'function' && Object.keys(processedData).length !== 0) {
      await this.EveHome.messages(HomeKitHistory.SET, processedData);
    }
  }

  async #setEveWaterGuardDetails(service, value) {
    let processedData = {};
    for (let { command, data } of this.#decodeEveTLVCommands(value, 'Water Guard')) {
      switch (command) {
        case '4d': {
          // Alarm-test window in seconds: 0xb4 starts the three-minute test and 0x00 finishes it.
          if (data.length === 2) {
            let alarmTestDuration = parseInt(data, 16);
            processedData.alarmtest = this.EveWaterGuardPersist.alarmtest = alarmTestDuration > 0;
            if (alarmTestDuration > 0) {
              processedData.alarmtestduration = this.EveWaterGuardPersist.alarmtestduration = alarmTestDuration;
            }
          }
          break;
        }

        case '4e': {
          // Mute alarm
          // 00 - unmute alarm
          // 01 - mute alarm
          // 03 - alarm test
          if (data === '03') {
            // The persisted duration is initialised with the captured default and may be replaced by a preceding 0x4d command.
            service.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.hap.Characteristic.LeakDetected.LEAK_DETECTED);
            this.EveWaterGuardPersist.alarmtest = true;
            this.EveWaterGuardPersist.lastalarmtest = Math.floor(Date.now() / 1000); // Now time for last test
            processedData.alarmtest = this.EveWaterGuardPersist.alarmtest;
            processedData.alarmtestduration = this.EveWaterGuardPersist.alarmtestduration;
            processedData.lastalarmtest = this.EveWaterGuardPersist.lastalarmtest;

            let alarmTestTimer = setTimeout(() => {
              // Clear the simulated leak when the advertised 0x4d test window expires.
              this.EveWaterGuardPersist.alarmtest = false;
              service.updateCharacteristic(this.hap.Characteristic.LeakDetected, this.hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
            }, this.EveWaterGuardPersist.alarmtestduration * 1000);
            alarmTestTimer.unref?.();
          }
          if (data === '00' || data === '01') {
            this.EveWaterGuardPersist.muted = data === '01' ? true : false;
            processedData.muted = this.EveWaterGuardPersist.muted;
          }
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve Water Guard command "%s" with data "%s"', command, data);
          break;
        }
      }
    }

    // Forward only understood writes so the owning device can apply mute and test requests.
    if (typeof this.EveHome?.messages === 'function' && Object.keys(processedData).length !== 0) {
      await this.EveHome.messages(HomeKitHistory.SET, processedData);
    }
  }

  async #setEveLightStripDetails(value) {
    let processedData = {};
    let activeTransition = EVE_LIGHT_STRIP_TRANSITIONS[this.EveLightStripPersist.transition];
    let transitionValues = (activeTransition === undefined ? EVE_LIGHT_STRIP_TRANSITIONS.default : activeTransition).slice();
    let receivedTransition = false;

    for (let { command, data } of this.#decodeEveTLVCommands(value, 'Light Strip')) {
      switch (command) {
        case '65': {
          // Power On Behavior: 1 restores the last colour and 2 selects default white.
          let powerOnBehavior = data.length === 2 ? EveHexStringToNumber(data) : undefined;
          if (powerOnBehavior === 1 || powerOnBehavior === 2) {
            processedData.poweronbehavior = this.EveLightStripPersist.poweronbehavior = powerOnBehavior;
          }
          break;
        }

        case '6c':
        case '6a':
        case '6b': {
          // Eve sends three little-endian millisecond timings that together identify one preset.
          if (data.length === 4) {
            let transitionIndex = command === '6c' ? 0 : command === '6a' ? 1 : 2;
            transitionValues[transitionIndex] = EveHexStringToNumber(data);
            receivedTransition = true;
          }
          break;
        }

        default: {
          this?.log?.debug?.('Unknown Eve Light Strip command "%s" with data "%s"', command, data);
          break;
        }
      }
    }

    if (receivedTransition === true) {
      let transition = Object.keys(EVE_LIGHT_STRIP_TRANSITIONS).find((name) => {
        return EVE_LIGHT_STRIP_TRANSITIONS[name].every((duration, index) => duration === transitionValues[index]);
      });
      if (typeof transition === 'string') {
        processedData.transition = this.EveLightStripPersist.transition = transition;
      } else {
        this?.log?.debug?.('Unknown Eve Light Strip transition timings "%s"', transitionValues.join(','));
      }
    }

    if (typeof this.EveHome?.messages === 'function' && Object.keys(processedData).length !== 0) {
      await this.EveHome.messages(HomeKitHistory.SET, processedData);
    }
  }

  /**
   * Refreshes dynamic proprietary characteristics for an already-linked Eve service.
   * History-only adapters require no work here.
   *
   * @param {object} service Linked HAP service to refresh.
   * @returns {Promise<void>}
   */
  async updateEveHome(service) {
    if (typeof this?.EveHome?.service !== 'object' || typeof service !== 'object' || service === null) {
      return;
    }

    switch (service.UUID) {
      case this.hap.Service.Lightbulb.UUID: {
        service.updateCharacteristic(this.hap.Characteristic.EveGetConfiguration, await this.#getEveDetails());
        break;
      }

      case this.hap.Service.SmokeSensor.UUID: {
        service.updateCharacteristic(
          this.hap.Characteristic.EveDeviceStatus,
          await this.#getEveDetails(this.hap.Characteristic.EveDeviceStatus),
        );
        service.updateCharacteristic(
          this.hap.Characteristic.EveGetConfiguration,
          await this.#getEveDetails(this.hap.Characteristic.EveGetConfiguration),
        );
        break;
      }

      case this.hap.Service.HeaterCooler.UUID:
      case this.hap.Service.Thermostat.UUID: {
        service.updateCharacteristic(this.hap.Characteristic.EveProgramData, await this.#getEveDetails());
        break;
      }

      case this.hap.Service.Valve.UUID:
      case this.hap.Service.IrrigationSystem.UUID: {
        service.updateCharacteristic(this.hap.Characteristic.EveGetConfiguration, await this.#getEveDetails());
        break;
      }

      case this.hap.Service.Outlet.UUID: {
        service.updateCharacteristic(
          this.hap.Characteristic.EveElectricalWattage,
          await this.#getEveDetails(this.hap.Characteristic.EveElectricalWattage),
        );
        service.updateCharacteristic(
          this.hap.Characteristic.EveElectricalVoltage,
          await this.#getEveDetails(this.hap.Characteristic.EveElectricalVoltage),
        );
        service.updateCharacteristic(
          this.hap.Characteristic.EveElectricalCurrent,
          await this.#getEveDetails(this.hap.Characteristic.EveElectricalCurrent),
        );
        break;
      }
    }
  }

  // Device-family configuration encoders and message-router integration.
  #EveLastEventTime() {
    // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
    let historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
    let lastTime = Math.floor(Date.now() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
    if (isNaN(historyEntry?.time) === false) {
      lastTime -= Math.floor(Date.now() / 1000) - historyEntry.time;
    }
    return lastTime;
  }

  // Ask the owning device for current Eve details while preserving the adapter's known-good defaults.
  // Routers may return only changed properties; invalid results and failures leave the prior state intact.
  async #refreshEveDetails(currentState) {
    if (typeof this.EveHome?.messages !== 'function') {
      return currentState;
    }

    try {
      // Pass a new top-level object so a router cannot mutate active state before its result is validated.
      let updatedState = await this.EveHome.messages(HomeKitHistory.GET, { ...currentState });
      if (typeof updatedState !== 'object' || updatedState === null || Array.isArray(updatedState) === true) {
        return currentState;
      }
      return { ...currentState, ...updatedState };
    } catch (error) {
      this?.log?.warn?.('Unable to refresh Eve details: %s', formatError(error));
      return currentState;
    }
  }

  // Run the shared GET lifecycle, then route the refreshed state to the active Eve family's formatter.
  async #getEveDetails(returnForCharacteristic) {
    switch (this.EveHome?.evetype) {
      case 'thermo': {
        this.EveThermoPersist = await this.#refreshEveDetails(this.EveThermoPersist);
        return this.#encodeEveThermoDetails(this.EveThermoPersist);
      }

      case 'aqua': {
        this.EveAquaPersist = await this.#refreshEveDetails(this.EveAquaPersist);
        return this.#encodeEveAquaDetails(this.EveAquaPersist);
      }

      case 'energy': {
        let details = await this.#refreshEveDetails({});
        return this.#readEveEnergyValue(details, returnForCharacteristic);
      }

      case 'lightstrip': {
        this.EveLightStripPersist = await this.#refreshEveDetails(this.EveLightStripPersist);
        return this.#encodeEveLightStripDetails(this.EveLightStripPersist);
      }

      case 'smoke': {
        this.EveSmokePersist = await this.#refreshEveDetails(this.EveSmokePersist);
        if (returnForCharacteristic?.UUID === this.hap.Characteristic.EveGetConfiguration.UUID) {
          return this.#encodeEveSmokeDetails(this.EveSmokePersist);
        }
        if (returnForCharacteristic?.UUID === this.hap.Characteristic.EveDeviceStatus.UUID) {
          return this.#readEveSmokeStatus(this.EveSmokePersist);
        }
        break;
      }

      case 'waterguard': {
        this.EveWaterGuardPersist = await this.#refreshEveDetails(this.EveWaterGuardPersist);
        return this.#encodeEveWaterGuardDetails(this.EveWaterGuardPersist);
      }
    }
    return null;
  }

  #encodeEveThermoDetails(details) {
    // returns an encoded value formatted for an Eve Thermo device
    //
    // TODO: Before enabling the fields below, determine:
    //          - mode graph to show
    //          - temperature unit setting
    //          - thermo 2020??
    //
    // commands
    // 11 - valve protection on/off - TODO
    // 12 - temp offset
    // 13 - schedules enabled/disabled
    // 16 - Window/Door open status
    //          100000 - open
    //          000000 - close
    // 14 - installation status
    //          c0,c8 = ok
    //          c1,c6,c9 = in-progress
    //          c2,c3,c4,c5 = error on removal
    //          c7 = not attached
    // 19 - vacation mode
    //          00ff - off
    //          01 + 'away temp' - enabled with vacation temp
    // f4 - temperatures
    // fa - programs for week
    // fc - date/time (mmhhDDMMYY)
    // 1a - free-day program

    // Encode current date/time
    //let tempDateTime = numberToEveHexString(new Date(Date.now()).getMinutes(), 2) +
    // numberToEveHexString(new Date(Date.now()).getHours(), 2) +
    // numberToEveHexString(new Date(Date.now()).getDate(), 2) +
    // numberToEveHexString(new Date(Date.now()).getMonth() + 1, 2) +
    // numberToEveHexString(parseInt(new Date(Date.now()).getFullYear().toString().slice(-2)), 2);

    // Encode program schedule and temperatures
    // f4 = temps
    // fa = schedule
    let encodedSchedule = [EMPTY_SCHEDULE, EMPTY_SCHEDULE, EMPTY_SCHEDULE, EMPTY_SCHEDULE, EMPTY_SCHEDULE, EMPTY_SCHEDULE, EMPTY_SCHEDULE];
    let encodedTemperatures = '0000';
    if (typeof details.programs === 'object' && details.programs !== null) {
      let tempTemperatures = [];
      Object.values(details.programs).forEach((days) => {
        let temp = '';
        days.schedule.forEach((time) => {
          temp =
            temp +
            numberToEveHexString(Math.round(time.start / 600), 2) +
            numberToEveHexString(Math.round((time.start + time.duration) / 600), 2);
          tempTemperatures.push(time.ecotemp, time.comforttemp);
        });
        encodedSchedule[DAYS_OF_WEEK.indexOf(days.days.toLowerCase())] =
          temp.substring(0, EMPTY_SCHEDULE.length) + EMPTY_SCHEDULE.substring(temp.length, EMPTY_SCHEDULE.length);
      });
      let ecoTemp = tempTemperatures.length === 0 ? 0 : Math.min(...tempTemperatures);
      let comfortTemp = tempTemperatures.length === 0 ? 0 : Math.max(...tempTemperatures);
      encodedTemperatures = numberToEveHexString(Math.round(ecoTemp * 2), 2) + numberToEveHexString(Math.round(comfortTemp * 2), 2);
    }

    let value = util.format(
      '12%s 13%s 14%s 19%s f40000%s fa%s',
      numberToEveHexString(details.tempoffset * 10, 2),
      details.enableschedule === true ? '01' : '00',
      details.attached === true ? 'c0' : 'c7',
      details.vacation === true ? '01' + numberToEveHexString(details.vacationtemp * 2, 2) : '00ff', // away status and temp
      encodedTemperatures,
      encodedSchedule[0] +
        encodedSchedule[1] +
        encodedSchedule[2] +
        encodedSchedule[3] +
        encodedSchedule[4] +
        encodedSchedule[5] +
        encodedSchedule[6],
    );

    return encodeEveData(value);
  }

  #encodeEveAquaDetails(details) {
    // returns an encoded value formatted for an Eve Aqua device for water usage and last water time

    if (Array.isArray(details.programs) === false) {
      // Ensure any program information is an array
      details = { ...details, programs: [] };
    }

    let tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

    // Calculate total water usage over history period
    let totalWater = 0;
    tempHistory.forEach((historyEntry) => {
      if (historyEntry.status === 0) {
        // add to total water usage if we have a valve closed event
        totalWater += parseFloat(historyEntry.water);
      }
    });

    // Encode program schedule
    // 45 = schedules
    // 46 = days of weeks for schedule;
    const EMPTY_SCHEDULE = '0800';
    let encodedSchedule = '';
    let daysbitmask = 0;
    let temp45Command = '';
    let temp46Command = '';

    details.programs.forEach((program) => {
      let tempEncodedSchedule = '';
      program.schedule.forEach((schedule) => {
        // Encode absolute time (ie: not sunrise/sunset one)
        if (typeof schedule.start === 'number') {
          tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString(((schedule.start / 60) << 5) + 0x05, 4);
          tempEncodedSchedule = tempEncodedSchedule + numberToEveHexString((((schedule.start + schedule.duration) / 60) << 5) + 0x01, 4);
        }
        if (typeof schedule.start === 'string' && schedule.start === 'sunrise') {
          // Encode start and end independently because a watering period can cross sunrise.
          tempEncodedSchedule = tempEncodedSchedule + encodeEveAquaSolarTime('sunrise', schedule.offset, true);
          tempEncodedSchedule = tempEncodedSchedule + encodeEveAquaSolarTime('sunrise', schedule.offset + schedule.duration, false);
        }
        if (typeof schedule.start === 'string' && schedule.start === 'sunset') {
          // The same independent encoding is required when a watering period crosses sunset.
          tempEncodedSchedule = tempEncodedSchedule + encodeEveAquaSolarTime('sunset', schedule.offset, true);
          tempEncodedSchedule = tempEncodedSchedule + encodeEveAquaSolarTime('sunset', schedule.offset + schedule.duration, false);
        }
      });
      encodedSchedule =
        encodedSchedule +
        numberToEveHexString(tempEncodedSchedule.length / 8 < 2 ? 10 : 11, 2) +
        numberToEveHexString(tempEncodedSchedule.length / 8, 2) +
        tempEncodedSchedule;

      // Encode days for this program
      // Program ID is set in 3bit repeating sections
      // sunsatfrithuwedtuemon
      program.days.forEach((day) => {
        daysbitmask = daysbitmask + (program.id << (DAYS_OF_WEEK.indexOf(day) * 3));
      });
    });

    // Build the encoded schedules command to send back to Eve
    temp45Command = '05' + numberToEveHexString(details.programs.length + 1, 2) + '000000' + EMPTY_SCHEDULE + encodedSchedule;
    temp45Command = '45' + numberToEveHexString(temp45Command.length / 2, 2) + temp45Command;

    // Build the encoded days command to send back to Eve
    // 00000 appears to always be 1b202c??
    temp46Command = '05' + '000000' + numberToEveHexString((daysbitmask << 4) + 0x0f, 6);
    temp46Command = temp46Command.padEnd(daysbitmask === 0 ? 18 : 168, '0'); // Pad the command out to Eve's lengths
    temp46Command = '46' + numberToEveHexString(temp46Command.length / 2, 2) + temp46Command;

    let value = util.format(
      '0002 2300 0302 %s d004 %s 9b04 %s 2f0e %s 00000000 %s 441105 %s%s%s%s %s %s %s 0000000000000000 1e02 2300 0c',
      numberToEveHexString(details.firmware, 4), // firmware version (build xxxx)
      numberToEveHexString(tempHistory.length !== 0 ? tempHistory[tempHistory.length - 1].time : 0, 8), // time of last event, 0 if never
      numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
      numberToEveHexString(Math.floor(totalWater * 1000), 16), // total water usage in ml (64bit value)
      numberToEveHexString(Math.floor((details.flowrate * 1000) / 60), 4), // final two payload bytes are water flow rate
      numberToEveHexString(details.enableschedule === true ? parseInt('10111', 2) : parseInt('10110', 2), 8),
      numberToEveHexString(Math.floor(details.utcoffset / 60), 8),
      numberToEveHexString(details.latitude, 8, 5), // For lat/long, we need 5 digits of precession
      numberToEveHexString(details.longitude, 8, 5), // For lat/long, we need 5 digits of precession
      details.pause !== 0 ? '4b04' + numberToEveHexString((details.pause - 1) * 1440, 8) : '',
      temp45Command,
      temp46Command,
    );

    return encodeEveData(value);
  }

  #readEveEnergyValue(details, returnForCharacteristic) {
    let returnValue = null;

    if (returnForCharacteristic.UUID === this.hap.Characteristic.EveElectricalWattage.UUID && typeof details.watts === 'number') {
      returnValue = details.watts;
    }
    if (returnForCharacteristic.UUID === this.hap.Characteristic.EveElectricalVoltage.UUID && typeof details.volts === 'number') {
      returnValue = details.volts;
    }
    if (returnForCharacteristic.UUID === this.hap.Characteristic.EveElectricalCurrent.UUID && typeof details.amps === 'number') {
      returnValue = details.amps;
    }

    return returnValue;
  }

  #encodeEveLightStripDetails(details) {
    // The three timing records must remain together because Eve treats them as one named transition preset.
    let transition =
      typeof details.transition === 'string' && EVE_LIGHT_STRIP_TRANSITIONS[details.transition] !== undefined
        ? EVE_LIGHT_STRIP_TRANSITIONS[details.transition]
        : EVE_LIGHT_STRIP_TRANSITIONS.default;
    let powerOnBehavior = details.poweronbehavior === 2 ? 2 : 1;

    // Prefer the newest recorded on event, while allowing a device adapter to supply a Unix timestamp before history exists.
    let onHistory = this.getHistory(this.EveHome.type, this.EveHome.sub, { status: 1 });
    let lastActivation =
      typeof details.lastactivation === 'number' && Number.isFinite(details.lastactivation) === true ? details.lastactivation : 0;
    if (onHistory.length !== 0) {
      lastActivation = Math.max(lastActivation, onHistory[onHistory.length - 1].time);
    }
    let lastActivationEve = lastActivation > EPOCH_OFFSET ? lastActivation - EPOCH_OFFSET : lastActivation;
    let nowEve = Math.floor(Date.now() / 1000) - EPOCH_OFFSET;

    // This framing and its static trailer come from the complete configuration captured in fakegato-history issue #78.
    let value = util.format(
      '0002 2300 0302 %s 6501 %s 6c02 %s 6a02 %s 6b02 %s d004 %s 9b04 %s ' + '00 00000000 0000001e 02300c',
      numberToEveHexString(details.firmware, 4),
      numberToEveHexString(powerOnBehavior, 2),
      numberToEveHexString(transition[0], 4),
      numberToEveHexString(transition[1], 4),
      numberToEveHexString(transition[2], 4),
      numberToEveHexString(lastActivationEve, 8),
      numberToEveHexString(nowEve, 8),
    );

    return encodeEveData(value);
  }

  #encodeEveSmokeDetails(details) {
    // Encode the configuration packet separately from the UINT32 device-status bit field.
    let value = util.format(
      '0002 1800 0302 %s 9b04 %s 8608 %s 1e02 1800 0c',
      numberToEveHexString(details.firmware, 4), // firmware version (build xxxx)
      numberToEveHexString(Math.floor(Date.now() / 1000), 8), // 'now' time
      numberToEveHexString(details.lastalarmtest, 8),
    ); // Not sure why 64bit value???
    return encodeEveData(value);
  }

  #readEveSmokeStatus(details) {
    // Status bits
    //  0 = Smoked Detected
    //  1 = Heat Detected
    //  2 = Alarm test active
    //  5 = Smoke sensor error
    //  6 = Heat sensor error
    //  7 = Sensor error??
    //  9 = Smoke chamber error
    // 14 = Smoke sensor deactivated
    // 15 = flash status led (on)
    // 24 & 25 = alarms paused
    // 25 = alarm muted
    let value = 0x00000000;
    if (
      this.EveHome.linkedservice.getCharacteristic(this.hap.Characteristic.SmokeDetected).value ===
      this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
    ) {
      value |= 1 << 0; // 1st bit, smoke detected
    }
    if (details.heatstatus === true) {
      value |= 1 << 1; // 2th bit - heat detected
    }
    if (details.alarmtest === true) {
      value |= 1 << 2; // 4th bit - alarm test running
    }
    if (details.smoketestpassed === false) {
      value |= 1 << 5; // 5th bit - smoke test OK
    }
    if (details.heattestpassed === false) {
      value |= 1 << 6; // 6th bit - heat test OK
    }
    if (details.smoketestpassed === false) {
      value |= 1 << 9; // 9th bit - smoke test OK
    }
    if (details.statusled === true) {
      value |= 1 << 15; // 15th bit - flash status led
    }
    if (details.hushedstate === true) {
      value |= 1 << 25; // 25th bit, alarms muted
    }

    return value >>> 0; // Ensure UINT32
  }

  #encodeEveWaterGuardDetails(details) {
    // This ordered TLV8 layout is based on a captured Eve Water Guard 20EBG8701 response.
    // Unknown static capability fields are retained for Eve compatibility, while values owned
    // by the adapter remain dynamic. Serial-specific and unverified runtime fields are omitted.
    let value = util.format(
      '0002 4500 0302 %s 0b02 0000 0501 00 5f04 00000000 1902 9600 1401 03 ' +
        '0f04 00000000 1a04 00000000 4d04 %s 4e01 %s 8608 %s 9b04 %s d200',
      numberToEveHexString(details.firmware, 4),
      numberToEveHexString(details.alarmtestduration, 8),
      numberToEveHexString(details.muted === true ? 1 : 0, 2),
      numberToEveHexString(details.lastalarmtest, 16),
      numberToEveHexString(Math.floor(Date.now() / 1000), 8),
    );

    return encodeEveData(value);
  }

  // Common Eve history transport. These callbacks advertise and stream the descriptor-generated layout.
  #EveHistoryStatus() {
    let tempHistory = this.#getEveHistory(this.EveHome.type, this.EveHome.sub, this.EveHome.fields);
    let historyTime = tempHistory.length === 0 ? Math.floor(Date.now() / 1000) : tempHistory[tempHistory.length - 1].time;
    this.EveHome.reftime = tempHistory.length === 0 ? this.historyData.reset - EPOCH_OFFSET : tempHistory[0].time - EPOCH_OFFSET;
    this.EveHome.count = tempHistory.length; // Number of history entries for this type

    let value = util.format(
      '%s 00000000 %s %s %s %s %s %s 000000000101',
      numberToEveHexString(historyTime - this.EveHome.reftime - EPOCH_OFFSET, 8),
      numberToEveHexString(this.EveHome.reftime, 8), // reference time (time of first history??)
      numberToEveHexString(this.EveHome.fields.length, 2), // Number of advertised fields
      this.EveHome.signature, // Space-separated field definitions
      numberToEveHexString(this.EveHome.count, 4), // count of entries
      numberToEveHexString(this.#maxEntries === 0 ? MAX_HISTORY_SIZE : this.#maxEntries, 4), // history max size
      numberToEveHexString(1, 8),
    ); // first entry

    return encodeEveData(value);
  }

  #EveHistoryEntries() {
    // Streams our history data back to EveHome when requested
    let dataStream = '';
    if (this.EveHome.entry <= this.EveHome.count && this.EveHome.send !== 0) {
      let tempHistory = this.#getEveHistory(this.EveHome.type, this.EveHome.sub, this.EveHome.fields);

      // Generate eve home history header for data following
      let data = util.format(
        '%s 0100 0000 81 %s 0000 0000 00 0000',
        numberToEveHexString(this.EveHome.entry, 8),
        numberToEveHexString(this.EveHome.reftime, 8),
      );

      // Format the data string, including calculating the number of 'bytes' the data fits into
      data = data.replace(/ /g, '');
      dataStream += util.format('%s %s', (data.length / 2 + 1).toString(16), data);

      for (let i = 0; i < EVEHOME_MAX_STREAM; i++) {
        if (tempHistory.length !== 0 && this.EveHome.entry - 1 <= tempHistory.length) {
          let historyEntry = tempHistory[this.EveHome.entry - 1]; // map EveHome address to our history, as EvenHome addresses start at 1
          let data = util.format(
            '%s %s %s',
            numberToEveHexString(this.EveHome.entry, 8),
            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
            this.#encodeEveFields(historyEntry, this.EveHome.fields),
          ); // Create the common header data for eve entry

          // Format the data string, including calculating the number of 'bytes' the data fits into
          data = data.replace(/ /g, '');
          dataStream += util.format('%s%s', numberToEveHexString(data.length / 2 + 1, 2), data);

          this.EveHome.entry++;
          if (this.EveHome.entry > this.EveHome.count) {
            break;
          }
        }
      }
      if (this.EveHome.entry > this.EveHome.count) {
        // No more history data to send back
        this.EveHome.send = 0; // no more to send
        dataStream += '00';
      }
    } else {
      // We're not transferring any data back
      this.EveHome.send = 0; // no more to send
      dataStream = '00';
    }
    return encodeEveData(dataStream);
  }

  #EveHistoryRequest(value) {
    // Requesting history, starting at specific entry
    this.EveHome.entry = EveHexStringToNumber(decodeEveData(value).substring(4, 12)); // Starting entry
    if (this.EveHome.entry === 0) {
      this.EveHome.entry = 1; // requested to restart from beginning of history for sending to EveHome
    }
    this.EveHome.send = this.EveHome.count - this.EveHome.entry + 1; // Number of entries we're expected to send
    this?.log?.debug?.('#EveHistoryRequest: requested address', this.EveHome.entry);
  }

  #EveSetTime(value) {
    // Time stamp from EveHome
    let timestamp = EPOCH_OFFSET + EveHexStringToNumber(decodeEveData(value));

    this?.log?.debug?.('#EveSetTime: timestamp offset', new Date(timestamp * 1000));
  }

  // Eve HAP service wiring and custom type registration.
  #createHistoryService(service, characteristics) {
    if (
      typeof this?.accessory?.getService !== 'function' ||
      typeof this?.accessory?.addService !== 'function' ||
      typeof service?.testCharacteristic !== 'function' ||
      typeof service?.addCharacteristic !== 'function'
    ) {
      return;
    }

    let historyService = this.accessory.getService(this.hap.Service.EveHomeHistory);
    if (historyService === undefined) {
      historyService = this.accessory.addService(this.hap.Service.EveHomeHistory, '', 1);
    }

    if (Array.isArray(characteristics) === true) {
      characteristics.forEach((char) => {
        if (service.testCharacteristic(char) === false) {
          service.addCharacteristic(char);
        }
      });
    }

    return historyService;
  }

  #createHomeKitServicesAndCharacteristics() {
    const createCustomCharacteristic = (name, uuid, props, values) => {
      let className = name.replace(/(\s*)/g, '');

      if (this.hap.Characteristic[className] === undefined) {
        // Create the custom characteristic
        this.hap.Characteristic[className] = {
          [className]: class extends this.hap.Characteristic {
            static UUID = uuid;

            constructor() {
              super(name, uuid, props);
              this.value = this.getDefaultValue();
            }
          },
        }[className];

        // Add in any static defines for the object
        if (typeof values === 'object') {
          Object.entries(values).forEach(([key, value]) => {
            this.hap.Characteristic[className][key] = value;
          });
        }
      }
    };

    const createCustomService = (name, uuid, required, optional) => {
      let className = name.replace(/(\s*)/g, '');
      if (this.hap.Service[className] === undefined) {
        this.hap.Service[className] = {
          [className]: class extends this.hap.Service {
            static UUID = uuid;

            constructor(name, subtype) {
              super(name, uuid, subtype);

              // Add in any required characteristics for the service
              if (typeof required === 'object') {
                for (const Characteristic of required) {
                  this.addCharacteristic(Characteristic);
                }
              }

              // Add in any optional characteristics for the service
              if (typeof optional === 'object') {
                for (const Characteristic of optional) {
                  this.addOptionalCharacteristic(Characteristic);
                }
              }
            }
          },
        }[className];
      }
    };

    createCustomCharacteristic('Eve Reset Total', 'E863F112-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT32,
      unit: this.hap.Units.SECONDS, // since 2001/01/01
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY, this.hap.Perms.PAIRED_WRITE],
    });

    createCustomCharacteristic('Eve History Status', 'E863F116-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve History Entries', 'E863F117-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve History Request', 'E863F11C-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_WRITE, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve Set Time', 'E863F121-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_WRITE, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve Valve Position', 'E863F12E-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT8,
      unit: this.hap.Units.PERCENTAGE,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Last Activation', 'E863F11A-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT32,
      unit: this.hap.Units.SECONDS,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Times Opened', 'E863F129-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT32,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Closed Duration', 'E863F118-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT32,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Opened Duration', 'E863F119-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT32,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });
    createCustomCharacteristic('Eve Program Command', 'E863F12C-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_WRITE, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve Program Data', 'E863F12F-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Electrical Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.FLOAT,
      unit: 'V',
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Electrical Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.FLOAT,
      unit: 'A',
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.FLOAT,
      unit: 'kWh',
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Electrical Wattage', 'E863F10D-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.FLOAT,
      unit: 'W',
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Get Configuration', 'E863F131-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Eve Set Configuration', 'E863F11D-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_WRITE, this.hap.Perms.HIDDEN],
    });

    createCustomCharacteristic('Eve Firmware', 'E863F11E-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.DATA,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.PAIRED_WRITE, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic(
      'Eve Motion Sensitivity',
      'E863F120-079E-48FF-8F27-9C2605A29F52',
      {
        format: this.hap.Formats.UINT8,
        perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.PAIRED_WRITE, this.hap.Perms.NOTIFY],
        minValue: 0,
        maxValue: 7,
        validValues: [0, 4, 7],
      },
      { HIGH: 0, MEDIUM: 4, LOW: 7 },
    );

    createCustomCharacteristic('Eve Motion Duration', 'E863F12D-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.PAIRED_WRITE, this.hap.Perms.NOTIFY],
      minValue: 5,
      maxValue: 54000,
      validValues: [5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000, 43200, 54000],
    });

    createCustomCharacteristic(
      'Eve Device Status',
      'E863F134-079E-48FF-8F27-9C2605A29F52',
      {
        format: this.hap.Formats.UINT32,
        perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      },
      {
        SMOKE_DETECTED: 1 << 0,
        HEAT_DETECTED: 1 << 1,
        ALARM_TEST_ACTIVE: 1 << 2,
        SMOKE_SENSOR_ERROR: 1 << 5,
        HEAT_SENSOR_ERROR: 1 << 7,
        SMOKE_CHAMBER_ERROR: 1 << 9,
        SMOKE_SENSOR_DEACTIVATED: 1 << 14,
        FLASH_STATUS_LED: 1 << 15,
        ALARM_PAUSED: 1 << 24,
        ALARM_MUTED: 1 << 25,
      },
    );

    createCustomCharacteristic('Eve Air Pressure', 'E863F10F-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'hPa',
      minValue: 700,
      maxValue: 1100,
    });

    createCustomCharacteristic('Eve Elevation', 'E863F130-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.INT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.PAIRED_WRITE, this.hap.Perms.NOTIFY],
      unit: 'm',
      minValue: -430,
      maxValue: 8850,
      minStep: 10,
    });

    createCustomCharacteristic('Eve VOC Level', 'E863F10B-079E-48FF-8F27-9C2605A29F52', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'ppm',
      minValue: 5,
      maxValue: 5000,
      minStep: 5,
    });

    createCustomCharacteristic(
      'Eve Weather Trend',
      'E863F136-079E-48FF-8F27-9C2605A29F52',
      {
        format: this.hap.Formats.UINT8,
        perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
        minValue: 0,
        maxValue: 15,
        minStep: 1,
      },
      {
        BLANK: 0,
        SUN: 1,
        CLOUDS_SUN: 3,
        RAIN: 4,
        RAIN_WIND: 12,
      },
    );

    createCustomCharacteristic('Apparent Temperature', 'C1283352-3D12-4777-ACD5-4734760F1AC8', {
      format: this.hap.Formats.FLOAT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: this.hap.Units.CELSIUS,
      minValue: -40,
      maxValue: 100,
      minStep: 0.1,
    });

    createCustomCharacteristic('Cloud Cover', '64392FED-1401-4F7A-9ADB-1710DD6E3897', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: this.hap.Units.PERCENTAGE,
      minValue: 0,
      maxValue: 100,
    });

    createCustomCharacteristic('Condition', 'CD65A9AB-85AD-494A-B2BD-2F380084134D', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Condition Category', 'CD65A9AB-85AD-494A-B2BD-2F380084134C', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      minValue: 0,
      maxValue: 9,
    });

    createCustomCharacteristic('Dew Point', '095C46E2-278E-4E3C-B9E7-364622A0F501', {
      format: this.hap.Formats.FLOAT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: this.hap.Units.CELSIUS,
      minValue: -40,
      maxValue: 100,
      minStep: 0.1,
    });

    createCustomCharacteristic('Forecast Day', '57F1D4B2-0E7E-4307-95B5-808750E2C1C7', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Maximum Wind Speed', '6B8861E5-D6F3-425C-83B6-069945FFD1F1', {
      format: this.hap.Formats.FLOAT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'km/h',
      minValue: 0,
      maxValue: 150,
      minStep: 0.1,
    });

    createCustomCharacteristic('Minimum Temperature', '707B78CA-51AB-4DC9-8630-80A58F07E411', {
      format: this.hap.Formats.FLOAT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: this.hap.Units.CELSIUS,
      minValue: -40,
      maxValue: 100,
      minStep: 0.1,
    });

    createCustomCharacteristic('Observation Station', 'D1B2787D-1FC4-4345-A20E-7B5A74D693ED', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Observation Time', '234FD9F1-1D33-4128-B622-D052F0C402AF', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Ozone', 'BBEFFDDD-1BCD-4D75-B7CD-B57A90A04D13', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'DU',
      minValue: 0,
      maxValue: 500,
    });

    createCustomCharacteristic('Rain', 'F14EB1AD-E000-4EF4-A54F-0CF07B2E7BE7', {
      format: this.hap.Formats.BOOL,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Rain Last Hour', '10C88F40-7EC4-478C-8D5A-BD0C3CCE14B7', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'mm',
      minValue: 0,
      maxValue: 200,
    });

    createCustomCharacteristic('Rain Probability', 'FC01B24F-CF7E-4A74-90DB-1B427AF1FFA3', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: this.hap.Units.PERCENTAGE,
      minValue: 0,
      maxValue: 100,
    });

    createCustomCharacteristic('Total Rain', 'CCC04890-565B-4376-B39A-3113341D9E0F', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'mm',
      minValue: 0,
      maxValue: 2000,
    });

    createCustomCharacteristic('Snow', 'F14EB1AD-E000-4CE6-BD0E-384F9EC4D5DD', {
      format: this.hap.Formats.BOOL,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Solar Radiation', '1819A23E-ECAB-4D39-B29A-7364D299310B', {
      format: this.hap.Formats.UINT16,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'W/m²',
      minValue: 0,
      maxValue: 2000,
    });

    createCustomCharacteristic('Sunrise Time', '0D96F60E-3688-487E-8CEE-D75F05BB3008', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Sunset Time', '3DE24EE0-A288-4E15-A5A8-EAD2451B727C', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('UV Index', '05BA0FE0-B848-4226-906D-5B64272E05CE', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      minValue: 0,
      maxValue: 16,
    });

    createCustomCharacteristic('Visibility', 'D24ECC1E-6FAD-4FB5-8137-5AF88BD5E857', {
      format: this.hap.Formats.UINT8,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'km',
      minValue: 0,
      maxValue: 100,
    });

    createCustomCharacteristic('Wind Direction', '46F1284C-1912-421B-82F5-EB75008B167E', {
      format: this.hap.Formats.STRING,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
    });

    createCustomCharacteristic('Wind Speed', '49C8AE5A-A3A5-41AB-BF1F-12D5654F9F41', {
      format: this.hap.Formats.FLOAT,
      perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY],
      unit: 'km/h',
      minValue: 0,
      maxValue: 150,
      minStep: 0.1,
    });

    // EveHomeHistory Service
    createCustomService('Eve Home History', 'E863F007-079E-48FF-8F27-9C2605A29F52', [
      this.hap.Characteristic.EveResetTotal,
      this.hap.Characteristic.EveHistoryStatus,
      this.hap.Characteristic.EveHistoryEntries,
      this.hap.Characteristic.EveHistoryRequest,
      this.hap.Characteristic.EveSetTime,
    ]);

    // Eve custom air pressure service
    createCustomService('Eve Air Pressure Sensor', 'E863F00A-079E-48FF-8F27-9C2605A29F52', [
      this.hap.Characteristic.EveAirPressure,
      this.hap.Characteristic.EveElevation,
    ]);
  }
}

// General functions
function createEveHistoryField(tag, length, write) {
  return Object.freeze({ tag, length, write });
}

function encodeScaledEveNumber(value, scale, length) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    return;
  }
  return numberToEveHexString(Math.round(value * scale), length * 2);
}

function encodeBinaryEveStatus(value, invert) {
  let status;
  if (value === true || value === 1) {
    status = 1;
  }
  if (value === false || value === 0) {
    status = 0;
  }
  if (status === undefined) {
    return;
  }
  if (invert === true) {
    status = status === 1 ? 0 : 1;
  }
  return numberToEveHexString(status, 2);
}

// Encode an Aqua schedule boundary relative to sunrise or sunset.
// Eve stores the magnitude in minutes and uses flag bits for event, sign, and start/end boundary.
function encodeEveAquaSolarTime(solarEvent, offset, isStart) {
  let eventFlag = solarEvent === 'sunrise' ? 0x20 : 0x00;
  let signFlag = offset < 0 ? 0x40 : 0x00;
  let boundaryFlag = isStart === true ? 0x07 : 0x03;
  let minutes = Math.round(Math.abs(offset) / 60);
  return numberToEveHexString((minutes << 7) + eventFlag + signFlag + boundaryFlag, 4);
}

function eveThermoTargetTemperature(entry) {
  if (typeof entry?.target !== 'object' || entry.target === null) {
    return 0;
  }
  if (entry.target.low === 0 && entry.target.high !== 0) {
    return entry.target.high;
  }
  if (entry.target.low !== 0 && entry.target.high !== 0) {
    return entry.target.high;
  }
  return 0;
}

function encodeEveData(data) {
  if (typeof data !== 'string') {
    // Since passed in data wasn't as string, return 'undefined'
    return;
  }
  return String(Buffer.from(data.replace(/[^a-fA-F0-9]/gi, ''), 'hex').toString('base64'));
}

function decodeEveData(data) {
  if (typeof data !== 'string') {
    // Since passed in data wasn't as string, return 'undefined'
    return;
  }
  return String(Buffer.from(data, 'base64').toString('hex'));
}

// Converts a signed integer number OR float value into a string for EveHome, including formatting to byte width and reverse byte order
function numberToEveHexString(number, padtostringlength, precision) {
  if (typeof number !== 'number' || typeof padtostringlength !== 'number' || padtostringlength % 2 !== 0) {
    return;
  }

  let buffer = Buffer.alloc(8); // Max size of buffer needed for 64bit value
  if (precision === undefined) {
    // Handle integer value
    buffer.writeIntLE(number, 0, 6); // Max 48bit value for signed integers
  }
  if (precision !== undefined && typeof precision === 'number') {
    // Handle float value
    buffer.writeFloatLE(number, 0);
  }
  return String(buffer.toString('hex').padEnd(padtostringlength, '0').slice(0, padtostringlength));
}

// Converts an Eve hex string to a signed integer or a float rounded to the requested precision.
function EveHexStringToNumber(string, precision) {
  if (typeof string !== 'string') {
    return;
  }

  let buffer = Buffer.from(string, 'hex');
  let number = NaN; // Value not defined yet
  if (precision === undefined) {
    // Handle integer value
    number = Number(buffer.readIntLE(0, buffer.length));
  }
  if (precision !== undefined && typeof precision === 'number') {
    // Handle float value
    let float = buffer.readFloatLE(0);
    number = Number(typeof precision === 'number' && precision > 0 ? float.toFixed(precision) : float);
  }
  return number;
}

// Convert unknown thrown values into a stable message for optional logger implementations.
function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
