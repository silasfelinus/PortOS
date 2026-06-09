// Pure, deterministic helpers for CyberCity's Data Harbor: a pier district over the bay
// (master-plan parcel `dataHarbor`, north shore) that makes the install's storage legible
// at a glance. The PostgreSQL datastore becomes the **database quay** — one disk-stack silo
// per table, stack height log-scaled by row count, disk radius log-scaled by relation size,
// an orbiting ring marking pgvector (embedding) tables, and a migration obelisk at the pier
// head. The `data/` filesystem becomes the **archive racks** — one shipping-container rack
// per domain directory, lit slats log-scaled by disk usage. Data arrives from
// GET /api/city/introspection; `db: null` (unreachable) renders as a dimmed offline quay,
// distinct from a reachable-but-empty database. No three.js / React imports so the topology
// is unit-testable (mirrors cityMemoryDistrict.js / cityTaskQueue.js).

import { hashString } from './hashString';
import { formatBytes } from './formatters';
import { PARCELS } from './cityPlan';

export const DATA_HARBOR = {
  base: PARCELS.dataHarbor.anchor, // pier district over the bay (see cityPlan.js)
  deckY: 0.55, // pier deck height above the water
  maxSilos: 10, // visible table-silo cap; the rest fold into the overflow count
  maxRacks: 8, // visible domain-rack cap
  siloSpacing: 3.6, // x-distance between adjacent silos
  siloRowGap: 4.4, // z-distance between the two silo rows
  diskHeight: 0.42, // one disk in a silo stack
  diskGap: 0.14, // vertical gap between disks
  minDisks: 1,
  maxDisks: 7, // a packed table stays a legible stack, not a tower
  minDiskRadius: 0.65,
  maxDiskRadius: 1.35,
  rackSpacing: 3.1, // x-distance between adjacent racks
  rackWidth: 2.3,
  rackDepth: 1.6,
  rackHeight: 3.2,
  rackSlats: 8, // emissive slat rows per rack; lit count tracks the fill ratio
};

