// HomeKitHistory public-behaviour tests.
// These mocks keep storage, HAP types, and Eve service wiring deterministic without requiring Homebridge or HAP-NodeJS.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import HomeKitHistory from './HomeKitHistory.js';

class MockCharacteristic {
  constructor(displayName, UUID, props = {}) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.props = props;
    this.value = undefined;
  }

  getDefaultValue() {
    return null;
  }

  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }
}

class MockService {
  constructor(displayName, UUID, subtype) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.subtype = subtype;
    this.characteristics = [];
    this.optionalCharacteristics = [];
  }

  addCharacteristic(Characteristic) {
    let characteristic = new Characteristic();
    this.characteristics.push(characteristic);
    return characteristic;
  }

  addOptionalCharacteristic(Characteristic) {
    this.optionalCharacteristics.push(Characteristic);
  }

  testCharacteristic(Characteristic) {
    return this.characteristics.some((entry) => entry.UUID === Characteristic.UUID);
  }

  getCharacteristic(Characteristic) {
    let characteristic = this.characteristics.find((entry) => entry.UUID === Characteristic.UUID);
    if (characteristic === undefined) {
      characteristic = this.addCharacteristic(Characteristic);
    }
    return characteristic;
  }

  updateCharacteristic(Characteristic, value) {
    this.getCharacteristic(Characteristic).value = value;
    return this;
  }
}

class MockAccessory {
  constructor(UUID, username) {
    this.UUID = UUID;
    this.username = username;
    this.services = [];
  }

  getService(Service) {
    return this.services.find((entry) => entry.UUID === Service.UUID);
  }

  addService(Service, displayName, subtype) {
    let service = new Service(displayName, subtype);
    this.services.push(service);
    return service;
  }
}

class MockStorage {
  constructor(initialData = {}) {
    this.data = new Map(Object.entries(initialData));
    this.writes = [];
  }

  getItem(key) {
    return this.data.get(key);
  }

  setItem(key, value) {
    let snapshot = structuredClone(value);
    this.data.set(key, snapshot);
    this.writes.push({ key, value: snapshot });
  }

  setItemSync(key, value) {
    this.setItem(key, value);
  }
}

function namedType(Base, name, UUID) {
  return {
    [name]: class extends Base {
      static UUID = UUID;

      constructor(displayName, subtype) {
        super(displayName, UUID, subtype);
      }
    },
  }[name];
}

function createHap(storage = new MockStorage()) {
  let Characteristic = class Characteristic extends MockCharacteristic {};
  let Service = class Service extends MockService {};

  let serviceNames = [
    'AirQualitySensor',
    'ContactSensor',
    'Door',
    'Doorbell',
    'GarageDoorOpener',
    'HeaterCooler',
    'HumidifierDehumidifier',
    'IrrigationSystem',
    'LeakSensor',
    'Lightbulb',
    'LockMechanism',
    'MotionSensor',
    'Outlet',
    'SmokeSensor',
    'Switch',
    'TemperatureSensor',
    'Thermostat',
    'Valve',
    'Window',
    'WindowCovering',
  ];
  serviceNames.forEach((name) => {
    Service[name] = namedType(MockService, name, 'service-' + name.toLowerCase());
  });
  Service.Fan = namedType(MockService, 'Fan', 'service-fan');
  Service.Fanv2 = namedType(MockService, 'Fanv2', 'service-fan-v2');

  let characteristicNames = [
    'CurrentPosition',
    'CurrentTemperature',
    'LeakDetected',
    'LockPhysicalControls',
    'SmokeDetected',
    'StatusFault',
    'StatusActive',
    'TargetPosition',
    'TemperatureDisplayUnits',
    'VOCDensity',
    'WaterLevel',
  ];
  characteristicNames.forEach((name) => {
    Characteristic[name] = namedType(MockCharacteristic, name, 'characteristic-' + name.toLowerCase());
  });

  Characteristic.TemperatureDisplayUnits.CELSIUS = 0;
  Characteristic.LeakDetected.LEAK_NOT_DETECTED = 0;
  Characteristic.LeakDetected.LEAK_DETECTED = 1;
  Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED = 1;
  Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED = 0;
  Characteristic.SmokeDetected.SMOKE_NOT_DETECTED = 0;
  Characteristic.SmokeDetected.SMOKE_DETECTED = 1;

  return {
    Characteristic,
    Service,
    Formats: {
      BOOL: 'bool',
      DATA: 'data',
      FLOAT: 'float',
      INT: 'int',
      STRING: 'string',
      UINT8: 'uint8',
      UINT16: 'uint16',
      UINT32: 'uint32',
    },
    Units: {
      CELSIUS: 'celsius',
      PERCENTAGE: 'percentage',
      SECONDS: 'seconds',
    },
    Perms: {
      HIDDEN: 'hidden',
      NOTIFY: 'notify',
      PAIRED_READ: 'paired-read',
      PAIRED_WRITE: 'paired-write',
    },
    HAPStorage: {
      storage() {
        return storage;
      },
    },
  };
}

function createHistory(options = {}) {
  let storage = options.storage || new MockStorage();
  let hap = createHap(storage);
  let accessory = new MockAccessory(options.UUID || 'ACCESSORY-01', options.username);
  let api = options.standalone === true ? hap : { version: 2, hap };
  if (options.standalone === true) {
    api.HAPLibraryVersion = () => '1.0.0';
  }
  let history = new HomeKitHistory(accessory, api, options.log, { maxEntries: options.maxEntries });
  return { accessory, hap, history, storage };
}

test('constructor initialises Homebridge storage and registers Eve HAP types', () => {
  let { hap, history, storage } = createHistory();

  assert.equal(storage.writes[0].key, 'History.ACCESSORY-01.json');
  assert.equal(history.historyData.next, 0);
  assert.deepEqual(history.historyData.types, []);
  assert.deepEqual(history.historyData.data, []);
  assert.equal(typeof hap.Characteristic.EveHistoryStatus, 'function');
  assert.equal(hap.Characteristic.EveVOCLevel.UUID, 'E863F10B-079E-48FF-8F27-9C2605A29F52');
  assert.equal(typeof hap.Service.EveHomeHistory, 'function');
  assert.equal(typeof hap.Service.EveAirPressureSensor, 'function');
});

test('constructor uses a normalised username key for standalone HAP-NodeJS', () => {
  let { storage } = createHistory({ standalone: true, username: 'aa:bb:cc:dd:ee:ff' });

  assert.equal(storage.writes[0].key, 'History.AABBCCDDEEFF.json');
});

test('constructor retains valid data and replaces malformed persisted data', () => {
  let valid = {
    reset: 100,
    rollover: 0,
    next: 1,
    types: [{ type: 'service-garagedooropener', sub: 0, lastEntry: 0 }],
    data: [{ time: 100, type: 'service-garagedooropener', sub: 0, status: 1 }],
  };
  let validStorage = new MockStorage({ 'History.ACCESSORY-01.json': valid });
  let validHistory = createHistory({ storage: validStorage }).history;

  assert.deepEqual(validHistory.historyData, valid);
  assert.equal(validStorage.writes.length, 0);

  let malformedStorage = new MockStorage({ 'History.ACCESSORY-01.json': { next: 7 } });
  let malformedHistory = createHistory({ storage: malformedStorage }).history;

  assert.equal(malformedHistory.historyData.next, 0);
  assert.deepEqual(malformedHistory.historyData.types, []);
  assert.deepEqual(malformedHistory.historyData.data, []);
  assert.equal(malformedStorage.writes.length, 1);
});

