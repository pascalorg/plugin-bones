/**
 * LOD 400 plan-set export — pure functions: (Member[], Fixture[]) → SVG
 * construction sheets + a printable HTML document.
 *
 * These are DRAWINGS, not a BIM interchange format: one plan sheet per
 * system present (foundation / floor / wall / roof framing, electrical
 * rough-in, MEP) plus a schedules sheet (takeoff + flags). Each sheet is a
 * landscape-letter SVG with a title block and scale bar; the HTML wrapper
 * paginates them for the browser's Print → Save as PDF, which keeps the
 * plugin dependency-free while producing a real, shareable plan set.
 */

import type { Fixture, Member } from '../core/types'
import { computeTakeoff } from '../engines/takeoff'
import { PLUMBING_COLORS, circuitColor, circuitZoneHint, plumbingPipeColor } from './circuit-colors'

export type PlanSheet = { title: string; svg: string }

export type PlanSetOptions = {
  projectName?: string
  levelName?: string
  jurisdiction?: string
  /** Engine warnings — printed verbatim in the schedules flag block. */
  warnings?: string[]
  /** Resolved code name, e.g. "2023 FBC — Residential (2021 IRC base)". */
  codeName?: string
  /** Preformatted date string for the title block. */
  date?: string
  /** Stud spacing (inches o.c.) for the framing-sheet callout. */
  studSpacingIn?: number
  /** Storey elevations by level id — members tagged levelId (cross-level
   * roofs) are level-local; elevations/sections/cover lift them by this. */
  levelBaseY?: Record<string, number>
}

// Sheet canvas (landscape letter at 96dpi: 11in × 8.5in).
const W = 1056
const H = 816
const MARGIN = 48
const TITLE_H = 76

/** Systems that get a dedicated plan sheet, with drawing styles. */
const PLAN_SHEETS: {
  key: string
  title: string
  systems: Member['system'][]
  fill: Record<string, string>
}[] = [
  {
    key: 'foundation',
    title: 'Foundation plan',
    systems: ['foundation'],
    fill: { footing: '#c9cdd2', stemwall: '#aab0b7', mudsill: '#d9c39a', default: '#e3e6e9' },
  },
  {
    key: 'floor',
    title: 'Floor framing plan',
    systems: ['floor-framing'],
    fill: { girder: '#b98d4f', 'rim-joist': '#caa36a', joist: '#d9c39a', default: '#e8d9b8' },
  },
  {
    key: 'wall',
    title: 'Wall framing plan',
    systems: ['wall-framing'],
    fill: { header: '#b98d4f', 'king-stud': '#caa36a', default: '#d9c39a' },
  },
  {
    key: 'roof',
    title: 'Roof framing plan',
    systems: ['roof-framing'],
    fill: { ridge: '#b98d4f', hip: '#caa36a', valley: '#caa36a', default: '#d9c39a' },
  },
  {
    key: 'electrical',
    title: 'Electrical rough-in plan',
    systems: ['electrical'],
    fill: { 'wire-run': '#d7a43c', default: '#d7a43c' },
  },
  {
    key: 'mep',
    title: 'Plumbing + HVAC plan',
    systems: ['plumbing', 'hvac'],
    fill: {
      'duct-run': '#9aa7b0',
      'vent-stack': '#6e8fa0',
      'pipe-run': '#8fb0c4',
      'water-heater': '#b5aa97',
      default: '#8fb0c4',
    },
  },
]

/** Systems whose sheets draw the wall footprint as faint context. */
const CONTEXT_SHEETS = new Set(['electrical', 'mep'])

/** Device tags for the electrical sheet's symbols. */
const FIXTURE_TAG: Record<string, string> = {
  receptacle: 'R',
  'receptacle-gfci': 'G',
  switch: 'S',
  light: 'L',
  'smoke-alarm': 'SD',
  panel: 'P',
  'exhaust-fan': 'EF',
  thermostat: 'T',
  register: 'SR',
  return: 'RA',
  'stub-out': 'SO',
  'vent-stack': 'VS',
  'water-heater': 'WH',
  'water-meter': 'M',
  equipment: 'AH',
  cleanout: 'CO',
}

const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const deg = (rad: number): number => (rad * 180) / Math.PI

/** Drop exactly-coincident duplicates (same role, position, dims) —
 * double-plotted bolts/CMU courses read as smudges (blueprint round-1). */
