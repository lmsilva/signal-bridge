const { clampPercent } = require('./tesla-battery');

const MODEL_LABELS = {
  modely: 'Model Y',
  model3: 'Model 3',
  models: 'Model S',
  modelx: 'Model X',
};

function mapChargingLabel(chargingState) {
  const state = String(chargingState || '').trim();
  if (!state) {
    return null;
  }
  if (/^charging$/i.test(state)) {
    return 'Charging';
  }
  if (/complete/i.test(state)) {
    return 'Charge complete';
  }
  if (/disconnected/i.test(state)) {
    return 'Not plugged in';
  }
  return state;
}

function mapVehicleModel(vehicleData) {
  const carType = String(
    vehicleData?.vehicle_state?.car_type
    || vehicleData?.car_type
    || vehicleData?.vehicle_config?.car_type
    || '',
  ).toLowerCase();
  return MODEL_LABELS[carType] || vehicleData?.display_name || 'Tesla';
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function barToPsi(bar) {
  const numeric = Number(bar);
  if (Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric * 14.5038 * 10) / 10;
}

function celsiusToF(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }
  return Math.round(numeric * 9 / 5 + 32);
}

function headingLabel(degrees) {
  const numeric = Number(degrees);
  if (Number.isNaN(numeric)) {
    return null;
  }
  const index = Math.round(((numeric % 360) + 360) % 360 / 45) % 8;
  return CARDINALS[index];
}

function parseCarGeodata(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed?.location || parsed?.name || parsed?.address || null;
      } catch {
        return trimmed.length <= 80 ? trimmed : null;
      }
    }
    return trimmed.length <= 80 ? trimmed : null;
  }
  if (typeof value === 'object') {
    return value.location || value.name || value.address || null;
  }
  return null;
}

function doorOpen(value) {
  return value === 1 || value === true || String(value).toLowerCase() === 'open';
}

function windowOpen(value) {
  return value != null && Number(value) > 0;
}

function tireWarningLabel(soft, hard) {
  if (hard) {
    return 'hard';
  }
  if (soft) {
    return 'soft';
  }
  return null;
}

function formatMiles(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }
  return Math.round(numeric);
}

/**
 * Estimate minutes until 100% using remaining range at the current charge rate.
 * Tesla's time_to_full_charge is in hours (often to the charge limit, not 100%).
 */
function estimateTimeToFullChargeMin(charge, percent, { isCharging = false } = {}) {
  if (!isCharging || percent == null) {
    return null;
  }
  const current = Number(percent);
  const targetPercent = 100;
  if (!Number.isFinite(current) || current >= targetPercent) {
    return 0;
  }

  const chargeRateMph = Number(charge?.charge_rate);
  const rangeMiles = Number(charge?.battery_range ?? charge?.est_battery_range);
  if (Number.isFinite(chargeRateMph) && chargeRateMph > 0
    && Number.isFinite(rangeMiles) && rangeMiles > 0 && current > 0) {
    const fullRangeMiles = rangeMiles / (current / 100);
    const milesRemaining = fullRangeMiles * ((targetPercent - current) / 100);
    const hours = milesRemaining / chargeRateMph;
    if (Number.isFinite(hours) && hours > 0) {
      return Math.max(1, Math.round(hours * 60));
    }
  }

  const apiMinutes = Number(charge?.minutes_to_full_charge);
  if (Number.isFinite(apiMinutes) && apiMinutes > 0) {
    return Math.round(apiMinutes);
  }

  const apiHours = Number(charge?.time_to_full_charge);
  if (Number.isFinite(apiHours) && apiHours > 0) {
    return Math.round(apiHours * 60);
  }

  return null;
}