test('storage failures degrade to in-memory history and work with a partial logger', () => {
  let warnings = [];
  let errors = [];
  let storage = {
    getItem() {
      throw new Error('read failed');
    },
    setItemSync() {
      throw new Error('write failed');
    },
  };
  let hap = createHap(storage);
  let accessory = new MockAccessory('STORAGE-FAILURE');
  let history = new HomeKitHistory(
    accessory,
    { version: 2, hap },
    {
      warn(message, key, error) {
        warnings.push([message, key, error]);
      },
      error(message, key, error) {
        errors.push([message, key, error]);
      },
    },
  );
  let target = new hap.Service.MotionSensor('Motion', 1);

  assert.doesNotThrow(() => history.addHistory(target, { time: 100, status: 1 }));
  assert.equal(history.entryCount(target), 1);
  assert.equal(warnings.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(warnings[0][2], 'read failed');
  assert.equal(errors[0][2], 'write failed');
});

test('addHistory validates entries, preserves the restart marker, and filters stored fields', () => {
  let { hap, history, storage } = createHistory();
  let target = new hap.Service.GarageDoorOpener('Garage');
  let entry = { time: 100, status: 1, ignored: 'value' };
  history.restart = 50;

  history.addHistory(target, { time: 100 });
  assert.equal(history.historyData.next, 0);
  assert.equal(history.restart, 50);

  history.addHistory(target, entry);

  assert.deepEqual(history.getHistory(target), [
    {
      time: 100,
      type: hap.Service.GarageDoorOpener.UUID,
      sub: 0,
      status: 1,
      restart: 50,
    },
  ]);
  assert.equal(target.subtype, undefined);
  assert.deepEqual(entry, { time: 100, status: 1, ignored: 'value' });
  assert.equal(storage.writes.length, 2);
});

test('addHistory ignores null and array inputs at its public boundary', () => {
  let { hap, history } = createHistory();
  let target = new hap.Service.MotionSensor('Motion', 1);

  assert.doesNotThrow(() => history.addHistory(null, { status: 1 }));
  assert.doesNotThrow(() => history.addHistory([], { status: 1 }));
  assert.doesNotThrow(() => history.addHistory(target, null));
  assert.doesNotThrow(() => history.addHistory(target, []));
  assert.equal(history.historyData.next, 0);
});

test('temperature history supplies documented defaults', () => {
  let { hap, history } = createHistory();
  let target = new hap.Service.TemperatureSensor('Temperature', 'outside');
  let entry = { time: 100, temperature: 21.5 };
  history.restart = undefined;

  history.addHistory(target, entry);

  assert.deepEqual(history.lastHistory(target), {
    time: 100,
    type: hap.Service.TemperatureSensor.UUID,
    sub: 'outside',
    temperature: 21.5,
    humidity: 0,
    ppm: 0,
    voc: 0,
    pressure: 0,
  });
  assert.deepEqual(entry, { time: 100, temperature: 21.5 });
});

test('contact, door, and fan histories retain their supported fields', () => {
  let { hap, history } = createHistory();
  let contact = new hap.Service.ContactSensor('Contact', 1);
  let door = new hap.Service.Door('Door', 2);
  let fan = new hap.Service.Fan('Fan', 3);
  history.restart = undefined;

  history.addHistory(contact, { time: 100, status: 0 });
  history.addHistory(door, { time: 101, status: 1 });
  history.addHistory(fan, { time: 102, status: 1, temperature: 23, humidity: 45 });

  assert.equal(history.lastHistory(contact).status, 0);
  assert.equal(history.lastHistory(door).status, 1);
  assert.deepEqual(history.lastHistory(fan), {
    time: 102,
    type: hap.Service.Fan.UUID,
    sub: 3,
    status: 1,
    temperature: 23,
    humidity: 45,
  });
});

test('switch history retains only its on/off status', () => {
  let { hap, history } = createHistory();
  let target = new hap.Service.Switch('Switch', 4);
  history.restart = undefined;

  history.addHistory(target, { time: 100, status: 1, ignored: 'value' });

  assert.deepEqual(history.lastHistory(target), {
    time: 100,
    type: hap.Service.Switch.UUID,
    sub: 4,
    status: 1,
  });
});

test('lightbulb history retains only its on/off status', () => {
  let { hap, history } = createHistory();
  let target = new hap.Service.Lightbulb('Light Strip', 5);
  history.restart = undefined;

  history.addHistory(target, { time: 100, status: 1, ignored: 'value' });

  assert.deepEqual(history.lastHistory(target), {
    time: 100,
    type: hap.Service.Lightbulb.UUID,
    sub: 5,
    status: 1,
  });
});

test('timegap suppresses only entries inside the requested interval', () => {
  let { hap, history } = createHistory();
  let target = new hap.Service.MotionSensor('Motion', 1);
  history.restart = undefined;

  history.addHistory(target, { time: 100, status: 1 }, 10);
  history.addHistory(target, { time: 105, status: 0 }, 10);
  history.addHistory(target, { time: 110, status: 0 }, 10);

  assert.deepEqual(
    history.getHistory(target).map((entry) => entry.time),
    [100, 110],
  );
});

test('service-object queries infer subtype while null requests every subtype', () => {
  let { hap, history } = createHistory();
  let first = new hap.Service.MotionSensor('First', 'first');
  let second = new hap.Service.MotionSensor('Second', 'second');
  history.restart = undefined;
  history.addHistory(first, { time: 100, status: 1 });
  history.addHistory(second, { time: 101, status: 0 });

  assert.deepEqual(
    history.getHistory(first).map((entry) => entry.sub),
    ['first'],
  );
  assert.deepEqual(
    history.getHistory(first, null).map((entry) => entry.sub),
    ['first', 'second'],
  );

  let filter = { status: 1 };
  assert.equal(history.entryCount(first, undefined, filter), 1);
  assert.deepEqual(filter, { status: 1 });
});

test('rolling history keeps the newest entries in chronological order', () => {
  let { hap, history } = createHistory({ maxEntries: 3 });
  let target = new hap.Service.GarageDoorOpener('Door', 1);
  history.restart = undefined;

  for (let time = 1; time <= 4; time++) {
    history.addHistory(target, { time, status: time % 2 });
  }

  assert.deepEqual(
    history.getHistory(target).map((entry) => entry.time),
    [2, 3, 4],
  );
  assert.equal(history.historyData.next, 1);
});

test('history writes replace state and remove overwritten subtype metadata', () => {
  let { hap, history } = createHistory({ maxEntries: 2 });
  let first = new hap.Service.MotionSensor('First', 'first');
  let second = new hap.Service.MotionSensor('Second', 'second');
  history.restart = undefined;
  let initialState = history.historyData;

  history.addHistory(first, { time: 1, status: 1 });

  assert.notEqual(history.historyData, initialState);
  assert.equal(initialState.next, 0);

  history.addHistory(second, { time: 2, status: 1 });
  history.addHistory(second, { time: 3, status: 0 });

  assert.deepEqual(history.historyData.types, [{ type: hap.Service.MotionSensor.UUID, sub: 'second', lastEntry: 0 }]);
});

test('manual rollover rebuilds type metadata including an entry at index zero', () => {
  let { hap, history } = createHistory({ maxEntries: 5 });
  let target = new hap.Service.LockMechanism('Lock', 2);
  history.restart = undefined;
  history.addHistory(target, { time: 1, status: 1 });

  history.rolloverHistory();

  assert.deepEqual(history.historyData.types, [{ type: hap.Service.LockMechanism.UUID, sub: 2, lastEntry: 0 }]);
});

test('resetHistory clears entries and persists the new structure', () => {
  let { hap, history, storage } = createHistory();
  let target = new hap.Service.Doorbell('Doorbell', 0);
  history.addHistory(target, { time: 100, status: 1 });
  let writesBeforeReset = storage.writes.length;

  history.resetHistory();

  assert.equal(history.historyData.next, 0);
  assert.deepEqual(history.historyData.types, []);
  assert.deepEqual(history.historyData.data, []);
  assert.equal(storage.writes.length, writesBeforeReset + 1);
});

test('generateCSV exports stable columns and escapes values', async () => {
  let { hap, history } = createHistory();
  let first = new hap.Service.Fan('First', 'first');
  let second = new hap.Service.Fan('Second', 'second');
  let directory = await mkdtemp(path.join(tmpdir(), 'homekit-history-'));
  let csvfile = path.join(directory, 'history.csv');
  history.restart = undefined;

  try {
    history.addHistory(first, { time: 100, status: 1, temperature: 20 });
    history.addHistory(second, { time: 200, status: 0, humidity: '40, humid' });
    history.addHistory(new hap.Service.Fan('Third', 'third'), { time: 300, status: 1, humidity: '40, "humid"\nwet' });
    let writer = history.generateCSV(hap.Service.Fan, csvfile);
    await once(writer, 'finish');
    let csv = await readFile(csvfile, 'utf8');
    let rows = csv.trim().split('\n');

    assert.equal(rows[0], 'time,subtype,status,temperature,humidity');
    assert.match(rows[1], /,first,1,20,$/);
    assert.match(rows[2], /,second,0,,"40, humid"$/);
    assert.equal(csv.includes(',third,1,,"40, ""humid""\nwet"\n'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('linkToEveHome creates one Eve history service and installs callbacks', async () => {
  let { accessory, hap, history } = createHistory();
  let door = new hap.Service.Door('Door', 1);
  accessory.services.push(door);

  let eveService = await history.linkToEveHome(door, {});

  assert.equal(eveService.UUID, hap.Service.EveHomeHistory.UUID);
  assert.equal(history.EveHome.evetype, 'door');
  assert.equal(typeof eveService.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler, 'function');
  assert.equal(typeof eveService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler, 'function');

  let otherDoor = new hap.Service.Door('Other Door', 2);
  assert.equal(await history.linkToEveHome(otherDoor, {}), undefined);
  assert.equal(accessory.services.filter((service) => service.UUID === hap.Service.EveHomeHistory.UUID).length, 1);
});

test('linkToEveHome routes every supported service family through its linker', async () => {
  let adapterCases = [
    ['Switch', 'switch'],
    ['Lightbulb', 'lightstrip'],
    ['ContactSensor', 'contact'],
    ['Door', 'door'],
    ['Window', 'door'],
    ['GarageDoorOpener', 'door'],
    ['LockMechanism', 'door'],
    ['WindowCovering', 'blind'],
    ['HeaterCooler', 'thermo'],
    ['Thermostat', 'thermo'],
    ['EveAirPressureSensor', 'weather'],
    ['AirQualitySensor', 'room2'],
    ['TemperatureSensor', 'room'],
    ['MotionSensor', 'motion'],
    ['SmokeSensor', 'smoke'],
    ['Valve', 'aqua'],
    ['IrrigationSystem', 'aqua'],
    ['Outlet', 'energy'],
    ['LeakSensor', 'waterguard'],
  ];

  for (let [serviceName, eveType] of adapterCases) {
    let setup = createHistory();
    let target = new setup.hap.Service[serviceName](serviceName, 1);
    setup.accessory.services.push(target);

    let eveService = await setup.history.linkToEveHome(target, {});

    assert.equal(setup.history.EveHome.evetype, eveType);
    assert.equal(typeof eveService.getCharacteristic(setup.hap.Characteristic.EveHistoryStatus).getHandler, 'function');
    await setup.history.updateEveHome(target);
  }
});

test('extracted Eve SET handlers preserve family-specific command behaviour', async () => {
  let createRouter = (received) => {
    return (type, details) => {
      if (type === HomeKitHistory.GET) {
        return details;
      }
      received.push(details);
    };
  };

  let blindSetup = createHistory();
  let blind = new blindSetup.hap.Service.WindowCovering('Blind', 1);
  blindSetup.accessory.services.push(blind);
  blind.updateCharacteristic(blindSetup.hap.Characteristic.CurrentPosition, 50);
  await blindSetup.history.linkToEveHome(blind, {});
  await blind
    .getCharacteristic(blindSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('f303015802f30301', 'hex').toString('base64'));
  assert.equal(blind.getCharacteristic(blindSetup.hap.Characteristic.CurrentPosition).value, 51);

  let thermoMessages = [];
  let thermoLogs = [];
  let thermoSetup = createHistory({
    log: {
      debug(message, value) {
        thermoLogs.push({ message, value });
      },
    },
  });
  let thermostat = new thermoSetup.hap.Service.Thermostat('Thermostat', 1);
  thermoSetup.accessory.services.push(thermostat);
  await thermoSetup.history.linkToEveHome(thermostat, { messages: createRouter(thermoMessages) });
  await thermostat
    .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
    .setHandler(Buffer.from('120a', 'hex').toString('base64'));
  assert.equal(thermoSetup.history.EveThermoPersist.tempoffset, 1);
  assert.deepEqual(thermoMessages, [{ tempoffset: 1 }]);
  assert.equal(
    thermoLogs.some((entry) => entry.message === 'Eve Thermo ProgramCommand "%s"' && entry.value === '120a'),
    true,
  );

  // These are real Eve Thermo ProgramCommand captures. Verify signed offsets,
  // weekly schedule units, and Valve Protection command boundaries.
  for (let [packet, expectedOffset] of [
    ['0012ecf4802026', -2],
    ['0012f1f4802026', -1.5],
    ['001205f4802026', 0.5],
    ['0012e7f4802026', -2.5],
  ]) {
    await thermostat
      .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
      .setHandler(Buffer.from(packet, 'hex').toString('base64'));
    assert.equal(thermoSetup.history.EveThermoPersist.tempoffset, expectedOffset);
  }

  thermoMessages.length = 0;
  await thermostat
    .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
    .setHandler(Buffer.from('001300f480202606', 'hex').toString('base64'));
  assert.deepEqual(thermoMessages, [{ enableschedule: false, scheduleTemps: { eco: 16, comfort: 19 } }]);

  thermoMessages.length = 0;
  await thermostat
    .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
    .setHandler(Buffer.from('ff04f6', 'hex').toString('base64'));
  assert.deepEqual(thermoMessages, []);

  thermoMessages.length = 0;
  await thermostat
    .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
    .setHandler(
      Buffer.from(
        '001301f422222afc0e0912091a1a24366684fffffffffa24366684ffffffff24366684ffffffff24' +
          '366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff06',
        'hex',
      ).toString('base64'),
    );
  assert.equal(thermoMessages.length, 1);
  assert.equal(thermoMessages[0].enableschedule, true);
  assert.deepEqual(thermoMessages[0].scheduleTemps, { eco: 17, comfort: 21 });
  assert.equal(thermoMessages[0].programs.length, 7);
  assert.deepEqual(thermoMessages[0].programs[0], {
    id: 1,
    days: 'mon',
    schedule: [
      { start: 21600, duration: 10800, ecotemp: 17, comforttemp: 21 },
      { start: 61200, duration: 18000, ecotemp: 17, comforttemp: 21 },
    ],
  });

  await thermostat
    .getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand)
    .setHandler(Buffer.from('0011ff00f22076', 'hex').toString('base64'));
  assert.equal(
    thermoLogs.some((entry) => entry.message === 'Eve Thermo command 0x11 data "%s"' && entry.value === 'ff00'),
    true,
  );
  assert.equal(
    thermoLogs.some((entry) => entry.message === 'Eve Thermo command 0xf2 data "%s"' && entry.value === '2076'),
    true,
  );

  let smokeMessages = [];
  let smokeSetup = createHistory();
  let smoke = new smokeSetup.hap.Service.SmokeSensor('Smoke', 1);
  smokeSetup.accessory.services.push(smoke);
  await smokeSetup.history.linkToEveHome(smoke, { messages: createRouter(smokeMessages) });
  await smoke
    .getCharacteristic(smokeSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('4002020140020501', 'hex').toString('base64'));
  assert.equal(smokeSetup.history.EveSmokePersist.alarmtest, true);
  assert.equal(smokeSetup.history.EveSmokePersist.statusled, true);
  assert.deepEqual(smokeMessages, [{ alarmtest: true, statusled: true }]);

  let lightStripMessages = [];
  let lightStripSetup = createHistory();
  let lightStrip = new lightStripSetup.hap.Service.Lightbulb('Light Strip', 1);
  lightStripSetup.accessory.services.push(lightStrip);
  await lightStripSetup.history.linkToEveHome(lightStrip, {
    messages: createRouter(lightStripMessages),
  });
  await lightStrip
    .getCharacteristic(lightStripSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('6501026c02b0046a0220036b024006', 'hex').toString('base64'));
  assert.equal(lightStripSetup.history.EveLightStripPersist.poweronbehavior, 2);
  assert.equal(lightStripSetup.history.EveLightStripPersist.transition, 'calm');
  assert.deepEqual(lightStripMessages, [{ poweronbehavior: 2, transition: 'calm' }]);

  let aquaMessages = [];
  let aquaSetup = createHistory();
  let valve = new aquaSetup.hap.Service.Valve('Valve', 1);
  aquaSetup.accessory.services.push(valve);
  await aquaSetup.history.linkToEveHome(valve, { messages: createRouter(aquaMessages) });
  await valve
    .getCharacteristic(aquaSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('2e02e803', 'hex').toString('base64'));
  assert.equal(aquaSetup.history.EveAquaPersist.flowrate, 60);
  assert.deepEqual(aquaMessages, [{ flowrate: 60 }]);

  let waterGuardSetup = createHistory();
  let leak = new waterGuardSetup.hap.Service.LeakSensor('Leak', 1);
  waterGuardSetup.accessory.services.push(leak);
  await waterGuardSetup.history.linkToEveHome(leak, {});
  await leak
    .getCharacteristic(waterGuardSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('4e0101', 'hex').toString('base64'));
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.muted, true);
  await leak
    .getCharacteristic(waterGuardSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('4e0103', 'hex').toString('base64'));
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtest, true);
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtestduration, 180); // Default when 0x4d is absent
  await leak
    .getCharacteristic(waterGuardSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('4d010a4e0103', 'hex').toString('base64'));
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtest, true);
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtestduration, 10); // Preceding 0x4d wins
  await leak
    .getCharacteristic(waterGuardSetup.hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from('4d0100', 'hex').toString('base64'));
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtest, false);
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.alarmtestduration, 10); // Finishing retains configuration
});

test('Eve Thermo retains complete ProgramData when scheduling is disabled', async () => {
  let setup = createHistory();
  let thermostat = new setup.hap.Service.Thermostat('Thermostat', 1);
  setup.accessory.services.push(thermostat);

  await setup.history.linkToEveHome(thermostat, {});

  let programData = thermostat.getCharacteristic(setup.hap.Characteristic.EveProgramData).value;
  let programDataHex = Buffer.from(programData, 'base64').toString('hex');
  assert.equal(programDataHex, '12e7130014c71900fff400000000fa' + 'ff'.repeat(56));
});