function dedupeShapes(members: Member[]): Member[] {
  const seen = new Set<string>()
  const out: Member[] = []
  for (const m of members) {
    const key = `${m.role}|${m.position.map((v) => v.toFixed(3)).join(',')}|${m.dims.map((v) => v.toFixed(3)).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }

function planBounds(members: Member[], fixtures: Fixture[]): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const eat = (x: number, z: number, r: number) => {
    minX = Math.min(minX, x - r)
    maxX = Math.max(maxX, x + r)
    minZ = Math.min(minZ, z - r)
    maxZ = Math.max(maxZ, z + r)
  }
  for (const m of members) {
    // Rotation-aware per-axis extents — a single max-dim radius inflated
    // the frame ~40% on elongated plans (quality C1).
    const yaw = m.rotation[1]
    const ex = (Math.abs(Math.cos(yaw)) * m.dims[0] + Math.abs(Math.sin(yaw)) * m.dims[2]) / 2
    const ez = (Math.abs(Math.sin(yaw)) * m.dims[0] + Math.abs(Math.cos(yaw)) * m.dims[2]) / 2
    minX = Math.min(minX, m.position[0] - ex)
    maxX = Math.max(maxX, m.position[0] + ex)
    minZ = Math.min(minZ, m.position[2] - ez)
    maxZ = Math.max(maxZ, m.position[2] + ez)
  }
  for (const f of fixtures) eat(f.position[0], f.position[2], 0.2)
  if (!Number.isFinite(minX)) return null
  return { minX, maxX, minZ, maxZ }
}

/** Title block + border + scale bar, shared by every sheet. */
/** Clip one text line to the title block width (~70 chars at 10px). */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

function chrome(
  title: string,
  opts: PlanSetOptions,
  scale: number,
  extra = '',
  { scaleBar = true, ratio, northArrow }: { scaleBar?: boolean; ratio?: number; northArrow?: boolean } = {},
): string {
  const meterPx = scale
  const meters = Math.max(1, Math.round(180 / Math.max(1e-6, meterPx)))
  const barPx = meters * meterPx
  const by = H - TITLE_H - 18
  // Two wrapped code lines instead of one overflowing one (quality C1:
  // the effective date clipped off the sheet edge on every sheet).
  const code = opts.codeName ?? ''
  // wrap at a word boundary (round-3: '8th Editi / on' split mid-word)
  let head = code
  let rest = ''
  if (code.length > 46) {
    const cut = code.lastIndexOf(' ', 46)
    const at = cut > 20 ? cut : 46
    head = code.slice(0, at)
    rest = code.slice(at).trim()
  }
  const line1 = clip(`Jurisdiction: ${opts.jurisdiction ?? 'AUTO'}${head ? ` — ${head}` : ''}`, 66)
  const line1b = rest ? clip(rest, 66) : ''
  const line2 = clip(
    `LOD 400 · Bones${ratio ? ` · scale 1:${ratio}` : ''}${opts.date ? ` · ${opts.date}` : ''} · __SHEET_NO__`,
    72,
  )
  const bar = scaleBar
    ? `<g stroke="#222" stroke-width="2">
      <line x1="${MARGIN}" y1="${by}" x2="${MARGIN + barPx}" y2="${by}"/>
      <line x1="${MARGIN}" y1="${by - 5}" x2="${MARGIN}" y2="${by + 5}"/>
      <line x1="${MARGIN + barPx}" y1="${by - 5}" x2="${MARGIN + barPx}" y2="${by + 5}"/>
    </g>
    <text x="${MARGIN + barPx + 8}" y="${by + 4}" font-size="11" fill="#333">${meters} m${ratio ? ` (1:${ratio})` : ''}</text>
    ${
      (northArrow ?? true)
        ? `<g transform="translate(${W - 40} ${MARGIN + 8})" stroke="#222" fill="none">
      <circle r="11"/>
      <path d="M0 8 L0 -8 M0 -8 L-3.5 -1 M0 -8 L3.5 -1" stroke-width="1.6"/>
      <text y="-14" font-size="9" text-anchor="middle" fill="#222" stroke="none">N</text>
    </g>`
        : ''
    }`
    : ''
  return `
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="#222" stroke-width="2"/>
  <g font-family="Helvetica, Arial, sans-serif">
    <rect x="${W - 380}" y="${H - TITLE_H - 8}" width="${372}" height="${TITLE_H}" fill="#fff" stroke="#222"/>
    <text x="${W - 368}" y="${H - TITLE_H + 12}" font-size="14" font-weight="bold" fill="#111">${esc(clip(title, 44))}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 27}" font-size="10" fill="#333">${esc(clip(`${opts.projectName ?? 'Project'} — ${opts.levelName ?? 'Level'}`, 66))}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 38}" font-size="8.5" fill="#555">${esc(line1)}</text>
    ${line1b ? `<text x="${W - 368}" y="${H - TITLE_H + 48}" font-size="8.5" fill="#555">${esc(line1b)}</text>` : ''}
    <text x="${W - 368}" y="${H - TITLE_H + 58}" font-size="8.5" fill="#555">${esc(line2)}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 66}" font-size="8" fill="#777">Drafting aid, not engineering — verify with your local building department.</text>
    ${bar}
    ${extra}
  </g>`
}

/**
 * ONE transform for the whole set (blueprint round-1 P2: five different
 * scales/origins made cross-sheet overlay impossible). Union bbox of every
 * system, scale snapped DOWN to a standard architectural ratio so the bar
 * reads 1:50 / 1:75 / 1:100…, gutter reserved on every sheet uniformly.
 */
type SetTransform = { scale: number; ratio: number; X: (x: number) => number; Z: (z: number) => number; gutter: number }

/** 96dpi: px per meter at ratio 1:n = 96/0.0254/n. */
const RATIOS = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500]

function setTransform(members: Member[], fixtures: Fixture[]): SetTransform | null {
  const b = planBounds(members, fixtures)
  if (!b) return null
  const gutter = 258 // uniform legend/notes strip, every sheet
  const drawW = W - 2 * MARGIN - gutter
  const drawH = H - 2 * MARGIN - TITLE_H
  const spanX = Math.max(0.5, b.maxX - b.minX)
  const spanZ = Math.max(0.5, b.maxZ - b.minZ)
  const fit = Math.min(drawW / spanX, drawH / spanZ)
  const pxPerM = 96 / 0.0254
  const ratio = RATIOS.find((r) => pxPerM / r <= fit) ?? 500
  const scale = pxPerM / ratio
  const ox = MARGIN + gutter + (drawW - spanX * scale) / 2 - b.minX * scale
  const oz = MARGIN + (drawH - spanZ * scale) / 2 - b.minZ * scale
  return { scale, ratio, X: (x) => ox + x * scale, Z: (z) => oz + z * scale, gutter }
}

/** One top-view plan sheet for the given systems. */
function planSheet(
  def: (typeof PLAN_SHEETS)[number],
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
  t: SetTransform,
): PlanSheet | null {
  const mine = dedupeShapes(members.filter((m) => def.systems.includes(m.system)))
  const devs = fixtures.filter((f) => def.systems.includes(f.system))
  if (mine.length === 0 && devs.length === 0) return null
  // Wall footprint context: runs floating on white are unreadable — draw
  // the bottom plates as light gray underlay on every non-wall sheet.
  const context =
    def.key === 'wall'
      ? []
      : members.filter((m) => m.system === 'wall-framing' && m.role === 'bottom-plate')
  const { scale, X, Z } = t

  const shapes: string[] = []
  // Foundation runs draw as MITERED PATHS, not independent rectangles:
  // per-member boxes read as crossed bow-ties at oblique corners (user
  // report — fine at 90°, wrong at angles). Chained centerlines with
  // stroke miter joins give the drafting-correct corner at any angle.
  const STROKE_ROLES = new Set(['footing', 'stemwall', 'bond-beam'])
  const stroked = new Set<Member>()
  if (def.key === 'foundation') {
    type Seg = { a: [number, number]; b: [number, number]; w: number; m: Member }
    const byRole = new Map<string, Seg[]>()
    for (const m of mine) {
      if (!STROKE_ROLES.has(m.role)) continue
      const yaw = m.rotation[1]
      const dx = (Math.cos(yaw) * m.dims[0]) / 2
      const dz = (-Math.sin(yaw) * m.dims[0]) / 2
      const seg: Seg = {
        a: [m.position[0] - dx, m.position[2] - dz],
        b: [m.position[0] + dx, m.position[2] + dz],
        w: m.dims[2],
        m,
      }
      stroked.add(m)
      byRole.set(m.role, [...(byRole.get(m.role) ?? []), seg])
    }
    const lineHit = (
      p: Seg,
      q: Seg,
    ): [number, number] | null => {
      // intersection of the two centerlines — the true corner vertex
      const d1: [number, number] = [p.b[0] - p.a[0], p.b[1] - p.a[1]]
      const d2: [number, number] = [q.b[0] - q.a[0], q.b[1] - q.a[1]]
      const den = d1[0] * d2[1] - d1[1] * d2[0]
      if (Math.abs(den) < 1e-9) return null
      const t = ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / den
      return [p.a[0] + d1[0] * t, p.a[1] + d1[1] * t]
    }
    for (const [role, segs] of byRole) {
      const width = Math.max(...segs.map((sg) => sg.w))
      const tol = width * 2.5
      const used = new Set<Seg>()
      const fill = def.fill[role] ?? def.fill.default ?? '#c9cdd2'
      for (const seed of segs) {
        if (used.has(seed)) continue
        used.add(seed)
        // grow a chain both directions
        const chain: [number, number][] = [seed.a, seed.b]
        let extended = true
        while (extended) {
          extended = false
          for (const cand of segs) {
            if (used.has(cand)) continue
            for (const [candEnd, candFar] of [
              [cand.a, cand.b],
              [cand.b, cand.a],
            ] as const) {
              const head = chain[0] as [number, number]
              const tail = chain[chain.length - 1] as [number, number]
              if (Math.hypot(candEnd[0] - tail[0], candEnd[1] - tail[1]) < tol) {
                const hit = lineHit(
                  { a: chain[chain.length - 2] as [number, number], b: tail, w: 0, m: seed.m },
                  cand,
                )
                if (hit) chain[chain.length - 1] = hit
                chain.push(candFar as [number, number])
                used.add(cand)
                extended = true
                break
              }
              if (Math.hypot(candEnd[0] - head[0], candEnd[1] - head[1]) < tol) {
                const hit = lineHit(
                  { a: chain[1] as [number, number], b: head, w: 0, m: seed.m },
                  cand,
                )
                if (hit) chain[0] = hit
                chain.unshift(candFar as [number, number])
                used.add(cand)
                extended = true
                break
              }
            }
            if (extended) break
          }
        }
        // closed loop? join the ends at their intersection too
        const head = chain[0] as [number, number]
        const tail = chain[chain.length - 1] as [number, number]
        let closed = false
        if (chain.length > 3 && Math.hypot(head[0] - tail[0], head[1] - tail[1]) < tol) {
          const hit = lineHit(
            { a: chain[1] as [number, number], b: head, w: 0, m: seed.m },
            { a: chain[chain.length - 2] as [number, number], b: tail, w: 0, m: seed.m },
          )
          if (hit) {
            chain[0] = hit
            chain[chain.length - 1] = hit
          }
          closed = true
        }
        const d = chain
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${X(pt[0]).toFixed(1)} ${Z(pt[1]).toFixed(1)}`)
          .join('')
        shapes.push(
          `<path d="${d}${closed ? 'Z' : ''}" fill="none" stroke="${fill}" stroke-width="${(width * scale).toFixed(1)}" stroke-linejoin="miter" stroke-miterlimit="8" stroke-linecap="butt"/>`,
        )
      }
    }
  }
  for (const m of context) {
    const yaw = m.rotation[1]
    const w = m.dims[0] * scale
    const h = Math.max(1, m.dims[2] * scale)
    shapes.push(
      `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#e4e7ea" stroke="#c9ced4" stroke-width="0.4" transform="translate(${X(m.position[0]).toFixed(1)} ${Z(m.position[2]).toFixed(1)}) rotate(${(-deg(yaw)).toFixed(2)})"/>`,
    )
  }
  // Long members first so short hardware reads on top.
  const sorted = [...mine].sort((a, b2) => b2.dims[0] - a.dims[0])
  for (const m of sorted) {
    if (stroked.has(m)) continue
    // Plan projection from the FULL euler (XYZ: M = Rx·Ry·Rz applied Rz
    // first): rolled members (outlookers) ignore neither rx nor the yaw —
    // round-14 caught 5.8° drift on yawed roofs from the yaw-only path.
    const [rx, ry, rz] = m.rotation
    const cy = Math.cos(ry)
    const sy = Math.sin(ry)
    const cz = Math.cos(rz)
    const sz = Math.sin(rz)
    // axis = R·(1,0,0): x' = cy·cz, y' = cx·sz + sx·sy·cz…, z' only needs
    // the plan pair — for XYZ order: x' = cy·cz, z' = sx·sz − cx·sy·cz
    const cx = Math.cos(rx)
    const sxr = Math.sin(rx)
    const ax = cy * cz
    const az = sxr * sz - cx * sy * cz
    const planFrac = Math.hypot(ax, az)
    const yaw = Math.atan2(-az, ax)
    const planLen = Math.max(0.02, m.dims[0] * planFrac)
    const w = planLen * scale
    const h = Math.max(1.2, m.dims[2] * scale)
    // Per-member colors: wires by circuit; plumbing runs by system —
    // cold blue / hot red / DWV slate via the sourceId prefix (identical
    // to the 3D X-ray, invariant E3's spirit).
    const fill =
      m.system === 'electrical' && m.role === 'wire-run'
        ? circuitColor(m.sourceId)
        : (m.system === 'plumbing' && m.role === 'pipe-run'
            ? plumbingPipeColor(m.sourceId)
            : null) ?? (def.fill[m.role] ?? def.fill.default ?? '#ddd')
    shapes.push(
      `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="#444" stroke-width="0.6" transform="translate(${X(m.position[0]).toFixed(1)} ${Z(m.position[2]).toFixed(1)}) rotate(${(-deg(yaw)).toFixed(2)})"/>`,
    )
  }
  // Circuit-ID text on each circuit's longest horizontal run — the examiner
  // couldn't trace a colored line back to its legend row without following
  // it to the panel (blueprint P4).
  if (def.key === 'electrical') {
    const longest = new Map<string, Member>()
    for (const m of mine) {
      if (m.role !== 'wire-run') continue
      const prev = longest.get(m.sourceId)
      if (!prev || m.length > prev.length) longest.set(m.sourceId, m)
    }
    for (const [circuit, m] of longest) {
      if (m.length * scale < 40) continue // too short to label legibly
      shapes.push(
        `<text x="${X(m.position[0]).toFixed(1)}" y="${(Z(m.position[2]) - 3).toFixed(1)}" font-size="8" font-weight="bold" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="${circuitColor(circuit)}" stroke="#fff" stroke-width="2" paint-order="stroke">${esc(circuit)}</text>`,
      )
    }
  }

  // Device tags: dedupe identical (kind, position) fixtures and nudge
  // colliding bubbles apart in a small spiral (quality A6/C3: six tags
  // overprinted into a blob; the panel symbol printed twice).
  const placed: { x: number; y: number }[] = []
  const seenDev = new Set<string>()
  for (const f of devs) {
    const key = `${f.kind}|${f.position[0].toFixed(2)}|${f.position[2].toFixed(2)}`
    if (seenDev.has(key)) continue
    seenDev.add(key)
    const tag = FIXTURE_TAG[f.kind] ?? '·'
    let px = X(f.position[0])
    let py = Z(f.position[2])
    for (let attempt = 0; attempt < 8; attempt++) {
      const clash = placed.some((q) => Math.hypot(q.x - px, q.y - py) < 15)
      if (!clash) break
      const ang = (attempt * Math.PI) / 3
      px = X(f.position[0]) + 16 * Math.cos(ang)
      py = Z(f.position[2]) + 16 * Math.sin(ang)
    }
    placed.push({ x: px, y: py })
    shapes.push(
      `<g transform="translate(${px.toFixed(1)} ${py.toFixed(1)})"><circle r="7" fill="#fff" stroke="#a05c10" stroke-width="1.2"/><text y="3.5" font-size="8" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#a05c10">${esc(tag)}</text></g>`,
    )
  }

  // Callouts: most common size per role, top-left legend — and on the
  // electrical sheet, the CIRCUIT legend (color swatch, id, breaker/gauge,
  // zone) so wires on paper match the 3D X-ray colors.
  // Most-common size per role — 'first seen' printed 2x4 for everything
  // on a 2x6-dominant house (quality C4).
  const roleSizeCounts = new Map<string, Map<string, number>>()
  for (const m of mine) {
    if (!m.size) continue
    const counts = roleSizeCounts.get(m.role) ?? new Map<string, number>()
    counts.set(m.size, (counts.get(m.size) ?? 0) + 1)
    roleSizeCounts.set(m.role, counts)
  }
  const roleSizes = new Map<string, string>()
  for (const [role, counts] of roleSizeCounts) {
    roleSizes.set(role, [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '')
  }
  const legendLines: string[] = [...roleSizes.entries()]
    .slice(0, 8)
    .map(
      ([role, size], i) =>
        `<text x="${MARGIN + 4}" y="${MARGIN + 14 + i * 14}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(role)} — ${esc(size)}</text>`,
    )
  if (def.key === 'mep') {
    // Supply/DWV split by sourceId prefix (placed-fixture engine); the
    // legacy room-category fallback keeps its single pipe tint.
    const pipes = mine.filter((m) => m.system === 'plumbing' && m.role === 'pipe-run')
    const entries: [string, string][] = []
    if (pipes.some((m) => m.sourceId.startsWith('cold-'))) {
      entries.push(['supply — cold water', PLUMBING_COLORS.cold])
    }
    if (pipes.some((m) => m.sourceId.startsWith('hot-'))) {
      entries.push(['supply — hot water', PLUMBING_COLORS.hot])
    }
    if (pipes.some((m) => m.sourceId.startsWith('dwv-'))) {
      entries.push(['DWV drain / vent', PLUMBING_COLORS.dwv])
    }
    if (pipes.some((m) => plumbingPipeColor(m.sourceId) === null)) {
      entries.push(['supply / DWV pipe', def.fill['pipe-run'] ?? '#8fb0c4'])
    }
    const NAMES: Record<string, string> = {
      'vent-stack': 'vent stack',
      'duct-run': 'duct',
      'water-heater': 'water heater',
    }
    for (const role of Object.keys(NAMES)) {
      if (mine.some((m) => m.role === role)) {
        entries.push([NAMES[role] as string, def.fill[role] ?? def.fill.default ?? '#8fb0c4'])
      }
    }
    let row = legendLines.length
    for (const [name, color] of entries) {
      const y = MARGIN + 14 + row * 14
      legendLines.push(
        `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${color}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(name)}</text>`,
      )
      row++
    }
    // Horizontal drainage falls — the drafter's standing note (P3005.3).
    if (mine.some((m) => m.system === 'plumbing')) {
      const y = MARGIN + 14 + row * 14
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#333">DWV SLOPE 1/4 IN/FT (P3005.3)</text>`,
      )
    }
  }
  if (def.key === 'electrical' || def.key === 'mep') {
    const TAG_NAMES: Record<string, string> = {
      R: 'receptacle',
      G: 'GFCI receptacle',
      S: 'switch',
      L: 'light',
      SD: 'smoke alarm',
      P: 'panel',
      EF: 'exhaust fan',
      T: 'thermostat',
      SR: 'supply register',
      RA: 'return air',
      SO: 'stub-out',
      VS: 'vent stack',
      WH: 'water heater',
      M: 'water meter',
      AH: 'air handler',
      CO: 'cleanout',
    }
    const usedTags = [...new Set(devs.map((f) => FIXTURE_TAG[f.kind] ?? '·'))]
    let trow = legendLines.length
    for (const tag of usedTags) {
      const y = MARGIN + 14 + trow * 14
      legendLines.push(
        `<circle cx="${MARGIN + 7}" cy="${y - 3}" r="6" fill="#fff" stroke="#a05c10" stroke-width="1"/>` +
          `<text x="${MARGIN + 7}" y="${y - 0.5}" font-size="7" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#a05c10">${esc(tag)}</text>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(TAG_NAMES[tag] ?? tag)}</text>`,
      )
      trow++
    }
  }
  if (def.key === 'electrical') {
    const circuits = new Map<string, Fixture | undefined>()
    for (const m of mine) {
      if (m.role === 'wire-run' && !circuits.has(m.sourceId)) {
        circuits.set(
          m.sourceId,
          devs.find((f) => f.meta?.circuit === m.sourceId),
        )
      }
    }
    let row = legendLines.length
    for (const [circuit, sample] of [...circuits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const y = MARGIN + 14 + row * 14
      const amps = sample?.meta?.breakerA ?? '—'
      const awg = sample?.meta?.gaugeAwg ?? '—'
      legendLines.push(
        `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${circuitColor(circuit)}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`${circuit} — ${amps}A/${awg}AWG · ${circuitZoneHint(circuit)}`)}</text>`,
      )
      row++
      if (row > 22) break
    }
  }
  if (def.key === 'foundation') {
    const bolts = mine.filter((m) => m.role === 'anchor-bolt')
    if (bolts.length > 0) {
      const y = MARGIN + 14 + legendLines.length * 14
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`1/2" anchor bolts @ 6'-0" o.c. max — ${bolts.length} pcs`)}</text>`,
      )
    }
  }
  if (def.key === 'wall' && opts.studSpacingIn) {
    const y = MARGIN + 14 + legendLines.length * 14
    legendLines.push(
      `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`STUDS @ ${opts.studSpacingIn}" O.C. U.N.O.`)}</text>`,
    )
  }

  const legend =
    legendLines.length > 0
      ? `<rect x="${MARGIN - 4}" y="${MARGIN - 6}" width="250" height="${legendLines.length * 14 + 14}" fill="#ffffff" fill-opacity="0.92" stroke="#ccc" stroke-width="0.5"/>${legendLines.join('')}`
      : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${shapes.join('')}${chrome(def.title, opts, scale, legend, { ratio: t.ratio })}</svg>`
  return { title: def.title, svg }
}

