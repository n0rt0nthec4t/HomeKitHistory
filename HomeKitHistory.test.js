// HomeKitHistory public-behaviour tests.
// These mocks keep storage, HAP types, and Eve service wiring deterministic without requiring Homebridge or HAP-NodeJS.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  Service.Fan.Fanv2 = namedType(MockService, 'Fanv2', 'service-fan-v2');

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
    let writer = history.generateCSV(hap.Service.Fan, csvfile);
    await once(writer, 'finish');
    let csv = await readFile(csvfile, 'utf8');
    let rows = csv.trim().split('\n');

    assert.equal(rows[0], 'time,subtype,status,temperature,humidity');
    assert.match(rows[1], /,first,1,20,$/);
    assert.match(rows[2], /,second,0,,"40, humid"$/);
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
    ['Door', 'door'],
    ['WindowCovering', 'blind'],
    ['Thermostat', 'thermo'],
    ['EveAirPressureSensor', 'weather'],
    ['AirQualitySensor', 'room2'],
    ['TemperatureSensor', 'room'],
    ['MotionSensor', 'motion'],
    ['SmokeSensor', 'smoke'],
    ['Valve', 'aqua'],
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
        '001301f422222afc0e0912091a1a24366684fffffffffa24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff24366684ffffffff06',
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