test('Eve Aqua decodes captured TLV8 location and schedule commands', async () => {
  let received = [];
  let { accessory, hap, history } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  accessory.services.push(valve);

  await history.linkToEveHome(valve, {
    messages(type, details) {
      if (type === HomeKitHistory.GET) {
        return details;
      }
      received.push(details);
    },
  });

  // Captured commands: timezone/location, one 06:00-10:00 program, then Monday assigned to program 1.
  let location = '441105150000003c00000091365242a6b15441';
  let schedule = '450d050200000008000a01052d014b';
  let days = '4654' + '05aa1b2c1f0000'.padEnd(168, '0');
  await valve
    .getCharacteristic(hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from(location + schedule + days, 'hex').toString('base64'));

  assert.equal(history.EveAquaPersist.enableschedule, true);
  assert.equal(history.EveAquaPersist.utcoffset, 3600);
  assert.equal(history.EveAquaPersist.latitude, 52.55329);
  assert.equal(history.EveAquaPersist.longitude, 13.29337);
  assert.deepEqual(received, [
    {
      utcoffset: 3600,
      latitude: 52.55329,
      longitude: 13.29337,
      programs: [
        {
          id: 1,
          days: ['mon'],
          schedule: [{ start: 21600, duration: 14400, offset: 21600 }],
        },
      ],
    },
  ]);

  // The shared decoder rejects a truncated command before it can alter persisted Aqua state.
  await valve.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler(Buffer.from('2e02e8', 'hex').toString('base64'));
  assert.equal(history.EveAquaPersist.flowrate, 18);
  assert.equal(received.length, 1);
});

test('Eve Aqua encodes captured water details and solar schedules', async () => {
  let { accessory, hap, history } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  accessory.services.push(valve);

  await history.linkToEveHome(valve, {
    EveAqua_flowrate: 18,
    EveAqua_programs: [
      {
        id: 1,
        days: ['mon'],
        schedule: [
          { start: 'sunrise', offset: -900, duration: 1200 },
          { start: 'sunset', offset: -900, duration: 1200 },
        ],
      },
    ],
  });

  let encoded = await valve.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
  let configuration = Buffer.from(encoded, 'base64').toString('hex');

  // Type 2f contains an 8-byte water total, four reserved bytes, and a 2-byte flow value.
  assert.match(configuration, /2f0e0000000000000000000000002c01/);
  assert.equal(configuration.includes('2f0e000000000000000000002e02'), false);

  // Both periods cross their solar event: 15 minutes before through 5 minutes after.
  assert.match(configuration, /0b02e707a302c7078302/);
});

test('switch Eve history advertises and streams the on/off field', async () => {
  let { accessory, hap, history } = createHistory();
  let target = new hap.Service.Switch('Switch', 1);
  accessory.services.push(target);
  history.restart = undefined;
  history.addHistory(target, { time: 978307300, status: 1 });
  history.addHistory(target, { time: 978307360, status: 0 });

  let eveService = await history.linkToEveHome(target, {});

  assert.equal(history.EveHome.evetype, 'switch');
  assert.equal(history.EveHome.signature, '0e01');

  let status = await eveService.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
  assert.match(Buffer.from(status, 'base64').toString('hex'), /010e01/);

  let request = Buffer.from('000000000000', 'hex').toString('base64');
  await eveService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(request);
  let entries = await eveService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler();
  let entriesHex = Buffer.from(entries, 'base64').toString('hex');
  assert.match(entriesHex, /0b01000000000000000101/);
  assert.match(entriesHex, /0b020000003c0000000100/);
});

test('Eve Light Strip advertises on/off history and captured configuration fields', async () => {
  let { accessory, hap, history } = createHistory();
  let target = new hap.Service.Lightbulb('Light Strip', 1);
  accessory.services.push(target);
  history.restart = undefined;
  history.addHistory(target, { time: 978307700, status: 1 });

  await history.linkToEveHome(target, {
    EveLightStrip_firmware: 338,
    EveLightStrip_poweronbehavior: 2,
    EveLightStrip_transition: 'moderate',
  });

  assert.equal(history.EveHome.evetype, 'lightstrip');
  assert.equal(history.EveHome.signature, '0e01');
  assert.equal(Buffer.from(target.getCharacteristic(hap.Characteristic.EveFirmware).value, 'base64').toString('hex'), '365201be');

  let configuration = await target.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
  let configurationHex = Buffer.from(configuration, 'base64').toString('hex');
  assert.equal(configurationHex.startsWith('00022300030252016501026c0290016a0290016b022003d004f40100009b04'), true);
  assert.equal(configurationHex.endsWith('00000000000000001e02300c'), true);
});

test('energy Eve history supports independent power and on/off data points', async () => {
  let { accessory, hap, history } = createHistory();
  let target = new hap.Service.Outlet('Outlet', 1);
  accessory.services.push(target);
  history.restart = undefined;
  history.addHistory(target, { time: 978307300, watts: 42.5 });
  history.addHistory(target, { time: 978307360, status: 1 });

  let eveService = await history.linkToEveHome(target, {});

  assert.equal(history.EveHome.evetype, 'energy');
  assert.equal(history.EveHome.signature, '0702 0e01');
  assert.equal(history.EveHome.count, 2);

  let request = Buffer.from('000000000000', 'hex').toString('base64');
  await eveService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(request);
  let entries = await eveService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler();
  let entriesHex = Buffer.from(entries, 'base64').toString('hex');
  assert.match(entriesHex, /0c010000000000000001a901/);
  assert.match(entriesHex, /0b020000003c0000000201/);
});

test('descriptor migration preserves existing Eve profile protocol layouts', async () => {
  async function readEntries(setup, target, entry) {
    setup.accessory.services.push(target);
    setup.history.restart = undefined;
    setup.history.addHistory(target, entry);
    let eveService = await setup.history.linkToEveHome(target, {});
    let request = Buffer.from('000000000000', 'hex').toString('base64');
    await eveService.getCharacteristic(setup.hap.Characteristic.EveHistoryRequest).setHandler(request);
    let encoded = await eveService.getCharacteristic(setup.hap.Characteristic.EveHistoryEntries).getHandler();
    return Buffer.from(encoded, 'base64').toString('hex');
  }

  let doorSetup = createHistory();
  let doorEntries = await readEntries(doorSetup, new doorSetup.hap.Service.Door('Door', 1), { time: 978307300, status: 1 });
  assert.equal(doorSetup.history.EveHome.evetype, 'door');
  assert.equal(doorSetup.history.EveHome.signature, '0601');
  assert.match(doorEntries, /0b01000000000000000100/);

  let motionSetup = createHistory();
  let motionEntries = await readEntries(motionSetup, new motionSetup.hap.Service.MotionSensor('Motion', 1), { time: 978307300, status: 1 });
  assert.equal(motionSetup.history.EveHome.evetype, 'motion');
  assert.equal(motionSetup.history.EveHome.signature, '1301 1c01');
  assert.match(motionEntries, /0b01000000000000000201/);

  let weatherSetup = createHistory();
  let weatherEntries = await readEntries(weatherSetup, new weatherSetup.hap.Service.EveAirPressureSensor('Weather', 1), {
    time: 978307300,
    temperature: 21.5,
    humidity: 48,
    pressure: 1013.2,
  });
  assert.equal(weatherSetup.history.EveHome.evetype, 'weather');
  assert.equal(weatherSetup.history.EveHome.signature, '0102 0202 0302');
  assert.match(weatherEntries, /100100000000000000076608c0129427/);

  let roomSetup = createHistory();
  let roomEntries = await readEntries(roomSetup, new roomSetup.hap.Service.TemperatureSensor('Room', 1), {
    time: 978307300,
    temperature: 20,
  });
  assert.equal(roomSetup.history.EveHome.evetype, 'room');
  assert.equal(roomSetup.history.EveHome.signature, '0102 0202 0402 0f03');
  assert.match(roomEntries, /1301000000000000000fd00700000000000000/);

  let thermoSetup = createHistory();
  let thermoEntries = await readEntries(thermoSetup, new thermoSetup.hap.Service.Thermostat('Thermo', 1), {
    time: 978307300,
    status: 2,
    temperature: 20,
    target: { low: 0, high: 22 },
    humidity: 40,
  });
  assert.equal(thermoSetup.history.EveHome.evetype, 'thermo');
  assert.equal(thermoSetup.history.EveHome.signature, '0102 0202 1102 1001 1201 1d01');
  assert.match(thermoEntries, /1301000000000000003fd007a00f9808640000/);
});

test('linkToEveHome validates nullable inputs and retains documented option names', async () => {
  let invalid = createHistory().history;
  assert.equal(await invalid.linkToEveHome(null, null), undefined);
  assert.equal(await invalid.updateEveHome(null), undefined);

  let motionSetup = createHistory();
  let motion = new motionSetup.hap.Service.MotionSensor('Motion', 1);
  motionSetup.accessory.services.push(motion);
  await motionSetup.history.linkToEveHome(motion, {
    EveMotion_duration: 20,
    EveMotion_sensitivity: motionSetup.hap.Characteristic.EveMotionSensitivity.LOW,
  });

  assert.equal(motionSetup.history.EveMotionPersist.duration, 20);
  assert.equal(motionSetup.history.EveMotionPersist.sensitivity, motionSetup.hap.Characteristic.EveMotionSensitivity.LOW);

  let thermoSetup = createHistory();
  let thermostat = new thermoSetup.hap.Service.Thermostat('Thermostat', 1);
  thermoSetup.accessory.services.push(thermostat);
  await thermoSetup.history.linkToEveHome(thermostat, { EveThermo_vacationtemp: 12 });

  assert.equal(thermoSetup.history.EveThermoPersist.vacationtemp, 12);
});

test('Eve detail refresh merges partial device state without losing adapter defaults', async () => {
  let setup = createHistory();
  let thermostat = new setup.hap.Service.Thermostat('Thermostat', 1);
  setup.accessory.services.push(thermostat);

  await setup.history.linkToEveHome(thermostat, {
    messages(type, currentState) {
      assert.equal(type, HomeKitHistory.GET);
      assert.equal(currentState.firmware, 1251);
      return { tempoffset: 1.5 };
    },
  });

  assert.equal(setup.history.EveThermoPersist.firmware, 1251);
  assert.equal(setup.history.EveThermoPersist.tempoffset, 1.5);
  assert.equal(setup.history.EveThermoPersist.attached, false);
});

test('Eve detail refresh isolates state and tolerates invalid or failed router results', async () => {
  let aquaSetup = createHistory();
  let valve = new aquaSetup.hap.Service.Valve('Valve', 1);
  aquaSetup.accessory.services.push(valve);

  await aquaSetup.history.linkToEveHome(valve, {
    messages(type, currentState) {
      assert.equal(type, HomeKitHistory.GET);
      currentState.flowrate = 99;
      return null;
    },
  });

  assert.equal(aquaSetup.history.EveAquaPersist.flowrate, 18);

  let energySetup = createHistory();
  let outlet = new energySetup.hap.Service.Outlet('Outlet', 1);
  energySetup.accessory.services.push(outlet);

  await assert.doesNotReject(async () => {
    await energySetup.history.linkToEveHome(outlet, {
      messages() {
        throw new Error('device unavailable');
      },
    });
  });
  assert.equal(outlet.getCharacteristic(energySetup.hap.Characteristic.EveElectricalWattage).value, null);
});

test('Smoke and Water Guard retain their device-specific detail formats after refresh', async () => {
  let smokeSetup = createHistory();
  let smoke = new smokeSetup.hap.Service.SmokeSensor('Smoke', 1);
  smokeSetup.accessory.services.push(smoke);

  await smokeSetup.history.linkToEveHome(smoke, {
    messages() {
      return { heatstatus: true };
    },
  });

  assert.equal(smokeSetup.history.EveSmokePersist.firmware, 1208);
  assert.equal(smoke.getCharacteristic(smokeSetup.hap.Characteristic.EveDeviceStatus).value & (1 << 1), 1 << 1);

  let waterGuardSetup = createHistory();
  let leak = new waterGuardSetup.hap.Service.LeakSensor('Leak', 1);
  waterGuardSetup.accessory.services.push(leak);

  await waterGuardSetup.history.linkToEveHome(leak, {
    messages() {
      return { muted: true };
    },
  });

  let configuration = leak.getCharacteristic(waterGuardSetup.hap.Characteristic.EveGetConfiguration).value;
  assert.equal(waterGuardSetup.history.EveWaterGuardPersist.firmware, 2866);
  let configurationHex = Buffer.from(configuration, 'base64').toString('hex');
  assert.equal(configurationHex.startsWith('000245000302320b'), true);
  assert.match(configurationHex, /4d04b40000004e0101860800000000000000009b04[0-9a-f]{8}d200$/);
});