/** Schedules sheet: takeoff rows + engineering flags, as printable text. */
// ---------------------------------------------------------------------------
// Cover, elevations, section — the rest of a standard set (round: "standard
// blueprints show side views"). Members are drawn as stroke segments along
// their longest local axis: honest line-art framing, no hidden-face solver.
// ---------------------------------------------------------------------------

type Seg = { x1: number; y1: number; x2: number; y2: number; w: number; depth: number; color: string; butt?: boolean }

/** World-space endpoints of a member's longest axis + its stroke thickness. */
function memberAxis(m: Member, lift: number): { a: [number, number, number]; b: [number, number, number]; w: number } {
  const dims = m.dims
  const axis = dims[0] >= dims[1] && dims[0] >= dims[2] ? 0 : dims[1] >= dims[2] ? 1 : 2
  const half = dims[axis] / 2
  const [rx, ry, rz] = m.rotation
  // R = Rx(rx) · Ry(ry) · Rz(rz) applied to e_axis (three.js XYZ order)
  const e: [number, number, number] = [0, 0, 0]
  e[axis] = 1
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)
  let vx = e[0] * cz - e[1] * sz
  let vy = e[0] * sz + e[1] * cz
  let vz = e[2]
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const tx = vx * cy + vz * sy
  vz = -vx * sy + vz * cy
  vx = tx
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const ty = vy * cx - vz * sx
  vz = vy * sx + vz * cx
  vy = ty
  const c: [number, number, number] = [m.position[0], m.position[1] + lift, m.position[2]]
  const w = [...dims].sort((p, q) => q - p)[1] ?? 0.05
  return {
    a: [c[0] - vx * half, c[1] - vy * half, c[2] - vz * half],
    b: [c[0] + vx * half, c[1] + vy * half, c[2] + vz * half],
    w,
  }
}

