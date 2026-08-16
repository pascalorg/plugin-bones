'use client'

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { SegmentedControl, SliderControl, useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useEffect, useMemo, useState } from 'react'
import { computeLevel } from './framing/compute'
import { extractLevels } from './core/wall-model'
import { FramingNode, type WallConstruction } from './framing/schema'
import { buildPlanSet, planSetHtml } from './plans/plan-set'
import { computeTakeoff, cutList, cutListCsv, takeoffCsv } from './engines/takeoff'
import { guessJurisdiction } from './jurisdiction/guess'
import { jurisdictionOptions, profileFor } from './jurisdiction/profiles'
import { LUMBER_CROSS_SECTIONS, LUMBER_SIZES, type LumberSize } from './lumber'
import { useBonesStore } from './store'
import { createWallModeTakeover, type WallModeViewer } from './view-takeover'

const LUMBER_KIND: string = 'bones:lumber'
const FRAMING_KIND: string = 'bones:framing'

const setPluginTool = (tool: string) => {
  const setTool = useEditor.getState().setTool as (value: string) => void
  setTool(tool)
}

const METERS_PER_INCH = 0.0254
const inchesLabel = (m: number) =>
  `${(m / METERS_PER_INCH).toFixed(2).replace(/\.?0+$/, '')}"`

/**
 * The Bones panel — the control room for the engineering X-ray. One click
 * derives the construction inside the current level (framing, foundation,
 * electrical…) from the model and renders it in 3D; everything below tunes
 * the derivation. Loose lumber placement lives at the bottom.
 */
export default function BonesPanel() {
  const activeLevelId = useViewer((s) => s.selection.levelId)
  const framingNode = useScene((s) => {
    if (!activeLevelId) return undefined
    return Object.values(s.nodes).find(
      (n) => (n.type as string) === FRAMING_KIND && n.parentId === activeLevelId,
    ) as (FramingNode & { id: string }) | undefined
  })
  // While this panel is OPEN with a live X-ray, hide the host's wall shells
  // so the skeleton reads as the building; restore on leave. Panel-owned on
  // purpose — see view-takeover.ts for why the renderer must not do this.
  const takeoverActive = Boolean(framingNode) && framingNode?.seeThrough !== false
  useEffect(() => {
    if (!takeoverActive) return
    const takeover = createWallModeTakeover(
      () => useViewer.getState() as unknown as WallModeViewer,
    )
    takeover.engage()
    return () => takeover.release()
  }, [takeoverActive])

  // ONE derivation per scene edit, shared by the X-Ray status line and the
  // takeoff — the renderer runs its own (also once). Reviewer advisory r1.
  const nodes = useScene((s) => s.nodes)
  const result = useMemo(() => {
    if (!framingNode) return null
    return computeLevel(nodes as Record<string, Record<string, unknown>>, framingNode)
  }, [nodes, framingNode])

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-base">Bones</h2>
          <span className="rounded-full border border-sidebar-border/60 bg-sidebar-accent px-1.5 py-px font-semibold text-[9px] text-sidebar-foreground/70 uppercase tracking-widest">
            Alpha
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          The engineering X-ray — see the construction inside the model: framing, foundation,
          wiring. Computed from your walls, sized to your jurisdiction.
        </p>
      </header>

      <XraySection activeLevelId={activeLevelId ?? null} framingNode={framingNode} result={result} />

      {framingNode && <WallOverrideSection framingNode={framingNode} />}
      {framingNode && result && <TakeoffSection result={result} />}

      <LumberSection />

      <footer className="-mx-4 -mb-4 sticky bottom-0 mt-1 flex flex-col gap-2 border-sidebar-border/50 border-t bg-sidebar px-4 py-3 text-[11px] text-sidebar-foreground/50 leading-relaxed">
        <span>Drafting aid, not engineering — verify with your local building department.</span>
        {framingNode && result && result.members.length > 0 && (
          <ExportPlansButton
            result={result}
            framingNode={framingNode}
            activeLevelId={activeLevelId ?? null}
            codeName={result.spec ? profileFor(result.jurisdiction).residentialCode : undefined}
          />
        )}
      </footer>
    </div>
  )
}