test('Eve Water Guard uses its captured history signature and configuration framing', async () => {
  let received = [];
  let { accessory, hap, history } = createHistory();
  let leak = new hap.Service.LeakSensor('Leak', 1);
  accessory.services.push(leak);
  history.restart = undefined;
  history.addHistory(leak, { time: 978307300, status: 1 });
  history.addHistory(leak, { time: 978307360, status: 0 });

  let historyService = await history.linkToEveHome(leak, {
    EveWaterGuard_firmware: 1237,
    EveWaterGuard_lastalarmtest: 857,
    EveWaterGuard_alarmtest: true,
    EveWaterGuard_alarmtestduration: 180,
    messages(type, details) {
      if (type === HomeKitHistory.GET) {
        return details;
      }
      received.push(details);
    },
  });

  let historyStatus = await historyService.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
  let historyStatusHex = Buffer.from(historyStatus, 'base64').toString('hex');
  assert.equal(historyStatusHex.slice(24, 30), '012d01');

  // Both transitions are streamed. Eve's Water Guard event list currently
  // displays the leak event but omits the zero-valued safe/cleared transition.
  let request = Buffer.from('000000000000', 'hex').toString('base64');
  await historyService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(request);
  let entries = await historyService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler();
  let entriesHex = Buffer.from(entries, 'base64').toString('hex');
  assert.match(entriesHex, /0b01000000000000000101/);
  assert.match(entriesHex, /0b020000003c0000000100/);

  let configuration = leak.getCharacteristic(hap.Characteristic.EveGetConfiguration).value;
  let configurationHex = Buffer.from(configuration, 'base64').toString('hex');
  assert.equal(configurationHex.startsWith('000245000302d504'), true);
  assert.match(configurationHex, /4d04b40000004e0100860859030000000000009b04[0-9a-f]{8}d200$/);
  assert.equal(configurationHex.includes('5b00'), false);

  await leak.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler(Buffer.from('4e0101', 'hex').toString('base64'));
  assert.deepEqual(received, [{ muted: true }]);
});

test('message constants and Eve options marker are stable public API', () => {
  assert.equal(HomeKitHistory.GET, 'HomeKitHistory.onEveGet');
  assert.equal(HomeKitHistory.SET, 'HomeKitHistory.onEveSet');
  assert.equal(typeof HomeKitHistory.EVE_OPTIONS, 'symbol');
});

test('history input and query snapshots isolate nested values from retained and persisted records', () => {
  let { hap, history, storage } = createHistory();
  let thermostat = new hap.Service.Thermostat('Thermostat', 1);
  let target = { low: 0, high: 22 };
  history.addHistory(thermostat, { time: 100, status: 2, temperature: 20, humidity: 45, target });
  target.high = 99;
  let queried = history.getHistory(thermostat);
  queried[0].status = 0;
  queried[0].target.high = 80;
  history.lastHistory(thermostat).target.low = 10;
  assert.equal(history.lastHistory(thermostat).status, 2);
  assert.deepEqual(history.lastHistory(thermostat).target, { low: 0, high: 22 });
  assert.deepEqual(storage.writes.at(-1).value.data[0].target, { low: 0, high: 22 });
  history.addHistory(thermostat, { time: 200, status: 0, temperature: 21, humidity: 50, target });
  assert.deepEqual(storage.writes.at(-1).value.data[0].target, { low: 0, high: 22 });
});

test('uncloneable history input preserves the restart marker and allows later valid writes', () => {
  let { hap, history } = createHistory();
  let thermostat = new hap.Service.Thermostat('Thermostat', 1);
  let restart = history.restart;
  history.addHistory(thermostat, { status: 2, temperature: 20, humidity: 40, target: { high: () => 22 } });
  assert.equal(history.entryCount(), 0);
  assert.equal(history.restart, restart);
  history.addHistory(thermostat, { status: 2, temperature: 20, humidity: 40, target: { low: 0, high: 22 } });
  assert.equal(history.lastHistory(thermostat).restart, restart);
});

test('persisted entries and indexes are validated before querying, rollover, or timegap checks', () => {
  let valid = {
    reset: 100, rollover: 0, next: 1,
    types: [{ type: 'service-motion', sub: 1, lastEntry: 0 }],
    data: [{ time: 100, type: 'service-motion', sub: 1, status: 1 }],
  };
  let malformed = [
    { ...valid, data: [null] },
    { ...valid, data: [5] },
    { ...valid, data: [{ ...valid.data[0], time: Infinity }] },
    { ...valid, data: [{ time: 100, sub: 1 }] },
    { ...valid, types: [null] },
    { ...valid, types: [{ ...valid.types[0], lastEntry: -1 }] },
    { ...valid, types: [{ ...valid.types[0], lastEntry: 1 }] },
    { ...valid, types: [{ ...valid.types[0], sub: 2 }] },
    { ...valid, reset: NaN },
  ];
  for (let persisted of malformed) {
    let storage = new MockStorage({ 'History.ACCESSORY-01.json': persisted });
    let { history, hap } = createHistory({ storage, maxEntries: 1 });
    assert.deepEqual(history.getHistory('service-motion'), []);
    assert.equal(storage.writes.length, 1);
    let motion = new hap.Service.MotionSensor('Motion', 1);
    history.addHistory(motion, { time: 200, status: 0 }, 60);
    history.addHistory(motion, { time: 300, status: 1 }, 60);
    assert.equal(history.lastHistory(motion).status, 1);
  }
});

test('short history requests and clock values leave active transfer state intact', async () => {
  let { history, hap, accessory } = createHistory();
  let service = new hap.Service.Switch('Switch', 1);
  accessory.services.push(service);
  history.addHistory(service, { time: 1000000000, status: 1 });
  let eveService = await history.linkToEveHome(service);
  let request = eveService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler;
  let setTime = eveService.getCharacteristic(hap.Characteristic.EveSetTime).setHandler;
  request(Buffer.from('000001000000', 'hex').toString('base64'));
  for (let value of [undefined, null, '', 'AA==', Buffer.alloc(5).toString('base64')]) {
    assert.doesNotThrow(() => request(value));
    assert.doesNotThrow(() => setTime(value));
    assert.equal(history.EveHome.entry, 1);
    assert.equal(history.EveHome.send, 1);
  }
  assert.doesNotThrow(() => setTime(Buffer.from('01000000', 'hex').toString('base64')));
  request(Buffer.from('0000ffffffff', 'hex').toString('base64'));
  assert.equal(history.EveHome.send, 0);
  assert.equal(eveService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'AA==');
});

test('malformed configuration payloads are ignored while following valid commands still apply', async () => {
  let setup = createHistory();
  let valve = new setup.hap.Service.Valve('Valve', 1);
  setup.accessory.services.push(valve);
  let writes = [];
  await setup.history.linkToEveHome(valve, {
    messages(type, state) {
      if (type === HomeKitHistory.SET) {
        writes.push(state);
      }
      return state;
    },
  });
  let set = valve.getCharacteristic(setup.hap.Characteristic.EveSetConfiguration).setHandler;
  let baseline = structuredClone(setup.history.EveAquaPersist);
  for (let packet of ['2e00', '2e0101', '2e0700000000000000', '2f00', '4400', '4403051400', '4500', '4600', '4b00']) {
    await assert.doesNotReject(() => set(Buffer.from(packet, 'hex').toString('base64')));
    assert.deepEqual(setup.history.EveAquaPersist, baseline);
    assert.deepEqual(writes, []);
  }
  await set(Buffer.from('2e002e02e803', 'hex').toString('base64'));
  assert.equal(setup.history.EveAquaPersist.flowrate, 60);
  assert.deepEqual(writes, [{ flowrate: 60 }]);

  let smokeSetup = createHistory();
  let smoke = new smokeSetup.hap.Service.SmokeSensor('Smoke', 1);
  smokeSetup.accessory.services.push(smoke);
  await smokeSetup.history.linkToEveHome(smoke);
  let smokeSet = smoke.getCharacteristic(smokeSetup.hap.Characteristic.EveSetConfiguration).setHandler;
  let alarmtest = smokeSetup.history.EveSmokePersist.alarmtest;
  await smokeSet(Buffer.from('4000400102', 'hex').toString('base64'));
  assert.equal(smokeSetup.history.EveSmokePersist.alarmtest, alarmtest);

  let thermoSetup = createHistory();
  let thermostat = new thermoSetup.hap.Service.Thermostat('Thermostat', 1);
  thermoSetup.accessory.services.push(thermostat);
  await thermoSetup.history.linkToEveHome(thermostat);
  let thermoSet = thermostat.getCharacteristic(thermoSetup.hap.Characteristic.EveProgramCommand).setHandler;
  let thermoBaseline = structuredClone(thermoSetup.history.EveThermoPersist);
  for (let value of [undefined, null, Buffer.from('12', 'hex').toString('base64'), Buffer.from('fa', 'hex').toString('base64')]) {
    await assert.doesNotReject(() => thermoSet(value));
    assert.deepEqual(thermoSetup.history.EveThermoPersist, thermoBaseline);
  }
});

test('Eve router failures and invalid results preserve nested schedules and accepted results are detached', async () => {
  let setup = createHistory();
  let thermostat = new setup.hap.Service.Thermostat('Thermostat', 1);
  setup.accessory.services.push(thermostat);
  let programs = [{ days: 'mon', schedule: [{ start: 3600, duration: 600, ecotemp: 16, comforttemp: 20 }] }];
  let response = null;
  await setup.history.linkToEveHome(thermostat, {
    EveThermo_programs: programs,
    messages(type, state) {
      state.programs[0].schedule[0].start = 7200;
      if (response === undefined) {
        throw new Error('device unavailable');
      }
      return response;
    },
  });
  let get = thermostat.getCharacteristic(setup.hap.Characteristic.EveProgramData).getHandler;
  assert.equal(setup.history.EveThermoPersist.programs[0].schedule[0].start, 3600);
  response = undefined;
  await get();
  assert.equal(setup.history.EveThermoPersist.programs[0].schedule[0].start, 3600);
  response = { programs: structuredClone(programs) };
  response.programs[0].schedule[0].start = 10800;
  await get();
  response.programs[0].schedule[0].start = 14400;
  assert.equal(setup.history.EveThermoPersist.programs[0].schedule[0].start, 10800);
  response = { programs: structuredClone(programs), unsupported: () => true };
  await get();
  assert.equal(setup.history.EveThermoPersist.programs[0].schedule[0].start, 10800);
});

test('history transfers keep advertised entries across rollover and status reads, and reset cancels them', async () => {
  let { history, hap, accessory } = createHistory({ maxEntries: 16 });
  let service = new hap.Service.Switch('Switch', 1);
  accessory.services.push(service);
  for (let index = 0; index < 13; index++) {
    history.addHistory(service, { time: 1000000000 + index, status: index % 2 });
  }
  let eveService = await history.linkToEveHome(service);
  let getStatus = eveService.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler;
  let getEntries = eveService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler;
  let request = eveService.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler;
  getStatus();
  request(Buffer.from('000001000000', 'hex').toString('base64'));
  getEntries();
  assert.equal(history.EveHome.entry, 12);
  for (let index = 13; index < 32; index++) {
    history.addHistory(service, { time: 1000000000 + index, status: index % 2 });
  }
  getStatus();
  let tail = Buffer.from(getEntries(), 'base64').toString('hex');
  // Original entry addresses, offsets and statuses survive the live buffer being completely overwritten.
  assert.equal(tail.includes('0b0c0000000b0000000101'), true);
  assert.equal(tail.includes('0b0d0000000c0000000100'), true);
  assert.equal(tail.endsWith('00'), true);
  assert.equal(history.EveHome.send, 0);
  assert.equal(getEntries(), 'AA==');
  request(Buffer.from('000001000000', 'hex').toString('base64'));
  history.resetHistory();
  history.addHistory(service, { time: 1000000040, status: 1 });
  assert.equal(getEntries(), 'AA==');
  assert.equal(history.EveHome.send, 0);
  getStatus();
  request(Buffer.from('000001000000', 'hex').toString('base64'));
  assert.equal(Buffer.from(getEntries(), 'base64').toString('hex').includes('0b01000000000000000101'), true);
});

// Audit regressions cover acceptance reporting, restored ring metadata, and real HAP API shapes.
test('addHistory reports acceptance for valid, rejected, suppressed, and memory-only writes', () => {
  let { history, hap, storage } = createHistory({ maxEntries: 2 });
  let motion = new hap.Service.MotionSensor('Motion', 1);
  let restart = history.restart;
  assert.equal(history.addHistory(null, {}), false);
  assert.equal(history.addHistory(motion, {}), false);
  assert.equal(history.addHistory({ UUID: '__proto__' }, {}), false);
  assert.equal(history.addHistory({ UUID: 'unsupported' }, { status: 1 }), false);
  assert.equal(history.addHistory(motion, { status: () => 1 }), false);
  assert.equal(history.restart, restart);
  assert.equal(history.addHistory(motion, { time: 100, status: 1 }, 60), true);
  assert.equal(history.restart, undefined);
  let writes = storage.writes.length;
  assert.equal(history.addHistory(motion, { time: 101, status: 0 }, 60), false);
  assert.equal(storage.writes.length, writes);
  assert.equal(history.addHistory(motion, { time: 160, status: 0 }, 60), true);
  assert.equal(history.addHistory(motion, { time: 220, status: 1 }, 60), true);
  assert.deepEqual(history.getHistory(motion).map((entry) => entry.time), [160, 220]);

  storage.setItemSync = () => {
    throw new Error('disk unavailable');
  };
  assert.equal(history.addHistory(motion, { time: 280, status: 0 }), true);
  assert.equal(history.lastHistory(motion).time, 280);
  let unavailable = new HomeKitHistory();
  assert.equal(unavailable.addHistory(motion, { status: 1 }), false);
});