const SYSTEM_STROKE: Record<string, string> = {
  foundation: '#8b8f96',
  'wall-framing': '#caa06a',
  'floor-framing': '#b98d55',
  'roof-framing': '#a97e48',
  electrical: '#c2803d',
  plumbing: '#6f8fa8',
  hvac: '#8fa8a0',
}

function memberSegs(
  members: Member[],
  opts: PlanSetOptions,
  proj: (p: [number, number, number]) => [number, number],
  depthOf: (p: [number, number, number]) => number,
  filter?: (m: Member) => boolean,
): Seg[] {
  const segs: Seg[] = []
  for (const m of members) {
    if (m.role === 'wire-run' || m.face) continue // keep line art structural
    if (filter && !filter(m)) continue
    const lift = m.levelId ? (opts.levelBaseY?.[m.levelId] ?? 0) : 0
    const { a, b, w } = memberAxis(m, lift)
    const [x1, y1] = proj(a)
    const [x2, y2] = proj(b)
    segs.push({
      x1,
      y1,
      x2,
      y2,
      w,
      depth: (depthOf(a) + depthOf(b)) / 2,
      color: SYSTEM_STROKE[m.system] ?? '#9a9a9a',
      // below-grade work prints dashed with butt caps ('hidden' convention)
      butt: m.system === 'foundation',
    })
  }
  return segs.sort((p, q) => p.depth - q.depth)
}

