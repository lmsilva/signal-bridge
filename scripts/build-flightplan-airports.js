#!/usr/bin/env node
/**
 * One-off builder: downloads OurAirports CSV and writes src/web/flightplan/airports.json
 * Run: node scripts/build-flightplan-airports.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const OUT = path.resolve(__dirname, '..', 'src', 'web', 'flightplan', 'airports.json');

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) {
      cols.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

function main() {
  https.get(URL, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      const lines = data.split(/\r?\n/);
      const header = parseCsvLine(lines[0]);
      const idx = Object.fromEntries(header.map((h, i) => [h, i]));
      const rows = [];
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line) continue;
        const cols = parseCsvLine(line);
        const type = cols[idx.type];
        const iata = String(cols[idx.iata_code] || '').trim().toUpperCase();
        if (!iata || iata.length !== 3) continue;
        if (!['large_airport', 'medium_airport'].includes(type)) continue;
        const name = String(cols[idx.name] || '').trim();
        const city = String(cols[idx.municipality] || '').trim();
        const icao = String(cols[idx.ident] || '').trim().toUpperCase();
        const lat = Number(cols[idx.latitude_deg]);
        const lon = Number(cols[idx.longitude_deg]);
        if (!name) continue;
        rows.push({ iata, icao, name, city, lat, lon });
      }
      rows.sort((a, b) => a.iata.localeCompare(b.iata));
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(rows));
      console.log(`Wrote ${rows.length} airports to ${OUT}`);
    });
  }).on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
}

main();