test('Fanv2 uses the HAP service namespace and records optional climate fields', () => {
  let { history, hap } = createHistory();
  assert.equal(hap.Service.Fan.Fanv2, undefined);
  let fan = new hap.Service.Fanv2('Fan', 1);
  assert.equal(history.addHistory(fan, { status: 1, temperature: 21, humidity: 40 }), true);
  assert.equal(history.lastHistory(fan).temperature, 21);
});

test('invalid numeric metadata cannot poison persisted timestamps or suppress all later writes', () => {
  let { history, hap, storage } = createHistory();
  let motion = new hap.Service.MotionSensor('Motion', 1);
  history.restart = undefined;
  for (let time of ['100', null, Infinity, NaN, {}, true]) {
    let before = Math.floor(Date.now() / 1000);
    assert.equal(history.addHistory(motion, { time, status: 1, restart: null }, Infinity), true);
    assert.equal(Number.isFinite(history.lastHistory(motion).time), true);
    assert.equal(history.lastHistory(motion).time >= before, true);
    assert.equal(history.lastHistory(motion).restart, undefined);
  }
  let restored = createHistory({ storage }).history;
  assert.equal(restored.entryCount(null), 6);
});

test('normalised LeakSensor and WaterLevel queries agree with insertion and time gaps', () => {
  let { history, hap } = createHistory();
  history.restart = undefined;
  for (let [target, entry] of [
    [new hap.Service.LeakSensor('Leak', 'physical'), { status: 1 }],
    [{ UUID: hap.Characteristic.WaterLevel.UUID, subtype: 'physical' }, { level: 30 }],
  ]) {
    assert.equal(history.addHistory(target, { ...entry, time: 100 }, 60), true);
    assert.equal(history.entryCount(target), 1);
    assert.equal(history.lastHistory(target).sub, 0);
    assert.equal(history.addHistory(target, { ...entry, time: 110 }, 60), false);
  }
});

test('startup repairs incomplete and stale indexes in logical ring order without losing records', () => {
  for (let next of [1, 3]) {
    let data = [100, 200, 300].map((time) => ({ time, type: 'service-motionsensor', sub: 1, status: 1 }));
    let newest = next === 1 ? 0 : 2;
    for (let types of [[], [{ type: 'service-motionsensor', sub: 1, lastEntry: (newest + 1) % 3 }]]) {
      let storage = new MockStorage({
        'History.ACCESSORY-01.json': { reset: 100, rollover: 0, next, types, data },
      });
      let { history, hap } = createHistory({ storage, maxEntries: 3 });
      let motion = new hap.Service.MotionSensor('Motion', 1);
      history.restart = undefined;
      assert.equal(history.entryCount(motion), 3);
      assert.equal(history.lastHistory(motion).time, data[newest].time);
      assert.equal(history.addHistory(motion, { time: data[newest].time + 1, status: 0 }, 60), false);
    }
  }
});

test('reducing maxEntries retains the newest records from full and partially overwritten rings', () => {
  for (let count of [5, 7]) {
    let { history, hap, storage } = createHistory({ maxEntries: 5 });
    let motion = new hap.Service.MotionSensor('Motion', 1);
    for (let time = 1; time <= count; time++) {
      history.addHistory(motion, { time, status: 1 });
    }
    let restored = createHistory({ storage, maxEntries: 3 }).history;
    assert.deepEqual(restored.getHistory(null).map((entry) => entry.time), [count - 2, count - 1, count]);
    assert.equal(restored.addHistory(motion, { time: count + 1, status: 0 }), true);
    assert.deepEqual(restored.getHistory(null).map((entry) => entry.time), [count - 1, count, count + 1]);
    let reloaded = createHistory({ storage, maxEntries: 3 }).history;
    assert.deepEqual(reloaded.getHistory(null), restored.getHistory(null));
  }
});

test('Smoke options retain caller boolean intent without assuming passed self-tests', async () => {
  for (let enabled of [true, false]) {
    let { history, hap } = createHistory();
    let smoke = new hap.Service.SmokeSensor('Smoke', 1);
    await history.linkToEveHome(smoke, {
      EveSmoke_statusled: enabled,
      EveSmoke_smoketestpassed: enabled,
      EveSmoke_heattestpassed: enabled,
    });
    let status = smoke.getCharacteristic(hap.Characteristic.EveDeviceStatus).value;
    assert.equal(history.EveSmokePersist.statusled, enabled);
    assert.equal(history.EveSmokePersist.smoketestpassed, enabled);
    assert.equal(history.EveSmokePersist.heattestpassed, enabled);
    assert.equal((status & (1 << 15)) !== 0, enabled);
    assert.equal((status & (1 << 5)) !== 0, enabled === false);
  }
  let { history, hap } = createHistory();
  let smoke = new hap.Service.SmokeSensor('Smoke', 1);
  await history.linkToEveHome(smoke);
  assert.equal(history.EveSmokePersist.smoketestpassed, false);
  assert.equal(history.EveSmokePersist.heattestpassed, false);
});

test('Aqua child-lock writes use the LockPhysicalControls characteristic constants', async () => {
  let { history, hap } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  let received = [];
  await history.linkToEveHome(valve, { messages(type, data) {
    if (type === HomeKitHistory.SET) {
      received.push(data);
    }
    return data;
  } });
  for (let value of [1, 0]) {
    valve.updateCharacteristic(hap.Characteristic.LockPhysicalControls, value);
    await valve.getCharacteristic(hap.Characteristic.EveSetConfiguration)
      .setHandler(Buffer.from('b1020100', 'hex').toString('base64'));
    assert.equal(received.at(-1).childlock, value === 1);
  }
});

test('Eve updates only refresh the linked service and include Water Guard', async () => {
  let { history, hap } = createHistory();
  let leak = new hap.Service.LeakSensor('Leak', 1);
  let unrelated = new hap.Service.Outlet('Outlet', 1);
  let muted = false;
  let calls = 0;
  await history.linkToEveHome(leak, { messages() {
    calls++; return { muted };
  } });
  let initialCalls = calls;
  await history.updateEveHome(unrelated);
  assert.equal(calls, initialCalls);
  assert.equal(unrelated.characteristics.length, 0);
  muted = true;
  await history.updateEveHome(leak);
  assert.equal(calls, initialCalls + 1);
  assert.match(Buffer.from(leak.getCharacteristic(hap.Characteristic.EveGetConfiguration).value, 'base64').toString('hex'), /4e0101/);
});