function fitSegs(segs: Seg[], fixedRatio?: number): { sx: (x: number) => number; sy: (y: number) => number; scale: number; ratio: number } | null {
  if (segs.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const s of segs) {
    minX = Math.min(minX, s.x1, s.x2)
    maxX = Math.max(maxX, s.x1, s.x2)
    minY = Math.min(minY, s.y1, s.y2)
    maxY = Math.max(maxY, s.y1, s.y2)
  }
  const availW = W - 2 * MARGIN - 258
  const availH = H - 2 * MARGIN - TITLE_H - 30
  const raw = Math.min(availW / Math.max(0.1, maxX - minX), availH / Math.max(0.1, maxY - minY))
  const ppm = 96 / 0.0254
  const ratio = fixedRatio ?? (RATIOS.find((r) => ppm / r <= raw) ?? (RATIOS[RATIOS.length - 1] as number))
  const scale = ppm / ratio
  const ox = MARGIN + (availW - (maxX - minX) * scale) / 2
  const oy = MARGIN + (availH - (maxY - minY) * scale) / 2
  return { sx: (x) => ox + (x - minX) * scale, sy: (y) => oy + (y - minY) * scale, scale, ratio }
}

function segSvg(segs: Seg[], f: NonNullable<ReturnType<typeof fitSegs>>): string {
  return segs
    .map(
      (s) =>
        `<line x1="${f.sx(s.x1).toFixed(1)}" y1="${f.sy(s.y1).toFixed(1)}" x2="${f.sx(s.x2).toFixed(1)}" y2="${f.sy(s.y2).toFixed(1)}" stroke="${s.color}" stroke-width="${Math.max(0.7, s.w * f.scale).toFixed(1)}" stroke-linecap="${s.butt ? 'butt' : 'round'}"${s.butt ? ' stroke-dasharray="5 3" opacity="0.75"' : ''}/>`,
    )
    .join('')
}