// Deterministic silo color per table name — the city's neon spread, hashed so a table keeps
// its color across refetches and installs.
const PALETTE = ['#06b6d4', '#ec4899', '#8b5cf6', '#22c55e', '#f59e0b', '#3b82f6', '#f43f5e', '#a855f7'];
export function tableColor(name) {
  return PALETTE[hashString(String(name || '')) % PALETTE.length];
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// log2-scale `value` into [0, 1] against `max` (both floored at 0). A zero max yields 0.
const logRatio = (value, max) => {
  const v = Math.max(0, Number.isFinite(value) ? value : 0);
  const m = Math.max(0, Number.isFinite(max) ? max : 0);
  if (m <= 0) return 0;
  return clamp(Math.log2(1 + v) / Math.log2(1 + m), 0, 1);
};

const shortCount = (n) => {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

// Silo geometry for the visible top-N tables (already size-sorted by the server; re-sorted
// here defensively). Two rows: the heavyweights up front (bay side), the rest behind.
function computeSilos(tables) {
  const sorted = [...tables].sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
  const visible = sorted.slice(0, DATA_HARBOR.maxSilos);
  const maxRows = Math.max(...visible.map((t) => t.rowEstimate ?? 0), 0);
  const maxBytes = Math.max(...visible.map((t) => t.totalBytes ?? 0), 0);
  const [bx, , bz] = DATA_HARBOR.base;
  const perRow = Math.ceil(visible.length / 2);

  return visible.map((table, i) => {
    const row = i < perRow ? 0 : 1;
    const col = row === 0 ? i : i - perRow;
    const rowCount = row === 0 ? perRow : visible.length - perRow;
    const rowWidth = (rowCount - 1) * DATA_HARBOR.siloSpacing;
    const diskCount = clamp(
      Math.round(1 + logRatio(table.rowEstimate, maxRows) * (DATA_HARBOR.maxDisks - 1)),
      DATA_HARBOR.minDisks,
      DATA_HARBOR.maxDisks,
    );
    const diskRadius = DATA_HARBOR.minDiskRadius
      + logRatio(table.totalBytes, maxBytes) * (DATA_HARBOR.maxDiskRadius - DATA_HARBOR.minDiskRadius);
    return {
      name: table.name,
      x: bx - 11 + col * DATA_HARBOR.siloSpacing - rowWidth / 2 + (row === 0 ? 0 : DATA_HARBOR.siloSpacing / 2),
      z: bz + (row === 0 ? 1.5 : 1.5 - DATA_HARBOR.siloRowGap),
      diskCount,
      diskRadius,
      height: diskCount * (DATA_HARBOR.diskHeight + DATA_HARBOR.diskGap),
      hasEmbedding: Boolean(table.hasEmbedding),
      color: tableColor(table.name),
      rowEstimate: table.rowEstimate ?? 0,
      totalBytes: table.totalBytes ?? 0,
      label: String(table.name || '').toUpperCase(),
      sublabel: `${shortCount(table.rowEstimate ?? 0)} ROWS`,
      bytesLabel: formatBytes(table.totalBytes ?? 0),
    };
  });
}

// Rack geometry for the visible top-N data/ domains (server sorts by size; defensively
// re-sorted). Two rows on the east pier — a tight container yard.
function computeRacks(domains) {
  const sorted = [...domains].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const visible = sorted.slice(0, DATA_HARBOR.maxRacks);
  const maxBytes = Math.max(...visible.map((d) => d.bytes ?? 0), 0);
  const [bx, , bz] = DATA_HARBOR.base;
  const perRow = Math.ceil(visible.length / 2);

  return visible.map((domain, i) => {
    const row = i < perRow ? 0 : 1;
    const col = row === 0 ? i : i - perRow;
    const rowCount = row === 0 ? perRow : visible.length - perRow;
    const rowWidth = (rowCount - 1) * DATA_HARBOR.rackSpacing;
    const fillRatio = logRatio(domain.bytes, maxBytes);
    return {
      name: domain.name,
      x: bx + 11 + col * DATA_HARBOR.rackSpacing - rowWidth / 2,
      z: bz + (row === 0 ? 1.5 : 1.5 - DATA_HARBOR.siloRowGap),
      width: DATA_HARBOR.rackWidth,
      depth: DATA_HARBOR.rackDepth,
      height: DATA_HARBOR.rackHeight,
      fillRatio,
      litSlats: clamp(Math.round(fillRatio * DATA_HARBOR.rackSlats), domain.bytes > 0 ? 1 : 0, DATA_HARBOR.rackSlats),
      bytes: domain.bytes ?? 0,
      files: domain.files ?? 0,
      label: String(domain.name || '').toUpperCase(),
      sublabel: formatBytes(domain.bytes ?? 0),
    };
  });
}

// The whole district model from one introspection payload.
//   - introspection missing entirely → { empty: true } (nothing renders — first load)
//   - db: null → dbDown: true (quay renders dimmed + "DB OFFLINE")
//   - fs: null → racks: [] (rack pier renders empty deck)
export function computeDataHarbor(introspection) {
  if (!introspection || typeof introspection !== 'object') return { empty: true };

  const db = introspection.db && Array.isArray(introspection.db.tables) ? introspection.db : null;
  const fsSection = introspection.fs && Array.isArray(introspection.fs.domains) ? introspection.fs : null;
  const tables = db?.tables ?? [];
  const domains = fsSection?.domains ?? [];

  return {
    empty: false,
    dbDown: !db,
    base: DATA_HARBOR.base,
    silos: computeSilos(tables),
    racks: computeRacks(domains),
    obelisk: db?.migrations
      ? { applied: db.migrations.applied ?? 0, lastApplied: db.migrations.lastApplied ?? null }
      : null,
    totals: {
      tableCount: tables.length,
      dbSizeBytes: db?.sizeBytes ?? null,
      dbSizeLabel: db?.sizeBytes != null ? formatBytes(db.sizeBytes) : null,
      fsBytes: fsSection?.totalBytes ?? null,
      fsLabel: fsSection?.totalBytes != null ? formatBytes(fsSection.totalBytes) : null,
      fsFiles: fsSection?.totalFiles ?? null,
      domainCount: domains.length,
    },
    overflow: {
      tables: Math.max(0, tables.length - DATA_HARBOR.maxSilos),
      domains: Math.max(0, domains.length - DATA_HARBOR.maxRacks),
    },
  };
}