function XraySection({
  activeLevelId,
  framingNode,
  result,
}: {
  activeLevelId: string | null
  framingNode: (FramingNode & { id: string }) | undefined
  result: ReturnType<typeof computeLevel> | null
}) {
  // Client-only guess: the timezone differs between SSR and browser, which
  // would desync hydration — render a stable label first, fill in on mount.
  const [guess, setGuess] = useState<{ code: string; reason: string } | null>(null)
  useEffect(() => setGuess(guessJurisdiction()), [])
  const options = useMemo(() => jurisdictionOptions(), [])

  const toggle = (key: keyof FramingNode) => {
    if (!framingNode) return
    useScene
      .getState()
      .updateNode(framingNode.id as AnyNodeId, {
        [key]: !framingNode[key],
      } as Partial<AnyNode> as never)
  }

  if (!activeLevelId) {
    return <p className="text-sidebar-foreground/50 text-xs">Select a level to X-ray.</p>
  }

  if (!framingNode) {
    return (
      <button
        className="rounded-md border border-sidebar-ring bg-sidebar-accent px-3 py-2 text-left font-medium text-sm transition-colors hover:bg-sidebar-accent/70"
        onClick={() => {
          const node = FramingNode.parse({ jurisdiction: 'AUTO' })
          useScene.getState().createNode(node as unknown as AnyNode, activeLevelId as AnyNodeId)
        }}
        type="button"
      >
        ⚡ X-Ray this level
        <span className="block font-normal text-sidebar-foreground/50 text-xs">
          Derive framing, foundation &amp; systems from the model
        </span>
      </button>
    )
  }

  const effectiveCode = result?.jurisdiction ?? 'INTL'
  const profile = profileFor(effectiveCode)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">X-Ray</span>
        <button
          className="rounded-md border border-sidebar-border/60 px-2 py-1 text-sidebar-foreground/70 text-xs transition-colors hover:bg-sidebar-accent"
          onClick={() => useScene.getState().deleteNode(framingNode.id as AnyNodeId)}
          type="button"
        >
          Remove
        </button>
      </div>

      <JurisdictionPicker
        framingNodeId={framingNode.id as AnyNodeId}
        value={framingNode.jurisdiction}
        guess={guess}
        options={options}
        codeName={profile.residentialCode}
      />

      <div className="flex gap-2">
        <div className="flex-1">
          <SegmentedControl
            onChange={(v: string) =>
              useScene
                .getState()
                .updateNode(framingNode.id as AnyNodeId, { detail: v } as Partial<AnyNode> as never)
            }
            options={[
              { label: 'Generic', value: '200' },
              { label: 'Code', value: '300' },
              { label: 'Fab', value: '400' },
            ]}
            value={framingNode.detail}
          />
        </div>
        <div className="w-24">
          <SegmentedControl
            onChange={(v: string) =>
              useScene
                .getState()
                .updateNode(framingNode.id as AnyNodeId, {
                  studSpacingIn: Number(v) as 16 | 24,
                } as Partial<AnyNode> as never)
            }
            options={[
              { label: '16 in', value: '16' },
              { label: '24 in', value: '24' },
            ]}
            value={String(framingNode.studSpacingIn)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            ['showWalls', 'Wall framing'],
            ['showFloor', 'Floor'],
            ['showRoof', 'Roof'],
            ['showFoundation', 'Foundation'],
            ['showElectrical', 'Electrical'],
            ['showPlumbing', 'Plumbing'],
            ['showHvac', 'HVAC'],
            ['seeThrough', 'X-ray vision'],
          ] as const
        ).map(([key, label]) => (
          <button
            className={`rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
              framingNode[key]
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
                : 'border-sidebar-border/60 bg-sidebar-accent/30 text-sidebar-foreground/60 hover:bg-sidebar-accent/60'
            }`}
            key={key}
            onClick={() => toggle(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {result && (
        <div className="text-[11px] text-sidebar-foreground/50">
          {result.members.length} members · {result.fixtures.length} devices
          {[...new Set(result.warnings)].map((warning) => (
            <span className="block text-amber-500/80" key={warning}>
              {warning}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Per-wall construction override, bound to the current selection. */
function WallOverrideSection({
  framingNode,
}: {
  framingNode: FramingNode & { id: string }
}) {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const selectedWall = useScene((s) => {
    const id = selectedIds?.[0]
    if (!id) return undefined
    const node = s.nodes[id as AnyNodeId]
    return node && (node.type as string) === 'wall' ? node : undefined
  })

  if (!selectedWall) return null
  const wallId = selectedWall.id as string
  const current: WallConstruction = framingNode.wallOverrides?.[wallId] ?? 'framed'

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-sidebar-border/50 bg-sidebar-accent/30 p-2.5">
      <span className="font-medium text-xs">Selected wall construction</span>
      <SegmentedControl
        onChange={(v: WallConstruction) =>
          useScene.getState().updateNode(framingNode.id as AnyNodeId, {
            wallOverrides: { ...framingNode.wallOverrides, [wallId]: v },
          } as Partial<AnyNode> as never)
        }
        options={[
          { label: 'Framed', value: 'framed' },
          { label: 'CMU', value: 'cmu' },
          { label: 'Skip', value: 'skip' },
        ]}
        value={current}
      />
    </div>
  )
}

function TakeoffSection({ result }: { result: NonNullable<ReturnType<typeof computeLevel>> }) {
  const rows = useMemo(
    () => computeTakeoff(result.members, result.fixtures, result.areas),
    [result],
  )

  // Group by section (the takeoff engine's `section` field; tolerate rows
  // that predate it). FLAG rows always surface in their own group on top.
  const sections = useMemo(() => {
    const bySection = new Map<string, typeof rows>()
    for (const row of rows) {
      const section = ((row as { section?: string }).section ?? 'Takeoff') as string
      const bucket = bySection.get(section)
      if (bucket) bucket.push(row)
      else bySection.set(section, [row])
    }
    const entries = [...bySection.entries()]
    entries.sort(([a], [b]) => (a === 'Flags' ? -1 : b === 'Flags' ? 1 : 0))
    return entries
  }, [rows])

  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-xs">Takeoff</span>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md border border-sidebar-border/60 px-2 py-0.5 text-[10px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent"
            onClick={() => navigator.clipboard?.writeText(takeoffCsv(rows))}
            type="button"
          >
            Copy CSV
          </button>
          <button
            className="rounded-md border border-sidebar-border/60 px-2 py-0.5 text-[10px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent"
            onClick={() =>
              navigator.clipboard?.writeText(cutListCsv(cutList(result.members)))
            }
            title="Every wood member: size × exact cut length × qty"
            type="button"
          >
            Copy cut list
          </button>
        </div>
      </div>
      <div className="flex max-h-80 flex-col gap-1 overflow-y-auto pr-1">
        {sections.map(([section, sectionRows], index) => (
          <details className="group" key={section} open={index === 0 || section === 'Flags'}>
            <summary className="flex cursor-pointer items-center justify-between text-[11px] text-sidebar-foreground/80">
              <span className={section === 'Flags' ? 'font-medium text-amber-500/90' : 'font-medium'}>
                {section}
              </span>
              <span className="text-[10px] text-sidebar-foreground/40">{sectionRows.length}</span>
            </summary>
            <div className="mt-0.5 flex flex-col gap-0.5 pl-1">
              {sectionRows.map((row) => (
                <div
                  className="flex items-baseline justify-between gap-2 text-[11px]"
                  key={`${row.item}-${row.detail}`}
                  title={`${row.item} — ${row.detail}`}
                >
                  <span
                    className={`min-w-0 flex-1 text-sidebar-foreground/70 ${
                      section === 'Flags' ? 'whitespace-normal break-words' : 'truncate'
                    }`}
                  >
                    {row.item}
                    <span className="text-sidebar-foreground/40"> {row.detail}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-sidebar-foreground/90">
                    {row.quantity} {row.unit}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

/** Loose lumber placement (v0.1) — the manual escape hatch + debug tool. */
function LumberSection() {
  const size = useBonesStore((s) => s.size)
  const length = useBonesStore((s) => s.length)
  const orientation = useBonesStore((s) => s.orientation)
  const activeTool = useEditor((s) => s.tool)
  const count = useScene(
    (s) => Object.values(s.nodes).filter((n) => (n.type as string) === LUMBER_KIND).length,
  )
  const arming = activeTool === LUMBER_KIND

  const activate = (next: LumberSize) => {
    useBonesStore.getState().setSize(next)
    setPluginTool(LUMBER_KIND)
    useEditor.getState().setMode('build')
  }

  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center justify-between font-medium text-xs">
        Loose lumber
        <span className="rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] text-sidebar-foreground/60">
          {count}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-[11px] text-sidebar-foreground/50">
          {arming ? 'Click the ground to place. Esc to stop.' : 'Pick a size, click the ground.'}
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {LUMBER_SIZES.map((s) => {
            const [t, w] = LUMBER_CROSS_SECTIONS[s]
            const selected = arming && s === size
            return (
              <button
                className={`rounded-md border px-1 py-1.5 text-xs transition-colors ${
                  selected
                    ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
                    : 'border-sidebar-border/60 bg-sidebar-accent/40 text-sidebar-foreground/80 hover:bg-sidebar-accent'
                }`}
                key={s}
                onClick={() => activate(s)}
                title={`Actual ${inchesLabel(t)} × ${inchesLabel(w)}`}
                type="button"
              >
                {s}
              </button>
            )
          })}
        </div>
        <SegmentedControl
          onChange={useBonesStore.getState().setOrientation}
          options={[
            { label: 'Stud', value: 'stud' },
            { label: 'Flat', value: 'flat' },
            { label: 'Edge', value: 'edge' },
          ]}
          value={orientation}
        />
        <SliderControl
          label="Length"
          max={7.4}
          min={0.1}
          onChange={useBonesStore.getState().setLength}
          precision={2}
          restoreOnCommit={false}
          step={0.05}
          unit="m"
          value={length}
        />
      </div>
    </details>
  )
}

/**
 * Searchable jurisdiction picker (round-14 quality feedback): 51 states +
 * Auto in a filter-as-you-type list instead of a bare <select>, with the
 * resolved code linked to the public ICC library.
 */
function JurisdictionPicker({
  framingNodeId,
  value,
  guess,
  options,
  codeName,
}: {
  framingNodeId: AnyNodeId
  value: string
  guess: { code: string; reason: string } | null
  options: { code: string; name: string }[]
  codeName: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const pick = (code: string) => {
    useScene
      .getState()
      .updateNode(framingNodeId, { jurisdiction: code } as Partial<AnyNode> as never)
    setOpen(false)
    setQuery('')
  }
  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter((o) => o.name.toLowerCase().includes(q) || o.code.toLowerCase().includes(q))
    : options
  const current =
    value === 'AUTO'
      ? guess
        ? `Auto — ${guess.code}`
        : 'Auto'
      : (options.find((o) => o.code === value)?.name ?? value)
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-sidebar-foreground/60">Jurisdiction</span>
      <button
        type="button"
        className="flex items-center justify-between rounded-md border border-sidebar-border/60 bg-sidebar-accent/40 px-2 py-1.5 text-left text-sidebar-foreground text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{current}</span>
        <span className="text-sidebar-foreground/40">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="flex max-h-56 flex-col overflow-hidden rounded-md border border-sidebar-border/60 bg-sidebar shadow-lg">
          <input
            autoFocus
            className="border-sidebar-border/40 border-b bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-sidebar-foreground/30"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search states…"
            value={query}
          />
          <div className="overflow-y-auto">
            <button
              type="button"
              className="block w-full px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent"
              onClick={() => pick('AUTO')}
            >
              {guess ? `Auto — ${guess.code} (${guess.reason})` : 'Auto'}
            </button>
            {filtered.map((o) => (
              <button
                key={o.code}
                type="button"
                className={`block w-full px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent ${o.code === value ? 'bg-sidebar-accent/60' : ''}`}
                onClick={() => pick(o.code)}
              >
                {o.name}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-sidebar-foreground/40 text-xs">No match</div>
            )}
          </div>
        </div>
      )}
      <a
        className="text-[10px] text-sidebar-foreground/40 underline-offset-2 hover:underline"
        href={`https://codes.iccsafe.org/search/titles?searchTermAny=${encodeURIComponent(
          // the ICC library drops ?query= — /search/titles?searchTermAny=
          // with the short code name is the form that returns results
          // (quality B2, verified live)
          codeName.split('(')[0]?.split('—')[0]?.trim().slice(0, 48) ?? codeName.slice(0, 48),
        )}`}
        rel="noreferrer"
        target="_blank"
      >
        {codeName} ↗
      </a>
    </div>
  )
}

/**
 * "Save full plans" — the LOD 400 plan set as a printable document: one
 * SVG sheet per system (foundation / floor / wall / roof framing plans,
 * electrical rough-in, MEP) plus schedules + takeoff, paginated for the
 * browser's Print → Save as PDF. Pure client-side, nothing persisted.
 */
function ExportPlansButton({
  result,
  framingNode,
  activeLevelId,
  codeName,
}: {
  result: NonNullable<ReturnType<typeof computeLevel>>
  framingNode: FramingNode
  activeLevelId: AnyNodeId | null
  codeName?: string
}) {
  const levelName = useScene((s) =>
    activeLevelId ? ((s.nodes[activeLevelId] as { name?: string } | undefined)?.name ?? 'Level') : 'Level',
  )
  return (
    <button
      type="button"
      className="flex w-full flex-col items-center gap-0.5 rounded-lg bg-primary px-3 py-2.5 font-semibold text-primary-foreground text-sm shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.99]"
      onClick={() => {
        const sheets = buildPlanSet(result.members, result.fixtures, {
          projectName: document.title.split('—')[0]?.trim() || 'Pascal project',
          levelName,
          // resolved state code — raw 'AUTO' printed on sheets (quality C1)
          jurisdiction: result.jurisdiction,
          codeName,
          date: new Date().toLocaleDateString(),
          // engine warnings print verbatim in the schedules flag block
          // (blueprint C5 / checklist P4) — paper never hides a caveat
          warnings: result.warnings,
          studSpacingIn: framingNode.studSpacingIn,
          // storey elevations so cross-level (tagged) members draw at the
          // right height on elevations/section/cover
          levelBaseY: Object.fromEntries(
            extractLevels(
              useScene.getState().nodes as Record<string, Record<string, unknown>>,
            ).map((l) => [l.id, l.baseY]),
          ),
        })
        if (sheets.length === 0) return
        const html = planSetHtml(sheets, { projectName: levelName })
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
        window.open(url, '_blank', 'noopener')
        // The tab owns the blob from here; revoke after it had time to load.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }}
    >
      <span>📐 Blueprints</span>
    </button>
  )
}