const ELEVATIONS: { key: string; title: string; proj: (p: [number, number, number]) => [number, number]; depth: (p: [number, number, number]) => number }[] = [
  { key: 'south', title: 'South elevation (framing)', proj: (p) => [p[0], -p[1]], depth: (p) => -p[2] },
  { key: 'north', title: 'North elevation (framing)', proj: (p) => [-p[0], -p[1]], depth: (p) => p[2] },
  // Standing EAST of the building looking west, north (−z) is screen-RIGHT
  // (blueprint round-2: both sheets printed mirrored).
  { key: 'east', title: 'East elevation (framing)', proj: (p) => [-p[2], -p[1]], depth: (p) => p[0] },
  { key: 'west', title: 'West elevation (framing)', proj: (p) => [p[2], -p[1]], depth: (p) => -p[0] },
]

function elevationSheets(members: Member[], opts: PlanSetOptions): PlanSheet[] {
  const sheets: PlanSheet[] = []
  // one building, one elevation family, ONE scale (round-2: S/N printed
  // 1:100 next to E/W at 1:75) — fit every view, keep the coarsest ratio
  const fits = ELEVATIONS.map((ev) => fitSegs(memberSegs(members, opts, ev.proj, ev.depth)))
  const familyRatio = Math.max(...fits.filter((f) => f !== null).map((f) => f.ratio), 0)
  for (const ev of ELEVATIONS) {
    const segs = memberSegs(members, opts, ev.proj, ev.depth)
    const f = fitSegs(segs, familyRatio || undefined)
    if (!f) continue
    // grade line at world y = 0 (proj y of [x,0,z] is 0 in every elevation)
    const gy = f.sy(0)
    const grade = `<line x1="${MARGIN - 14}" y1="${gy.toFixed(1)}" x2="${W - MARGIN - 258 + 14}" y2="${gy.toFixed(1)}" stroke="#222" stroke-width="2.5"/><text x="${MARGIN - 14}" y="${(gy + 14).toFixed(1)}" font-size="9" font-family="Helvetica, Arial, sans-serif" fill="#222">GRADE</text>`
    sheets.push({
      title: ev.title,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(segs, f)}${grade}${chrome(ev.title, opts, f.scale, '', { ratio: f.ratio, northArrow: false })}</svg>`,
    })
  }
  return sheets
}

function sectionSheet(members: Member[], opts: PlanSetOptions): PlanSheet | null {
  if (members.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (const m of members) {
    minX = Math.min(minX, m.position[0])
    maxX = Math.max(maxX, m.position[0])
  }
  const cutX = (minX + maxX) / 2
  const BAND = 0.9
  const segs = memberSegs(
    members,
    opts,
    (p) => [p[2], -p[1]],
    (p) => p[0],
    (m) => {
      // a member belongs to the section if its EXTENT crosses the cut band
      // (round-2: center-only tests dropped the very walls the cut slices)
      const yaw = m.rotation[1]
      const ex = (Math.abs(Math.cos(yaw)) * m.dims[0] + Math.abs(Math.sin(yaw)) * m.dims[2]) / 2
      return Math.abs(m.position[0] - cutX) < BAND + ex
    },
  )
  const f = fitSegs(segs)
  if (!f) return null
  const gy = f.sy(0)
  const grade = `<line x1="${MARGIN - 14}" y1="${gy.toFixed(1)}" x2="${W - MARGIN - 258 + 14}" y2="${gy.toFixed(1)}" stroke="#222" stroke-width="2.5"/>`
  const title = 'Section A-A (transverse)'
  return {
    title,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(segs, f)}${grade}<text x="${MARGIN}" y="${MARGIN + 4}" font-size="11" font-family="Helvetica, Arial, sans-serif" fill="#333">Cut ${BAND.toFixed(1)} m band at plan midpoint — members within the band shown</text>${chrome(title, opts, f.scale, '', { ratio: f.ratio, northArrow: false })}</svg>`,
  }
}

function coverSheet(members: Member[], opts: PlanSetOptions, index: string[]): PlanSheet | null {
  // isometric hero: u = (x − z)·cos30, v = (x + z)·sin30 − y
  const c30 = Math.cos(Math.PI / 6)
  const s30 = Math.sin(Math.PI / 6)
  const segs = memberSegs(
    members,
    opts,
    (p) => [(p[0] - p[2]) * c30, (p[0] + p[2]) * s30 - p[1]],
    (p) => p[0] + p[2] - p[1] * 0.01,
  )
  const f = fitSegs(segs)
  if (!f) return null
  const title = opts.projectName ?? 'Project'
  const lines = [
    `${opts.levelName ?? 'Level'} — full construction set`,
    [opts.jurisdiction, opts.codeName].filter(Boolean).join(' · '),
    `${opts.date ?? ''} · Drafting aid, not engineering — verify with your local building department`,
  ].filter((l) => l.length > 0)
  const indexRows = index
    .map(
      (name, i) =>
        `<text x="${W - MARGIN - 236}" y="${MARGIN + 30 + i * 16}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${i + 2}.  ${esc(name)}</text>`,
    )
    .join('')
  return {
    title: 'Cover',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(segs, f)}<text x="${W - MARGIN - 236}" y="${MARGIN + 8}" font-size="12" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">SHEET INDEX</text><text x="${W - MARGIN}" y="${H - MARGIN}" text-anchor="end" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#555">__SHEET_NO__ · members drawn at model elevations</text>${indexRows}<text x="${MARGIN}" y="${H - MARGIN - 44}" font-size="30" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">${esc(title)}</text>${lines
      .map(
        (l, i) =>
          `<text x="${MARGIN}" y="${H - MARGIN - 22 + i * 14}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#444">${esc(l)}</text>`,
      )
      .join('')}</svg>`,
  }
}

function schedulesSheets(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
): PlanSheet[] {
  // Flags render as their own ⚑ list — the 'Flags · FLAG — 1 ea' rows
  // read as nonsense in the grid (quality C5).
  const rows = computeTakeoff(members, fixtures).filter((r) => r.section !== 'Flags')
  if (rows.length === 0) return []
  const flags = [
    ...new Set([
      ...members.filter((m) => m.flag).map((m) => m.flag as string),
      ...(opts.warnings ?? []),
    ]),
  ]
  const colW = (W - 2 * MARGIN) / 2
  const lineH = 15
  const maxLines = Math.floor((H - 2 * MARGIN - TITLE_H - 24) / lineH)
  const perSheet = 2 * maxLines
  // The flag block bottom-anchors on the LAST page — shrink that page's
  // row capacity so a full column never runs under the red list
  // (quality round-3: row 41 and the flags overprinted at y≈673).
  const flagRows = Math.min(flags.length, 6) + (flags.length > 6 ? 1 : 0)
  const lastPageCap = 2 * Math.max(4, maxLines - (flagRows > 0 ? flagRows + 1 : 0))
  const pages = (() => {
    if (rows.length <= lastPageCap) return 1
    let p = 2
    while ((p - 1) * perSheet + lastPageCap < rows.length) p++
    return p
  })()
  // Even distribution: filling early pages to 100% left a near-blank
  // flags-only sheet at the end (blueprint P1) — every page carries its
  // share; the last stays under its flag-shrunk cap.
  const basePerPage =
    pages === 1
      ? lastPageCap
      : Math.max(
          Math.ceil(rows.length / pages),
          Math.ceil((rows.length - lastPageCap) / (pages - 1)),
        )
  const sheets: PlanSheet[] = []
  let cursorRow = 0
  for (let page = 0; page < pages; page++) {
    const cap = page === pages - 1 ? lastPageCap : basePerPage
    const slice = rows.slice(cursorRow, cursorRow + cap)
    cursorRow += slice.length
    const cells: string[] = []
    const pageLines = Math.ceil(slice.length / 2)
    slice.forEach((r, i) => {
      const col = Math.floor(i / pageLines)
      const x = MARGIN + col * colW
      const y = MARGIN + 24 + (i % pageLines) * lineH
      const detail = r.detail && r.detail !== 'linear feet' ? ` (${r.detail})` : ''
      cells.push(
        `<text x="${x}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#222">${esc(clip(`${r.section} · ${r.item} — ${r.quantity} ${r.unit}${detail}`, 62))}</text>`,
      )
    })
    // Flags on the LAST page; overflow called out, never silently dropped
    // (round-14: a 60-wall house lost 11 rows and most flags).
    let flagText = ''
    if (page === pages - 1 && flags.length > 0) {
      const shown = flags.slice(0, 6)
      const parts = shown.map(
        (f, i) =>
          `<text x="${MARGIN}" y="${H - TITLE_H - 40 - (shown.length - 1 - i) * 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">⚑ ${esc(f)}</text>`,
      )
      if (flags.length > shown.length) {
        parts.push(
          `<text x="${MARGIN}" y="${H - TITLE_H - 40 + 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">… +${flags.length - shown.length} more flags — see the panel takeoff</text>`,
        )
      }
      flagText = parts.join('')
    }
    const title = pages > 1 ? `Schedules + takeoff (${page + 1}/${pages})` : 'Schedules + takeoff'
    sheets.push({
      title,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><text x="${MARGIN}" y="${MARGIN + 4}" font-size="13" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">Material takeoff${pages > 1 ? ` — sheet ${page + 1} of ${pages}` : ''}</text>${cells.join('')}${flagText}${chrome(title, opts, 40, '', { scaleBar: false })}</svg>`,
    })
  }
  return sheets
}

