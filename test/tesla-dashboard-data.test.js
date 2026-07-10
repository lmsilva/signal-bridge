const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDashboardFromVehicleData,
  barToPsi,
  headingLabel,
  mapMediaSource,
  formatMediaVolumePercent,
  serviceDueInMiles,
  estimateTimeToFullChargeMin,
} = require('../src/tesla-dashboard-data');
const { buildTeslaDashboardPayload } = require('../src/udp-payload');

test('barToPsi converts bar to psi', () => {
  assert.equal(barToPsi(2.9), 42.1);
});

test('headingLabel maps degrees to cardinal', () => {
  assert.equal(headingLabel(315), 'NW');
});

test('buildDashboardFromVehicleData maps fleet vehicle_data', () => {
  const dashboard = buildDashboardFromVehicleData({
    display_name: "Luis's Model Y",
    state: 'online',
    charge_state: {
      battery_level: 72,
      battery_range: 231,
      rated_battery_range: 244,
      charging_state: 'Disconnected',
      charge_energy_added: 38,
      lifetime_energy_used: 4_200_000,
    },
    drive_state: {
      latitude: 40.35,
      longitude: -111.9,
      heading: 315,
      speed: 0,
      shift_state: 'P',
      active_route_destination: null,
    },
    vehicle_state: {
      locked: true,
      sentry_mode: true,
      df: 0,
      dr: 0,
      pf: 0,
      pr: 0,
      fd_window: 0,
      fp_window: 0,
      rd_window: 0,
      rp_window: 0,
      homelink_nearby: true,
      car_geodata: 'Fairview, UT',
      odometer: 18442,
      car_version: '2026.20.4',
      tpms_pressure_fl: 2.9,
      tpms_pressure_fr: 2.91,
      tpms_pressure_rl: 2.88,
      tpms_pressure_rr: 2.7,
      tpms_soft_warning_rr: 1,
      software_update: { status: 'available', version: '2026.24.1', download_perc: 100 },
      media_info: { media_play_status: 'Stopped', now_playing_source: 'Spotify', media_audio_volume: 5.5 },
    },
    climate_state: {
      inside_temp: 22,
      outside_temp: 34.4,
      is_climate_on: false,
      cabin_overheat_protection: 'On',
    },
    vehicle_config: { car_type: 'modely' },
  }, { fetchedAt: '2026-07-08T22:00:00.000Z' });

  assert.equal(dashboard.status, 'ok');
  assert.equal(dashboard.vehicle.model, 'Model Y');
  assert.equal(dashboard.battery.percent, 72);
  assert.equal(dashboard.map.locationLabel, 'Fairview, UT');
  assert.equal(dashboard.map.locatedAtHome, true);
  assert.equal(dashboard.security.locked, true);
  assert.equal(dashboard.tires.rr, 39.2);
  assert.ok(dashboard.tires.alert);
  assert.equal(dashboard.media.playing, false);
  assert.equal(dashboard.media.source, 'Spotify');
  assert.equal(dashboard.media.volumePercent, 50);
  assert.equal(dashboard.odometer.serviceDueInMiles, 6250 * 3 - 18442);
  assert.equal(dashboard.software.updateAvailable, true);
  assert.equal(dashboard.software.statusLabel, 'Update ready');
  assert.equal(dashboard.software.downloadPercent, 100);
});

test('software tile stays quiet when no update exists', () => {
  const dashboard = buildDashboardFromVehicleData({
    display_name: 'Model Y',
    state: 'online',
    vehicle_state: {
      car_version: '2026.14.6.12 abc123',
      software_update: { status: '', version: ' ', download_perc: 0, install_perc: 1 },
    },
  }, { fetchedAt: '2026-07-08T22:00:00.000Z' });

  assert.equal(dashboard.software.updateAvailable, false);
  assert.equal(dashboard.software.statusLabel, 'Up to date');
  assert.equal(dashboard.software.downloadPercent, null);
  assert.equal(dashboard.software.updateVersion, null);
});

test('formatMediaVolumePercent converts Tesla 0-11 scale to user percent', () => {
  assert.equal(formatMediaVolumePercent({ media_audio_volume: 5.5 }), 50);
  assert.equal(formatMediaVolumePercent({ media_audio_volume: 2.3333 }), 21);
  assert.equal(
    formatMediaVolumePercent({ media_audio_volume: 7, media_audio_volume_max: 10 }),
    70,
  );
  assert.equal(formatMediaVolumePercent({}), null);
});

test('mapMediaSource hides opaque numeric codes and prefers bluetooth name', () => {
  assert.equal(mapMediaSource({ now_playing_source: 'Spotify' }), 'Spotify');
  assert.equal(mapMediaSource({ now_playing_source: '5' }), null);
  assert.equal(
    mapMediaSource({ now_playing_source: '5', a2dp_source_name: 'Pixel 8 Pro' }),
    'Bluetooth · Pixel 8 Pro',
  );
  assert.equal(
    mapMediaSource({ now_playing_source: '13', now_playing_station: 'LiveOne' }),
    'LiveOne',
  );
});

test('serviceDueInMiles counts down to next tire rotation', () => {
  assert.equal(serviceDueInMiles(18442), 6250 * 3 - 18442);
  assert.equal(serviceDueInMiles(6250), 6250);
  assert.equal(serviceDueInMiles(null), null);
});

test('estimateTimeToFullChargeMin uses remaining range at current charge rate', () => {
  const charge = {
    battery_range: 140,
    charge_rate: 21.3,
    time_to_full_charge: 3.75,
  };
  const minutes = estimateTimeToFullChargeMin(charge, 50, { isCharging: true });
  // 50% → 140 mi left of ~280 mi full; 140 mi at 21.3 mi/hr ≈ 6.57 h ≈ 394 min
  assert.equal(minutes, 394);
});

test('estimateTimeToFullChargeMin converts Tesla hours when rate is unavailable', () => {
  const minutes = estimateTimeToFullChargeMin(
    { time_to_full_charge: 3.75 },
    50,
    { isCharging: true },
  );
  assert.equal(minutes, 225);
});

test('buildDashboardFromVehicleData maps charging time to full from charge rate', () => {
  const dashboard = buildDashboardFromVehicleData({
    state: 'online',
    charge_state: {
      battery_level: 50,
      battery_range: 140,
      charge_rate: 21.3,
      charger_power: 6,
      charger_voltage: 238,
      charge_current_request: 24,
      charging_state: 'Charging',
      time_to_full_charge: 3.75,
    },
    drive_state: {},
    vehicle_state: { locked: true },
    climate_state: {},
    vehicle_config: { car_type: 'modely' },
  }, { fetchedAt: '2026-07-08T22:00:00.000Z' });

  assert.equal(dashboard.battery.charging, true);
  assert.equal(dashboard.battery.timeToFullChargeMin, 394);
});

test('buildTeslaDashboardPayload includes dashboard object', () => {
  const payload = buildTeslaDashboardPayload(
    { device: 'Kitchen Echo', query: 'show tesla dashboard' },
    { udpBroadcast: { defaultDisplaySeconds: 30 } },
    { dashboard: { status: 'ok', vehicle: { name: 'Model Y' } } },
  );
  assert.equal(payload.type, 'tesla-dashboard.query');
  assert.equal(payload.version, 2);
  assert.ok(payload.displaySeconds >= 120);
  assert.equal(payload.dashboard.vehicle.name, 'Model Y');
});