function formatEnergyKwh(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return null;
  }
  if (numeric >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(1)} MWh`;
  }
  if (numeric >= 1000) {
    return `${Math.round(numeric)} kWh`;
  }
  return `${Math.round(numeric * 10) / 10} kWh`;
}

function isOpaqueNumeric(value) {
  return /^\d+(\.\d+)?$/.test(String(value ?? '').trim());
}

// Tesla usually reports a friendly source name ("Spotify", "Audible", "LiveOne");
// some firmware returns an opaque numeric code instead — never show that to the user.
function mapMediaSource(media = {}) {
  const source = String(media.now_playing_source ?? media.media_audio_source ?? '').trim();
  if (source && !isOpaqueNumeric(source)) {
    return source;
  }
  const bluetoothDevice = String(media.a2dp_source_name || '').trim();
  if (bluetoothDevice) {
    return `Bluetooth · ${bluetoothDevice}`;
  }
  const station = String(media.now_playing_station || '').trim();
  if (station && !isOpaqueNumeric(station)) {
    return station;
  }
  return null;
}

const TESLA_MEDIA_VOLUME_MAX = 11;

/** Tesla cabin volume is 0–11 (or vehicle max); return 0–100 for display. */
function formatMediaVolumePercent(media = {}) {
  const raw = media.audio_volume ?? media.media_audio_volume;
  const vol = Number(raw);
  if (!Number.isFinite(vol) || vol < 0) {
    return null;
  }
  const maxRaw = media.audio_volume_max ?? media.media_audio_volume_max;
  const max = Number(maxRaw);
  const ceiling = Number.isFinite(max) && max > 0 ? max : TESLA_MEDIA_VOLUME_MAX;
  return Math.max(0, Math.min(100, Math.round((vol / ceiling) * 100)));
}

const TIRE_ROTATION_INTERVAL_MILES = 6250;

function serviceDueInMiles(odometerMiles) {
  const numeric = Number(odometerMiles);
  if (Number.isNaN(numeric) || numeric <= 0) {
    return null;
  }
  const next = Math.ceil(numeric / TIRE_ROTATION_INTERVAL_MILES) * TIRE_ROTATION_INTERVAL_MILES;
  const remaining = Math.round(next - numeric);
  return remaining === 0 ? TIRE_ROTATION_INTERVAL_MILES : remaining;
}

function buildSecurityState(vehicle = {}, charge = {}) {
  const doorsOpen = ['df', 'dr', 'pf', 'pr'].some((key) => doorOpen(vehicle[key]));
  const windowsOpen = ['fd_window', 'fp_window', 'rd_window', 'rp_window']
    .some((key) => windowOpen(vehicle[key]));
  const chargePortOpen = doorOpen(charge.charge_port_door_open);
  const locked = vehicle.locked === true;
  const sentryOn = vehicle.sentry_mode === true;

  let secureTheme = 'green';
  if (doorsOpen || windowsOpen || chargePortOpen || !locked) {
    secureTheme = 'amber';
  }

  return {
    locked,
    sentryOn,
    doorsClosed: !doorsOpen,
    windowsUp: !windowsOpen,
    chargePortOpen,
    secureTheme,
  };
}

function buildDrivingChip(drive = {}) {
  const shift = String(drive.shift_state || 'P').toUpperCase();
  const speed = Math.round(Number(drive.speed) || 0);
  const heading = headingLabel(drive.heading);
  const moving = shift === 'D' || shift === 'R' || speed > 0;

  if (moving) {
    const parts = [];
    if (heading) {
      parts.push(`Heading ${heading}`);
    }
    parts.push(`${speed} mph`);
    parts.push(shift === 'D' ? 'Drive' : shift);
    return parts.join(' · ');
  }

  return `${speed} mph · ${shift === 'P' ? 'Park' : shift}`;
}

function buildNavigationState(drive = {}) {
  const destination = drive.active_route_destination || drive.active_route_name || null;
  const minutes = Number(drive.active_route_minutes_to_arrival);
  const energy = Number(drive.active_route_energy_at_arrival);
  const active = Boolean(destination) && (!Number.isNaN(minutes) ? minutes >= 0 : true);

  if (!active) {
    return {
      active: false,
      destination: null,
      etaMinutes: null,
      energyAtArrivalPercent: null,
      footer: 'No active route',
    };
  }

  const etaPart = !Number.isNaN(minutes) && minutes >= 0
    ? `${destination} in ${minutes} min`
    : String(destination);
  const energyPart = !Number.isNaN(energy) && energy >= 0
    ? `arriving at ${Math.round(energy)}%`
    : null;

  return {
    active: true,
    destination,
    etaMinutes: Number.isNaN(minutes) ? null : minutes,
    energyAtArrivalPercent: Number.isNaN(energy) ? null : Math.round(energy),
    footer: energyPart ? `${etaPart} · ${energyPart}` : etaPart,
  };
}

function buildDashboardFromVehicleData(vehicleData, { fetchedAt, error = null, status = 'ok', locationRestricted = false } = {}) {
  if (error || status !== 'ok') {
    return {
      status: status || 'error',
      error: error || 'Dashboard unavailable',
      fetchedAt: fetchedAt || new Date().toISOString(),
      freshnessSec: 0,
    };
  }

  const charge = vehicleData?.charge_state || {};
  const drive = vehicleData?.drive_state || {};
  const vehicle = vehicleData?.vehicle_state || {};
  const climate = vehicleData?.climate_state || {};
  const config = vehicleData?.vehicle_config || {};
  const media = vehicle.media_info || vehicle.media_state || vehicleData?.media_info || {};

  const fetchedIso = fetchedAt || new Date().toISOString();
  const freshnessSec = Math.max(0, Math.round((Date.now() - Date.parse(fetchedIso)) / 1000));
  const percent = charge.battery_level ?? charge.usable_battery_level;
  const chargingState = charge.detailed_charge_state || charge.charging_state;
  const isCharging = /charging/i.test(String(chargingState || ''))
    && !/complete|stopped/i.test(String(chargingState || ''));

  const tires = {
    fl: barToPsi(vehicle.tpms_pressure_fl),
    fr: barToPsi(vehicle.tpms_pressure_fr),
    rl: barToPsi(vehicle.tpms_pressure_rl),
    rr: barToPsi(vehicle.tpms_pressure_rr),
    warnings: {
      fl: tireWarningLabel(vehicle.tpms_soft_warning_fl, vehicle.tpms_hard_warning_fl),
      fr: tireWarningLabel(vehicle.tpms_soft_warning_fr, vehicle.tpms_hard_warning_fr),
      rl: tireWarningLabel(vehicle.tpms_soft_warning_rl, vehicle.tpms_hard_warning_rl),
      rr: tireWarningLabel(vehicle.tpms_soft_warning_rr, vehicle.tpms_hard_warning_rr),
    },
  };

  const softTire = Object.entries(tires.warnings).find(([, level]) => level === 'soft');
  const hardTire = Object.entries(tires.warnings).find(([, level]) => level === 'hard');
  const tireNames = { fl: 'Front left', fr: 'Front right', rl: 'Rear left', rr: 'Rear right' };
  const tireAlert = hardTire
    ? `${tireNames[hardTire[0]] || hardTire[0]} low`
    : softTire
      ? `${tireNames[softTire[0]] || softTire[0]} soft warning`
      : null;

  const software = vehicle.software_update || {};
  const updateStatus = String(software.status || software.state || '').trim();
  // Tesla reports status "" with download_perc 0 when no update exists.
  const hasUpdate = Boolean(updateStatus);
  const downloadPercent = Number(software.download_perc ?? software.install_perc);
  const updateReady = /available|ready|downloaded/i.test(updateStatus)
    || (hasUpdate && !Number.isNaN(downloadPercent) && downloadPercent >= 100);

  const mediaPlaying = /playing/i.test(String(media.media_play_status || media.status || ''));
  const ownerName = config.display_name || vehicleData?.display_name || null;
  const vehicleName = ownerName || mapVehicleModel(vehicleData);

  return {
    status: 'ok',
    fetchedAt: fetchedIso,
    freshnessSec,
    vehicle: {
      name: vehicleName,
      model: mapVehicleModel(vehicleData),
      online: !['offline', 'asleep'].includes(String(vehicleData?.state || '').toLowerCase()),
      state: vehicleData?.state || 'online',
      firmware: vehicle.car_version || software.version || null,
    },
    map: {
      latitude: drive.latitude ?? drive.native_latitude ?? null,
      longitude: drive.longitude ?? drive.native_longitude ?? null,
      heading: drive.heading ?? null,
      headingLabel: headingLabel(drive.heading),
      // Null lets the display client fall back to raw coordinates on the map card.
      locationLabel: locationRestricted
        ? 'Location hidden — re-run tesla-auth for map'
        : (parseCarGeodata(vehicle.car_geodata) || parseCarGeodata(drive.native_location) || null),
      locationRestricted,
      locatedAtHome: vehicle.homelink_nearby === true || vehicle.LocatedAtHome === true,
      locatedAtWork: vehicle.LocatedAtWork === true,
      locatedAtFavorite: vehicle.LocatedAtFavorite === true,
      drivingChip: buildDrivingChip(drive),
      navigation: buildNavigationState(drive),
    },
    security: buildSecurityState(vehicle, charge),
    battery: {
      percent: percent == null ? null : clampPercent(percent),
      rangeMiles: formatMiles(charge.battery_range ?? charge.est_battery_range),
      ratedRangeMiles: formatMiles(charge.rated_battery_range),
      charging: isCharging,
      chargingLabel: mapChargingLabel(chargingState),
      chargerPowerKw: charge.charger_power ?? null,
      chargeRateMph: charge.charge_rate ?? null,
      chargeCurrentAmp: charge.charge_current_request ?? charge.charger_actual_current ?? null,
      chargerVoltage: charge.charger_voltage ?? null,
      timeToFullChargeMin: estimateTimeToFullChargeMin(charge, percent, { isCharging }),
      lastChargeKwh: charge.charge_energy_added ?? null,
      lifetimeEnergy: formatEnergyKwh(charge.lifetime_energy_used),
    },
    climate: {
      insideTempF: celsiusToF(climate.inside_temp),
      outsideTempF: celsiusToF(climate.outside_temp),
      hvacOn: climate.is_climate_on === true || climate.hvac_power === 'on',
      cabinOverheatProtection: climate.cabin_overheat_protection || climate.climate_keeper_mode || null,
    },
    tires: {
      ...tires,
      alert: tireAlert,
    },
    odometer: {
      miles: formatMiles(vehicle.odometer),
      fsdMilesPercent: vehicle.autopilot_distance_pct ?? vehicle.percentage_of_miles_on_autopilot ?? null,
      // Miles of rated range added during the most recent charge — closest thing
      // vehicle_data exposes to a recent-trip figure.
      lastChargeAddedMiles: formatMiles(charge.charge_miles_added_rated),
      serviceDueInMiles: serviceDueInMiles(vehicle.odometer),
      serviceIntervalMiles: TIRE_ROTATION_INTERVAL_MILES,
    },
    software: {
      currentVersion: vehicle.car_version || null,
      updateAvailable: hasUpdate,
      updateVersion: hasUpdate ? (String(software.version || '').trim() || null) : null,
      downloadPercent: hasUpdate && !Number.isNaN(downloadPercent) ? Math.round(downloadPercent) : null,
      statusLabel: !hasUpdate ? 'Up to date' : (updateReady ? 'Update ready' : updateStatus),
    },
    media: {
      playing: mediaPlaying,
      title: media.now_playing_title || media.now_playing_line_one || null,
      artist: media.now_playing_artist || media.now_playing_line_two || null,
      source: mapMediaSource(media),
      volumePercent: formatMediaVolumePercent(media),
    },
  };
}

function buildDashboardErrorReading(error, { limitResetAt } = {}) {
  const status = error?.status;
  let code = 'error';
  let message = error?.message || 'Could not reach Tesla';

  if (status === 429 || error?.code === 'rate_limited') {
    code = 'rate_limited';
    message = 'Tesla rate limit reached';
  } else   if (status === 401 || /login_required|invalid_grant|tesla-auth/i.test(message)) {
    code = 'auth_required';
    message = 'Tesla login required — run npm run tesla-auth';
  } else if (/vehicle_location|missing scopes.*location/i.test(message)) {
    code = 'location_scope_required';
    message = 'Map location requires vehicle_location scope — re-run tesla-auth-pc.bat';
  } else if (status === 408 || /asleep|offline|unavailable/i.test(message)) {
    code = 'vehicle_offline';
    message = 'Vehicle unavailable';
  }

  return {
    status: code,
    error: message,
    limitResetAt: limitResetAt || error?.limitResetAt || null,
    fetchedAt: new Date().toISOString(),
    freshnessSec: 0,
  };
}

module.exports = {
  buildDashboardFromVehicleData,
  buildDashboardErrorReading,
  barToPsi,
  celsiusToF,
  headingLabel,
  mapMediaSource,
  formatMediaVolumePercent,
  serviceDueInMiles,
  estimateTimeToFullChargeMin,
};