test('Thermo history encodes the active low target when high is disabled', async () => {
  let { history, hap } = createHistory();
  let thermo = new hap.Service.Thermostat('Thermostat', 1);
  history.addHistory(thermo, { time: 100, status: 2, temperature: 19, humidity: 40, target: { low: 21, high: 0 } });
  await history.linkToEveHome(thermo);
  let historyService = history.EveHome.service;
  historyService.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
  historyService.getCharacteristic(hap.Characteristic.EveHistoryRequest)
    .setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
  let packet = Buffer.from(historyService.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
  // The reference record is 21 bytes; the entry header and bitmap occupy another ten bytes.
  let offset = packet[0] + 10;
  assert.equal(packet.readInt16LE(offset + 4), 2100);
});

test('Water Guard restarts cancel the old timer and receive the full duration', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  // Publish mocked built-in functions to the source module's named ESM imports, then restore them after this test.
  context.after(() => {
    context.mock.timers.reset();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
  let { history, hap } = createHistory();
  let leak = new hap.Service.LeakSensor('Leak', 1);
  await history.linkToEveHome(leak, { EveWaterGuard_alarmtestduration: 180 });
  let set = leak.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  let detected = leak.getCharacteristic(hap.Characteristic.LeakDetected);

  await set(Buffer.from('4e0103', 'hex').toString('base64'));
  context.mock.timers.tick(120000);
  await set(Buffer.from('4e0103', 'hex').toString('base64'));
  context.mock.timers.tick(60000);
  assert.equal(history.EveWaterGuardPersist.alarmtest, true);
  assert.equal(detected.value, hap.Characteristic.LeakDetected.LEAK_DETECTED);
  context.mock.timers.tick(119999);
  assert.equal(history.EveWaterGuardPersist.alarmtest, true);
  context.mock.timers.tick(1);
  assert.equal(history.EveWaterGuardPersist.alarmtest, false);
  assert.equal(detected.value, hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
});

test('Water Guard explicit test end cancels delayed changes and preserves the configured duration', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  // Publish mocked built-in functions to the source module's named ESM imports, then restore them after this test.
  context.after(() => {
    context.mock.timers.reset();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
  let { history, hap } = createHistory();
  let leak = new hap.Service.LeakSensor('Leak', 1);
  let received = [];
  await history.linkToEveHome(leak, { messages(type, data) {
    if (type === HomeKitHistory.SET) {
      received.push(data);
    }
    return data;
  } });
  let set = leak.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  let detected = leak.getCharacteristic(hap.Characteristic.LeakDetected);
  await set(Buffer.from('4d010a4e0103', 'hex').toString('base64'));
  context.mock.timers.tick(5000);
  await set(Buffer.from('4d0100', 'hex').toString('base64'));
  assert.equal(history.EveWaterGuardPersist.alarmtest, false);
  assert.equal(history.EveWaterGuardPersist.alarmtestduration, 10);
  assert.equal(detected.value, hap.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
  assert.deepEqual(received.at(-1), { alarmtest: false });

  // A later leak must not be cleared by the cancelled test or a repeated end command without an active simulation.
  leak.updateCharacteristic(hap.Characteristic.LeakDetected, hap.Characteristic.LeakDetected.LEAK_DETECTED);
  await set(Buffer.from('4d0100', 'hex').toString('base64'));
  context.mock.timers.tick(20000);
  assert.equal(detected.value, hap.Characteristic.LeakDetected.LEAK_DETECTED);
});

test('Aqua retains empty program slots and their weekday IDs when decoding and re-encoding', async () => {
  let { history, hap } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  let programs = [];
  await history.linkToEveHome(valve, { messages(type, data) {
    if (type === HomeKitHistory.SET) {
      programs = data.programs;
    }
    return { ...data, programs };
  } });
  let schedule = '450f0503000000080008000a01052d014b';
  let days = '460705aa1b2c2f0000';
  await valve.getCharacteristic(hap.Characteristic.EveSetConfiguration)
    .setHandler(Buffer.from(schedule + days, 'hex').toString('base64'));
  assert.deepEqual(programs, [
    { id: 1, days: [], schedule: [] },
    { id: 2, days: ['mon'], schedule: [{ start: 21600, duration: 14400, offset: 21600 }] },
  ]);
  let configuration = await valve.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
  assert.equal(Buffer.from(configuration, 'base64').toString('hex').includes(schedule), true);
});

test('Aqua rejects incomplete or invalid program lists while retaining valid unrelated commands and explicit clears', async () => {
  let { history, hap } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  let received = [];
  await history.linkToEveHome(valve, { messages(type, data) {
    if (type === HomeKitHistory.SET) {
      received.push(data);
    }
    return data;
  } });
  let set = valve.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  let days = '460705aa1b2c1f0000';
  for (let payload of [
    '0502000000', // Short fixed header.
    '050200000008000a', // Incomplete nested header.
    '050200000008000a010500', // Incomplete first range.
    '050300000008000a01052d014b0a010500', // Incomplete later program.
    '050200000008000a010000014b', // Unknown start marker.
    '050200000008000a01052d0000', // Unknown end marker.
    '050200000008000b02052d014b00000000', // Invalid later range.
    '050300000008000a01052d014b', // Declared second user slot is missing.
    '050100000008000a01052d014b', // More user slots than declared.
    '05000000000800', // The reserved default slot must be included in the count.
  ]) {
    let packet = '45' + (payload.length / 2).toString(16).padStart(2, '0') + payload;
    await set(Buffer.from(packet + days + '2e022c01', 'hex').toString('base64'));
    assert.deepEqual(received.at(-1), { flowrate: 18 });
  }
  let count = received.length;
  await set(Buffer.from(days, 'hex').toString('base64'));
  assert.equal(received.length, count);
  // A fully decoded list containing only the reserved default slot intentionally clears programs.
  await set(Buffer.from('450705010000000800' + days, 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { programs: [] });
  for (let [words, expected] of [
    ['e5b301b4', { start: 86340, duration: 60, offset: 86340 }], // 23:59 through midnight: unsigned 16-bit words.
    ['e707a302', { start: 'sunrise', duration: 1200, offset: -900 }],
    ['c7078302', { start: 'sunset', duration: 1200, offset: -900 }],
    ['e707e302', { start: 'sunrise', duration: 600, offset: -900 }], // Both boundaries before sunrise.
    ['a707a311', { start: 'sunrise', duration: 1200, offset: 900 }], // Both boundaries after sunrise.
    ['67006300', { start: 'sunrise', duration: 0, offset: 0 }], // Before-event flags with zero magnitudes.
  ]) {
    await set(Buffer.from('450d050200000008000a01' + words + days, 'hex').toString('base64'));
    assert.deepEqual(received.at(-1).programs[0].schedule, [expected]);
  }
});

test('scaled Eve fields enforce signed or unsigned wire limits without changing raw history', async () => {
  for (let [serviceName, field, index, signed, valid, invalid] of [
    ['TemperatureSensor', 'temperature', 0, true,
      [[-327.68, -32768], [327.67, 32767], [327.674, 32767], [-0.01, -1]], [-327.69, 327.68, 327.675, 655.35]],
    ['TemperatureSensor', 'humidity', 1, false,
      [[0, 0], [327.68, 32768], [655.35, 65535], [655.354, 65535]], [-0.01, 655.36, 655.355]],
    ['TemperatureSensor', 'ppm', 2, false,
      [[0, 0], [6553.5, 65535]], [-0.1, 6553.6]],
    ['EveAirPressureSensor', 'pressure', 2, false,
      [[0, 0], [6553.5, 65535]], [-0.1, 6553.6]],
    ['AirQualitySensor', 'voc', 2, false,
      [[0, 0], [65535, 65535]], [-1, 65536]],
    ['Outlet', 'watts', 0, false,
      [[0, 0], [6553.5, 65535]], [-0.1, 6553.6]],
    ['Thermostat', 'target', 2, true,
      [[-327.68, -32768], [327.67, 32767]], [-327.69, 327.68]],
  ]) {
    for (let [value, expected] of valid.concat(
      invalid.concat([1e20, Number.MAX_VALUE, NaN, Infinity]).map((number) => [number, undefined]),
    )) {
      let { history, hap } = createHistory();
      let target = new hap.Service[serviceName]('Sensor', 1);
      let entry = { time: 978307300, status: 1, temperature: 20, humidity: 40, target: { low: 0, high: 21 } };
      entry[field] = field === 'target' ? { low: 0, high: value } : value;
      assert.equal(history.addHistory(target, entry), true);
      let service = await history.linkToEveHome(target);
      service.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
      service.getCharacteristic(hap.Characteristic.EveHistoryRequest)
        .setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
      let packet = Buffer.from(service.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
      let maskOffset = packet[0] + 9;
      assert.equal((packet[maskOffset] & (1 << index)) !== 0, expected !== undefined, serviceName + ' ' + field + ': ' + value);
      if (expected !== undefined) {
        let offset = maskOffset + 1 + index * 2;
        assert.equal(signed === true ? packet.readInt16LE(offset) : packet.readUInt16LE(offset), expected);
      }
      assert.deepEqual(history.lastHistory(target)[field], entry[field]);
    }
  }
});

test('Eve excludes a power-only overflow record while keeping later valid entries transferable', async () => {
  let { history, hap } = createHistory();
  let outlet = new hap.Service.Outlet('Outlet', 1);
  history.addHistory(outlet, { time: 978307300, watts: 1e20 });
  let service = await history.linkToEveHome(outlet);
  assert.equal(history.EveHome.count, 0);
  history.addHistory(outlet, { time: 978307360, watts: 10 });
  service.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
  assert.equal(history.EveHome.count, 1);
  assert.equal(history.entryCount(outlet), 2);
  service.getCharacteristic(hap.Characteristic.EveHistoryRequest)
    .setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
  let packet = Buffer.from(service.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
  assert.equal(packet[packet[0] + 9], 1);
  assert.equal(packet.readUInt16LE(packet[0] + 10), 100);
});

test('dynamic Eve getters return promises and updates refresh only the linked family characteristics', async () => {
  for (let [name, characteristics, details] of [
    ['Lightbulb', ['EveGetConfiguration'], { poweronbehavior: 2 }],
    ['LeakSensor', ['EveGetConfiguration'], { muted: true }],
    ['Valve', ['EveGetConfiguration'], { flowrate: 12 }],
    ['IrrigationSystem', ['EveGetConfiguration'], { flowrate: 12 }],
    ['Thermostat', ['EveProgramData'], { tempoffset: 1.5 }],
    ['HeaterCooler', ['EveProgramData'], { tempoffset: 1.5 }],
    ['SmokeSensor', ['EveDeviceStatus', 'EveGetConfiguration'], { heatstatus: true }],
    ['Outlet', ['EveElectricalWattage', 'EveElectricalVoltage', 'EveElectricalCurrent'], { watts: 42, volts: 230, amps: 0.5 }],
    ['Switch', [], {}],
  ]) {
    let { history, hap } = createHistory();
    let service = new hap.Service[name](name, 1);
    let reads = 0;
    await history.linkToEveHome(service, { async messages(type, state) {
      assert.equal(type, HomeKitHistory.GET);
      reads++;
      await Promise.resolve();
      return { ...state, ...details };
    } });
    for (let characteristic of characteristics) {
      let result = service.getCharacteristic(hap.Characteristic[characteristic]).getHandler();
      assert.equal(result instanceof Promise, true, name + ' ' + characteristic);
      let value = await result;
      if (name === 'Outlet') {
        assert.equal(
          value,
          details[characteristic === 'EveElectricalWattage' ? 'watts' : characteristic === 'EveElectricalVoltage' ? 'volts' : 'amps'],
        );
      } else if (characteristic === 'EveDeviceStatus') {
        assert.equal(value & (1 << 1), 1 << 1);
      } else {
        assert.equal(typeof value, 'string');
        assert.equal(Buffer.from(value, 'base64').length > 0, true);
      }
    }
    let updates = [];
    let update = service.updateCharacteristic.bind(service);
    service.updateCharacteristic = (characteristic, value) => {
      updates.push(characteristic.UUID);
      return update(characteristic, value);
    };
    let before = reads;
    await history.updateEveHome(new hap.Service[name]('Unlinked', 2));
    assert.equal(reads, before);
    await history.updateEveHome(service);
    assert.deepEqual(updates, characteristics.map((name) => hap.Characteristic[name].UUID));
    assert.equal(reads - before, characteristics.length);
  }
});

test('Contact and Motion expose live activation, reset, counts, and configuration callbacks', async () => {
  for (let name of ['ContactSensor', 'MotionSensor']) {
    let { history, hap } = createHistory();
    let service = new hap.Service[name](name, 1);
    history.addHistory(service, { time: 978307300, status: 0 });
    history.addHistory(service, { time: 978307360, status: 1 });
    let eve = await history.linkToEveHome(service, { EveMotion_duration: 10, EveMotion_sensitivity: 4, EveMotion_ledmotion: true });
    assert.equal(eve.getCharacteristic(hap.Characteristic.EveResetTotal).getHandler(), history.historyData.reset - 978307200);
    assert.equal(service.getCharacteristic(hap.Characteristic.EveLastActivation).getHandler(), 60);
    if (name === 'ContactSensor') {
      assert.equal(service.getCharacteristic(hap.Characteristic.EveTimesOpened).getHandler(), 1);
      eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
      eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000000000000', 'hex').toString('base64'));
      let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
      assert.equal(packet[packet[0] + 10], 0);
      assert.equal(packet[packet[0] + packet[packet[0]] + 10], 1);
    } else {
      let duration = service.getCharacteristic(hap.Characteristic.EveMotionDuration);
      let sensitivity = service.getCharacteristic(hap.Characteristic.EveMotionSensitivity);
      assert.equal(duration.getHandler(), 10);
      assert.equal(sensitivity.getHandler(), 4);
      duration.setHandler(30);
      sensitivity.setHandler(7);
      assert.equal(duration.getHandler(), 30);
      assert.equal(sensitivity.getHandler(), 7);
    }
  }
});

test('Aqua transfers valve usage, omits usage on open events, and aggregates irrigation subtypes', async () => {
  for (let name of ['Valve', 'IrrigationSystem']) {
    let { history, hap } = createHistory();
    let service = new hap.Service[name](name, 1);
    let first = new hap.Service.Valve('First', 1);
    let second = new hap.Service.Valve('Second', 2);
    history.addHistory(first, { time: 978307300, status: 1, water: 0, duration: 0 });
    history.addHistory(name === 'Valve' ? first : second, { time: 978307360, status: 0, water: 1.2345, duration: 60 });
    let eve = await history.linkToEveHome(service);
    eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
    assert.equal(history.EveHome.count, 2);
    eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
    let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
    let open = packet[0];
    assert.equal(packet[open + 9], 5);
    assert.equal(packet[open + 10], 1);
    assert.equal(packet.readUInt16LE(open + 11), 3120);
    let closed = open + packet[open];
    assert.equal(packet[closed + 9], 7);
    assert.equal(packet[closed + 10], 0);
    assert.equal(packet.readBigUInt64LE(closed + 11), 1234n);
    let configuration = await service.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
    assert.match(Buffer.from(configuration, 'base64').toString('hex'), /2f0ed204000000000000/);
  }
});

test('Thermo configuration encodes schedule temperatures, weekdays, and vacation settings', async () => {
  let { history, hap } = createHistory();
  let thermo = new hap.Service.Thermostat('Thermo', 1);
  await history.linkToEveHome(thermo, {
    EveThermo_attached: true, EveThermo_enableschedule: true, EveThermo_pause: true,
    EveThermo_vacation: true, EveThermo_vacationtemp: 18, EveThermo_tempoffset: -1,
    EveThermo_programs: [{ days: 'MON', schedule: [{ start: 21600, duration: 3600, ecotemp: 16, comforttemp: 21 }] }],
  });
  let value = await thermo.getCharacteristic(hap.Characteristic.EveProgramData).getHandler();
  let hex = Buffer.from(value, 'base64').toString('hex');
  assert.match(hex, /^12f6130114c0190124f40000202afa242a/);
  assert.equal(hex.endsWith('ff'.repeat(54)), true);
});

test('every documented recording profile accepts its shape and rejects missing required fields without consuming state', () => {
  let { history, hap } = createHistory();
  history.restart = undefined;
  for (let [name, entry] of [
    ['ContactSensor', { status: 0 }], ['Door', { status: 1 }], ['GarageDoorOpener', { status: 0 }],
    ['LockMechanism', { status: 0 }], ['Fan', { status: 1 }], ['Fanv2', { status: 1 }],
    ['HumidifierDehumidifier', { status: 1 }], ['MotionSensor', { status: 1 }], ['Switch', { status: 1 }],
    ['Lightbulb', { status: 1 }], ['Window', { status: 1, position: 50 }], ['WindowCovering', { status: 1, position: 50 }],
    ['HeaterCooler', { status: 2, temperature: 20, target: { low: 21, high: 0 }, humidity: 40 }],
    ['Thermostat', { status: 1, temperature: 20, target: { low: 0, high: 21 }, humidity: 40 }],
    ['TemperatureSensor', { temperature: 20 }], ['AirQualitySensor', { temperature: 20 }],
    ['EveAirPressureSensor', { temperature: 20 }], ['Valve', { status: 0, water: 1, duration: 60 }],
    ['LeakSensor', { status: 0 }], ['Doorbell', { status: 1 }], ['SmokeSensor', { status: 1 }],
    ['WaterLevel', { level: 50 }],
  ]) {
    let target = name === 'WaterLevel' ? { UUID: hap.Characteristic.WaterLevel.UUID } : new hap.Service[name](name, 1);
    assert.equal(history.addHistory(target, { ...entry, time: 100, ignored: 'ignored' }, 60), true);
    assert.equal(history.lastHistory(target).ignored, undefined);
    let count = history.entryCount(target);
    for (let key of Object.keys(entry)) {
      let incomplete = { ...entry, time: 200 };
      delete incomplete[key];
      assert.equal(history.addHistory(target, incomplete), false, name + ' requires ' + key);
    }
    assert.equal(history.entryCount(target), count);
    assert.equal(history.addHistory(target, { ...entry, time: 101 }, 60), false);
  }
});

test('Blind configuration reads and known, unknown, and incomplete commands retain framing', async () => {
  let logs = [];
  let { history, hap } = createHistory({ log: { debug(...args) {
    logs.push(args);
  }, warn(...args) {
    logs.push(args);
  } } });
  let blind = new hap.Service.WindowCovering('Blind', 1);
  blind.updateCharacteristic(hap.Characteristic.CurrentPosition, 50);
  await history.linkToEveHome(blind);
  let value = blind.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
  assert.match(Buffer.from(value, 'base64').toString('hex'), /^000255000302a30b9b04[0-9a-f]{8}1e0255000c$/);
  let set = blind.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  for (let packet of [undefined, Buffer.from('f3', 'hex').toString('base64'), Buffer.from('f3020258', 'hex').toString('base64')]) {
    set(packet);
    assert.equal(blind.getCharacteristic(hap.Characteristic.CurrentPosition).value, 50);
  }
  set(Buffer.from('0000f00102f10101ee00f303025802f303035802', 'hex').toString('base64'));
  assert.equal(blind.getCharacteristic(hap.Characteristic.CurrentPosition).value, 49);
  assert.equal(blind.getCharacteristic(hap.Characteristic.TargetPosition).value, 49);
  assert.equal(logs.some((args) => args[0].includes('Unknown Eve MotionBlinds')), true);
});

test('Thermo pause, vacation, ignored commands, and missing schedule temperatures preserve command boundaries', async () => {
  let received = [];
  let { history, hap } = createHistory();
  let thermo = new hap.Service.Thermostat('Thermo', 1);
  await history.linkToEveHome(thermo, { messages(type, data) {
    if (type === HomeKitHistory.SET) {
      received.push(data);
    }
    return data;
  } });
  let set = thermo.getCharacteristic(hap.Characteristic.EveProgramCommand).setHandler;
  await set(Buffer.from('7f1014c01820190124f6000000ee', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { pause: true, vacation: { status: true, temp: 18 } });
  await set(Buffer.from('18101900ff', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { pause: false, vacation: { status: false, temp: null } });
  await set(Buffer.from('fa' + 'ff'.repeat(56) + '1205', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { tempoffset: 0.5 });
  await set(Buffer.from('f4808080fa' + 'ff'.repeat(56), 'hex').toString('base64'));
  assert.deepEqual(received.at(-1).scheduleTemps, { eco: null, comfort: null });
  assert.equal(received.at(-1).programs.length, 7);
  assert.equal(received.at(-1).programs.every((program) => program.schedule.length === 0), true);
});

test('Aqua reset, enable, timezone, DST, pause, and malformed weekday commands route only understood values', async () => {
  let received = [];
  let { history, hap } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  await history.linkToEveHome(valve, { EveAqua_programs: null, messages(type, data) {
    if (type === HomeKitHistory.SET) {
      received.push(data);
    }
    return data;
  } });
  let set = valve.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  await set(Buffer.from('2f040a00000044030503004b04a0050000ee00', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { timestamp: 978307210, enabled: true, pause: 2 });
  await set(Buffer.from('4403050200', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { enabled: false });
  await set(Buffer.from('44090510000000d4feffff', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { utcoffset: -18000, latitude: 0, longitude: 0 });
  let dst = '47110594186d19071ad91ab40000003c000000';
  let count = received.length;
  await set(Buffer.from(dst, 'hex').toString('base64'));
  assert.equal(history.EveAquaPersist.command47, dst);
  assert.equal(received.length, count);
  await set(Buffer.from('450d050200000008000a01052d014b46002e022c01', 'hex').toString('base64'));
  assert.deepEqual(received.at(-1), { flowrate: 18 });
  let config = await valve.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler();
  assert.match(Buffer.from(config, 'base64').toString('hex'), /4b04a0050000/);
});

test('Smoke reads reflect live alarms and unknown or off commands do not create false updates', async () => {
  let received = [];
  let { history, hap } = createHistory();
  let smoke = new hap.Service.SmokeSensor('Smoke', 1);
  smoke.updateCharacteristic(hap.Characteristic.SmokeDetected, hap.Characteristic.SmokeDetected.SMOKE_DETECTED);
  await history.linkToEveHome(smoke, {
    EveSmoke_alarmtest: true, EveSmoke_heatstatus: true, EveSmoke_hushedstate: true,
    EveSmoke_smoketestpassed: true, EveSmoke_heattestpassed: true,
    messages(type, data) {
      if (type === HomeKitHistory.SET) {
        received.push(data);
      } return data;
    },
  });
  let status = await smoke.getCharacteristic(hap.Characteristic.EveDeviceStatus).getHandler();
  assert.equal(status, (1 << 25) | 7);
  let set = smoke.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler;
  await set(Buffer.from('40029900ee00', 'hex').toString('base64'));
  assert.equal(received.length, 0);
  await set(Buffer.from('4002020040020500', 'hex').toString('base64'));
  assert.deepEqual(received, [{ alarmtest: false, statusled: false }]);
});

test('Light Strip and Water Guard ignore unknown commands and unrecognised settings', async () => {
  for (let [name, stateKey, packet] of [
    ['Lightbulb', 'EveLightStripPersist', 'ee006501036c020100'],
    ['LeakSensor', 'EveWaterGuardPersist', 'ee004e0102'],
  ]) {
    let { history, hap } = createHistory();
    let service = new hap.Service[name](name, 1);
    let received = [];
    await history.linkToEveHome(service, { messages(type, data) {
      if (type === HomeKitHistory.SET) {
        received.push(data);
      }
      return data;
    } });
    let before = structuredClone(history[stateKey]);
    await service.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler(Buffer.from(packet, 'hex').toString('base64'));
    assert.deepEqual(history[stateKey], before);
    assert.equal(received.length, 0);
  }
});

test('Eve SET router rejections propagate through every routed family callback', async () => {
  for (let [name, characteristic, packet] of [
    ['Lightbulb', 'EveSetConfiguration', '650102'], ['LeakSensor', 'EveSetConfiguration', '4e0101'],
    ['SmokeSensor', 'EveSetConfiguration', '40020501'], ['Valve', 'EveSetConfiguration', '2e022c01'],
    ['Thermostat', 'EveProgramCommand', '1205'],
  ]) {
    let { history, hap } = createHistory();
    let service = new hap.Service[name](name, 1);
    let failure = new Error('device write rejected');
    await history.linkToEveHome(service, { messages(type, data) {
      if (type === HomeKitHistory.SET) {
        throw failure;
      }
      return data;
    } });
    await assert.rejects(service.getCharacteristic(hap.Characteristic[characteristic])
      .setHandler(Buffer.from(packet, 'hex').toString('base64')), (error) => error === failure);
  }
});

test('inactive instances reject recording and linking without dereferencing an unavailable runtime', async () => {
  for (let invalid of ['api', 'identity']) {
    let errors = [];
    let hap = createHap(new MockStorage());
    let history = new HomeKitHistory(invalid === 'identity' ? {} : { UUID: 'INACTIVE' },
      invalid === 'api' ? undefined : { version: 2, hap }, { error(...args) {
        errors.push(args);
      } });
    let service = new hap.Service.MotionSensor('Motion', 1);
    assert.equal(errors.length, 1);
    assert.equal(history.addHistory(service, { status: 1 }), false);
    assert.equal(await history.linkToEveHome(service), undefined);
    assert.equal(history.entryCount(null), 0);
    await history.updateEveHome(service);
  }
});

test('storage initialisation failures and missing read/write methods retain usable memory-only history', () => {
  for (let mode of ['initialisation', 'missing-methods', 'read-only']) {
    let storage = mode === 'read-only' ? { getItem() {
      return undefined;
    } } : {};
    let hap = createHap(storage);
    let warnings = [];
    if (mode === 'initialisation') {
      hap.HAPStorage.storage = () => {
        throw 'storage offline';
      };
    }
    let history = new HomeKitHistory(new MockAccessory('MEMORY-ONLY'), { version: 2, hap }, {
      warn(...args) {
        warnings.push(args);
      },
    });
    let service = new hap.Service.Outlet('Outlet', 1);
    let restart = history.restart;
    assert.equal(history.addHistory(service, { volts: 230 }), false);
    assert.equal(history.restart, restart);
    assert.equal(history.addHistory(service, { status: 1, watts: 42 }), true);
    assert.equal(history.lastHistory(service).watts, 42);
    assert.equal(warnings.length, mode === 'initialisation' ? 1 : 0);
    if (mode === 'initialisation') {
      assert.equal(warnings[0][1], 'storage offline');
    }
  }
});

test('CSV returns no stream for empty history or invalid paths and exposes asynchronous filesystem errors', async () => {
  let { history, hap } = createHistory();
  let motion = new hap.Service.MotionSensor('Motion', 1);
  assert.equal(history.generateCSV(motion, 'unused.csv'), undefined);
  history.addHistory(motion, { status: 1 });
  for (let filename of [undefined, '', null, 1]) {
    assert.equal(history.generateCSV(motion, filename), undefined);
  }
  let directory = await mkdtemp(path.join(tmpdir(), 'homekit-history-csv-error-'));
  try {
    let writer = history.generateCSV(motion, path.join(directory, 'missing', 'history.csv'));
    await assert.rejects(once(writer, 'finish'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unbounded retention and default-subtype Eve sessions retain reset and transfer semantics', async () => {
  let { history, hap } = createHistory({ maxEntries: 0 });
  let door = new hap.Service.Door('Door');
  let eve = await history.linkToEveHome(door);
  let status = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler(), 'base64');
  assert.equal(history.EveHome.count, 0);
  assert.equal(status.readUInt16LE(17), 16384);
  for (let time = 978307300; time < 978307320; time++) {
    history.addHistory(door, { time, status: 0 });
  }
  assert.equal(history.entryCount(door), 20);
  assert.equal(history.historyData.next, 20);
  eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
  eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
  let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
  assert.equal(packet[packet[0] + 10], 1); // Door state zero is inverted for the Eve contact field.
  history.rolloverHistory();
  assert.equal(history.entryCount(door), 20);
  assert.equal(history.historyData.next, 0);
  history.resetHistory();
  assert.equal(eve.getCharacteristic(hap.Characteristic.EveResetTotal).getHandler(), history.historyData.reset - 978307200);
});

test('Eve linking gracefully reports unavailable accessory service wiring', async () => {
  let { history, hap, accessory } = createHistory();
  accessory.addService = undefined;
  assert.equal(await history.linkToEveHome(new hap.Service.Switch('Switch', 1)), undefined);
});

test('Eve adapter options reach the advertised firmware, location, and enabled schedule configuration', async () => {
  let thermoSetup = createHistory();
  let thermo = new thermoSetup.hap.Service.Thermostat('Thermo', 1);
  await thermoSetup.history.linkToEveHome(thermo, { EveThermo_firmware: 2834 });
  assert.equal(
    Buffer.from(thermo.getCharacteristic(thermoSetup.hap.Characteristic.EveFirmware).value, 'base64').toString('hex'),
    '2c120bbe',
  );

  let smokeSetup = createHistory();
  let smoke = new smokeSetup.hap.Service.SmokeSensor('Smoke', 1);
  await smokeSetup.history.linkToEveHome(smoke, { EveSmoke_firmware: 2000, EveSmoke_lastalarmtest: 1234 });
  assert.equal(smokeSetup.history.EveSmokePersist.firmware, 2000);
  assert.equal(smokeSetup.history.EveSmokePersist.lastalarmtest, 1234);

  let aquaSetup = createHistory();
  let valve = new aquaSetup.hap.Service.Valve('Valve', 1);
  await aquaSetup.history.linkToEveHome(valve, {
    EveAqua_firmware: 1234, EveAqua_latitude: 52, EveAqua_longitude: -3,
    EveAqua_utcoffset: -18000, EveAqua_pause: 2, EveAqua_enableschedule: true,
  });
  let value = await valve.getCharacteristic(aquaSetup.hap.Characteristic.EveGetConfiguration).getHandler();
  let hex = Buffer.from(value, 'base64').toString('hex');
  assert.equal(hex.startsWith('000223000302d204'), true);
  assert.match(hex, /44110517000000d4feffff00005042000040c0/);
  assert.match(hex, /4b04a0050000/);
});

test('A1: malformed GET programs preserve the last usable Thermo configuration', async () => {
  let { history, hap } = createHistory();
  let thermo = new hap.Service.Thermostat('Thermo', 1);
  let invalid = false;
  await history.linkToEveHome(thermo, { messages(type, data) {
    return invalid === true ? { programs: [{}] } : data;
  } });
  let before = structuredClone(history.EveThermoPersist);
  invalid = true;
  await assert.doesNotReject(() => thermo.getCharacteristic(hap.Characteristic.EveProgramData).getHandler());
  assert.deepEqual(history.EveThermoPersist, before);
});

test('A6: unrepresentable Aqua water values remain in raw history without breaking Eve setup', async () => {
  let { history, hap } = createHistory();
  let valve = new hap.Service.Valve('Valve', 1);
  assert.equal(history.addHistory(valve, { time: 978307300, status: 0, water: 1e20, duration: 60 }), true);
  await assert.doesNotReject(() => history.linkToEveHome(valve));
  assert.equal(history.lastHistory(valve).water, 1e20);
});

test('binary Eve fields accept boolean and numeric states and omit unrepresentable raw states', async () => {
  for (let [status, expected] of [[false, 0], [true, 1], [0, 0], [1, 1], [2, undefined], ['1', undefined], [null, undefined]]) {
    let { history, hap } = createHistory();
    let service = new hap.Service.Switch('Switch', 1);
    assert.equal(history.addHistory(service, { time: 978307300, status }), true);
    let eve = await history.linkToEveHome(service);
    eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
    assert.equal(history.EveHome.count, expected === undefined ? 0 : 1);
    eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
    let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
    if (expected === undefined) {
      assert.deepEqual(packet, Buffer.from([0]));
    } else {
      assert.equal(packet[packet[0] + 10], expected);
    }
    assert.equal(history.lastHistory(service).status, status);
  }
});

test('invalid retention limits use defaults and explicit restart markers bypass otherwise active gaps', () => {
  for (let maxEntries of [-1, 1.5, '2', null, NaN, Infinity]) {
    let { history, hap } = createHistory({ maxEntries });
    let service = new hap.Service.Switch('Switch', 1);
    history.restart = undefined;
    for (let time = 100; time < 104; time++) {
      assert.equal(history.addHistory(service, { time, status: 1 }, -10), true);
    }
    assert.equal(history.entryCount(service), 4);
    assert.equal(history.historyData.next, 4);
    assert.equal(history.addHistory(service, { time: 104, status: 0, restart: 90 }, 60), true);
    assert.equal(history.lastHistory(service).restart, 90);
    assert.equal(history.addHistory(service, { time: 105, status: 1 }, 60), false);
  }
});

test('multiple accessories share registered Eve HAP types while keeping their history stores separate', () => {
  let storage = new MockStorage();
  let hap = createHap(storage);
  let first = new HomeKitHistory(new MockAccessory('FIRST'), { version: 2, hap });
  let historyType = hap.Service.EveHomeHistory;
  let statusType = hap.Characteristic.EveHistoryStatus;
  let second = new HomeKitHistory(new MockAccessory('SECOND'), { version: 2, hap });
  assert.equal(hap.Service.EveHomeHistory, historyType);
  assert.equal(hap.Characteristic.EveHistoryStatus, statusType);
  let service = new hap.Service.Switch('Switch', 1);
  first.addHistory(service, { time: 100, status: 1 });
  second.addHistory(service, { time: 200, status: 0 });
  assert.equal(first.lastHistory(service).time, 100);
  assert.equal(second.lastHistory(service).time, 200);
  assert.equal(storage.getItem('History.FIRST.json').data[0].status, 1);
  assert.equal(storage.getItem('History.SECOND.json').data[0].status, 0);
});

test('A1: malformed schedules reject the whole GET update and later valid reads recover', async () => {
  for (let family of ['Thermo', 'Aqua']) {
    let warnings = [];
    let { history, hap } = createHistory({ log: { warn(...args) {
      warnings.push(args);
    } } });
    let service = family === 'Thermo' ? new hap.Service.Thermostat('Thermo', 1) : new hap.Service.Valve('Aqua', 1);
    let response = { programs: [{}] };
    await history.linkToEveHome(service, { messages() {
      return response;
    } });
    let stateKey = 'Eve' + family + 'Persist';
    let get = service.getCharacteristic(
      family === 'Thermo' ? hap.Characteristic.EveProgramData : hap.Characteristic.EveGetConfiguration,
    ).getHandler;
    let before = structuredClone(history[stateKey]);
    let expected = await get();
    let schedule = family === 'Thermo'
      ? { start: 3600, duration: 600, ecotemp: 16, comforttemp: 20 }
      : { start: 3600, duration: 600 };
    let program = family === 'Thermo' ? { days: 'MON', schedule: [schedule] } : { id: 1, days: ['mon'], schedule: [schedule] };
    let malformed = [undefined, 'invalid', 1, new Date(), [null], [1], [{}], [{ ...program, schedule: null }],
      [{ ...program, days: null }], [{ ...program, days: family === 'Thermo' ? 'bad' : ['bad'] }],
      [{ ...program, schedule: [null] }], [{ ...program, schedule: [1] }],
      [{ ...program, schedule: [{ ...schedule, duration: Infinity }] }],
      [{ ...program, schedule: [{ ...schedule, start: NaN }] }]];
    if (family === 'Thermo') {
      malformed.push([{ ...program, schedule: [{ ...schedule, ecotemp: undefined }] }],
        [{ ...program, schedule: [{ ...schedule, comforttemp: '20' }] }]);
    } else {
      malformed.push({ monday: program }, ...[0, 8, 1.5].map((id) => [{ ...program, id }]),
        [{ ...program, schedule: [{ start: 'sunrise', duration: 600, offset: NaN }] }],
        [{ ...program, schedule: [{ start: 'invalid', duration: 600, offset: 0 }] }]);
    }
    for (let programs of malformed) {
      response = { programs, enableschedule: true };
      assert.equal(await get(), expected);
      assert.deepEqual(history[stateKey], before);
    }
    assert.equal(warnings.length, malformed.length + 2);
    assert.match(warnings.at(-1)[1], /Invalid Eve/);
    response = { programs: family === 'Thermo' ? { monday: program } : [program], enableschedule: true };
    await get();
    assert.equal(history[stateKey].enableschedule, true);
    assert.deepEqual(history[stateKey].programs, response.programs);
    program.schedule[0].start = 7200;
    assert.equal(Object.values(history[stateKey].programs)[0].schedule[0].start, 3600);
    for (let validSchedule of family === 'Thermo'
      ? [{ ...schedule, ecotemp: null, comforttemp: null }]
      : [{ start: 'sunrise', offset: -600, duration: 1200 }, { start: 'sunset', offset: 600, duration: 1200 }]) {
      response = { programs: [{ ...program, schedule: [validSchedule] }] };
      await get();
      assert.deepEqual(history[stateKey].programs, response.programs);
    }
    response = { programs: null };
    await get();
    assert.equal(history[stateKey].programs, null);
  }
});

test('A1: invalid scalar updates and formatter failures preserve retained state', async () => {
  let { history, hap } = createHistory();
  let thermo = new hap.Service.Thermostat('Thermo', 1);
  let response = {};
  await history.linkToEveHome(thermo, { messages() {
    return response;
  } });
  let get = thermo.getCharacteristic(hap.Characteristic.EveProgramData).getHandler;
  let before = structuredClone(history.EveThermoPersist);
  let expected = await get();
  for (let update of [{ tempoffset: NaN }, { tempoffset: Infinity }, { tempoffset: '1' },
    { enableschedule: 1 }, { vacationtemp: '20' }, { vacationtemp: 1e20, vacation: true }]) {
    response = update;
    assert.equal(await get(), expected);
    assert.deepEqual(history.EveThermoPersist, before);
  }
  for (let vacationtemp of [18, null]) {
    response = { vacationtemp };
    await get();
    assert.equal(history.EveThermoPersist.vacationtemp, vacationtemp);
  }
});

test('A6: invalid water samples preserve raw records and omit only the unusable wire field', async () => {
  for (let water of [NaN, Infinity, -Infinity, -1, '1', null, 1e20, Number.MAX_VALUE, 2 ** 64 / 1000]) {
    let { history, hap } = createHistory();
    let valve = new hap.Service.Valve('Valve', 1);
    history.addHistory(valve, { time: 978307300, status: 0, water, duration: 60 });
    history.addHistory(valve, { time: 978307360, status: 0, water: 1.2345, duration: 60 });
    let eve = await history.linkToEveHome(valve);
    assert.equal(history.getHistory(valve)[0].water, water);
    eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
    assert.equal(history.EveHome.count, 2);
    eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
    let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
    let first = packet[0];
    assert.equal(packet[first + 9], 5);
    let second = first + packet[first];
    assert.equal(packet[second + 9], 7);
    assert.equal(packet.readBigUInt64LE(second + 11), 1234n);
    let configuration = Buffer.from(await valve.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler(), 'base64');
    assert.equal(configuration.readBigUInt64LE(configuration.indexOf(Buffer.from('2f0e', 'hex')) + 2), 1234n);
  }
});

test('A6: Aqua uses unsigned 64-bit water fields and preserves aggregate rounding without overflow', async () => {
  for (let [samples, expected] of [
    [[2 ** 40], BigInt(2 ** 40 * 1000)],
    [[0.0006, 0.0006], 1n],
    [[1e16, 1e16], 10000000000000000000n],
  ]) {
    let { history, hap } = createHistory();
    let valve = new hap.Service.Valve('Valve', 1);
    samples.forEach((water, index) => history.addHistory(valve, { time: 978307300 + index, status: 0, water, duration: 60 }));
    let eve = await history.linkToEveHome(valve);
    let configuration = Buffer.from(await valve.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler(), 'base64');
    assert.equal(configuration.readBigUInt64LE(configuration.indexOf(Buffer.from('2f0e', 'hex')) + 2), expected);
    eve.getCharacteristic(hap.Characteristic.EveHistoryStatus).getHandler();
    eve.getCharacteristic(hap.Characteristic.EveHistoryRequest).setHandler(Buffer.from('000001000000', 'hex').toString('base64'));
    let packet = Buffer.from(eve.getCharacteristic(hap.Characteristic.EveHistoryEntries).getHandler(), 'base64');
    let offset = packet[0];
    for (let water of samples) {
      assert.equal(packet.readBigUInt64LE(offset + 11), BigInt(Math.floor(water * 1000)));
      offset += packet[offset];
    }
  }
});


test('A1: Energy rejects non-finite and mistyped live readings and recovers on the next read', async () => {
  let { history, hap } = createHistory();
  let outlet = new hap.Service.Outlet('Energy', 1);
  let response = {};
  await history.linkToEveHome(outlet, { messages() {
    return response;
  } });
  for (let [key, characteristic] of [
    ['watts', 'EveElectricalWattage'], ['volts', 'EveElectricalVoltage'], ['amps', 'EveElectricalCurrent'],
  ]) {
    let get = outlet.getCharacteristic(hap.Characteristic[characteristic]).getHandler;
    for (let invalid of [NaN, Infinity, '1', null]) {
      response = { [key]: invalid };
      assert.equal(await get(), null);
    }
    response = { [key]: 1.25 };
    assert.equal(await get(), 1.25);
  }
});

test('initial Thermo and Aqua programs are validated and detached without a GET router', async () => {
  for (let family of ['Thermo', 'Aqua']) {
    for (let malformed of [false, true]) {
      let warnings = [];
      let { history, hap } = createHistory({ log: { warn(...args) {
        warnings.push(args);
      } } });
      let service = family === 'Thermo' ? new hap.Service.Thermostat('Thermo', 1) : new hap.Service.Valve('Aqua', 1);
      let programs = malformed === true ? [{}] : [family === 'Thermo'
        ? { days: 'mon', schedule: [{ start: 3600, duration: 600, ecotemp: 16, comforttemp: 20 }] }
        : { id: 1, days: ['mon'], schedule: [{ start: 3600, duration: 600 }] }];
      await history.linkToEveHome(service, { ['Eve' + family + '_programs']: programs });
      let retained = history['Eve' + family + 'Persist'];
      if (malformed === true) {
        assert.deepEqual(retained.programs, []);
        assert.equal(warnings.length, 1);
      } else {
        assert.deepEqual(retained.programs, programs);
        programs[0].schedule[0].start = 7200;
        assert.equal(retained.programs[0].schedule[0].start, 3600);
        assert.equal(warnings.length, 0);
      }
      await service.getCharacteristic(
        family === 'Thermo' ? hap.Characteristic.EveProgramData : hap.Characteristic.EveGetConfiguration,
      ).getHandler();
    }
  }
});

test('initial Thermo and Aqua scalar and formatting failures fall back to usable defaults', async () => {
  for (let [family, key] of [['Thermo', 'tempoffset'], ['Aqua', 'flowrate']]) {
    for (let update of [{ [key]: Infinity }, ...[-1, 1.5, 1e20].map((firmware) => ({ firmware })),
      { programs: false }, { programs: [{ unsupported() {} }] }]) {
      let { history, hap } = createHistory();
      let service = family === 'Thermo' ? new hap.Service.Thermostat('Thermo', 1) : new hap.Service.Valve('Aqua', 1);
      let options = Object.fromEntries(Object.entries(update).map(([name, value]) => ['Eve' + family + '_' + name, value]));
      await history.linkToEveHome(service, options);
      assert.equal(history['Eve' + family + 'Persist'].firmware, family === 'Thermo' ? 1251 : 1208);
      assert.equal(history['Eve' + family + 'Persist'][key], family === 'Thermo' ? -2.5 : 18);
      assert.deepEqual(history['Eve' + family + 'Persist'].programs, []);
    }
  }
});

test('overlapping GET reads merge into the latest state and failures cannot restore stale state', async () => {
  for (let mode of ['together', 'reversed', 'rejected', 'invalid', 'ignored', 'samefield', 'set']) {
    let { history, hap } = createHistory();
    let service = new hap.Service.Thermostat('Thermo', 1);
    let pending;
    await history.linkToEveHome(service, { messages(type) {
      return type === HomeKitHistory.SET || pending === undefined
        ? {}
        : new Promise((resolve, reject) => pending.push({ resolve, reject }));
    } });
    pending = [];
    let get = service.getCharacteristic(hap.Characteristic.EveProgramData).getHandler;
    let first = get();
    if (mode === 'set') {
      await service.getCharacteristic(hap.Characteristic.EveProgramCommand).setHandler(Buffer.from('1301', 'hex').toString('base64'));
    } else {
      let second = get();
      pending[1].resolve(mode === 'samefield' ? { enableschedule: true, tempoffset: 2 } : { enableschedule: true });
      if (mode !== 'together') {
        await second;
      }
      if (mode === 'rejected') {
        pending[0].reject(new Error('offline'));
      } else {
        pending[0].resolve(mode === 'ignored' ? null : mode === 'invalid' ? { programs: [{}] } : { tempoffset: 1 });
      }
      await second;
    }
    if (mode === 'set') {
      pending[0].resolve({ tempoffset: 1 });
    }
    await first;
    assert.equal(history.EveThermoPersist.enableschedule, true);
    assert.equal(history.EveThermoPersist.tempoffset, ['invalid', 'rejected', 'ignored'].includes(mode) === true ? -2.5 : 1);
  }
});

test('Light Strip inherited preset names use default timings and remain writable', async () => {
  for (let source of ['options', 'GET']) {
    for (let transition of ['toString', 'constructor', '__proto__', 'missing', null, 1]) {
      let { history, hap } = createHistory();
      let service = new hap.Service.Lightbulb('Light', 1);
      let options = source === 'options' ? { EveLightStrip_transition: transition } : { messages() {
        return { transition };
      } };
      await history.linkToEveHome(service, options);
      let get = service.getCharacteristic(hap.Characteristic.EveGetConfiguration).getHandler;
      let packet = Buffer.from(await get(), 'base64').toString('hex');
      assert.match(packet, /6c0296006a0296006b029001/);
      await service.getCharacteristic(hap.Characteristic.EveSetConfiguration).setHandler(
        Buffer.from('6c0290016a0290016b022003', 'hex').toString('base64'),
      );
      assert.equal(history.EveLightStripPersist.transition, 'moderate');
    }
  }
});