/** Every sheet the current level's members can support, in print order. */
export function buildPlanSet(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions = {},
): PlanSheet[] {
  const t = setTransform(members, fixtures)
  const sheets: PlanSheet[] = []
  if (t) {
    for (const def of PLAN_SHEETS) {
      const sheet = planSheet(def, members, fixtures, opts, t)
      if (sheet) sheets.push(sheet)
    }
  }
  sheets.push(...elevationSheets(members, opts))
  const section = sectionSheet(members, opts)
  if (section) sheets.push(section)
  sheets.push(...schedulesSheets(members, fixtures, opts))
  const cover = coverSheet(members, opts, sheets.map((sh) => sh.title))
  if (cover) sheets.unshift(cover)
  // SHEET n/N in every title block (blueprint C6) — patch the placeholder
  // after the census is known.
  return sheets.map((sheet, i) => ({
    ...sheet,
    svg: sheet.svg.replaceAll('__SHEET_NO__', `SHEET ${i + 1}/${sheets.length}`),
  }))
}

/** Self-contained printable document — Print → Save as PDF gives the plan set. */
export function planSetHtml(sheets: PlanSheet[], opts: PlanSetOptions = {}): string {
  const pages = sheets
    .map((s) => `<section class="sheet">${s.svg}</section>`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(opts.projectName ?? 'Project')} — Full plans (LOD 400)</title>
<style>
  @page { size: letter landscape; margin: 0; }
  html, body { margin: 0; padding: 0; background: #6b7078; }
  .hint { font: 12px Helvetica, Arial, sans-serif; color: #fff; padding: 10px 16px; }
  .sheet { width: ${W}px; height: ${H}px; margin: 12px auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.35); page-break-after: always; break-after: page; }
  .sheet svg { display: block; }
  @media print { .hint { display: none; } .sheet { margin: 0; box-shadow: none; } }
</style></head>
<body><div class="hint">Print (⌘P) → Save as PDF for the shareable plan set. ${sheets.length} sheets.</div>
${pages}
</body></html>`
}
