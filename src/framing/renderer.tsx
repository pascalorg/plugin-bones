'use client'

import { sceneRegistry, useRegistry, useScene } from '@pascal-app/core'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { Fixture, Member } from '../core/types'
import { inches } from '../core/units'
import { circuitColor, plumbingPipeColor } from '../plans/circuit-colors'
import { computeLevel } from './compute'
import type { FramingNode } from './schema'

/**
 * The X-ray renderer: derives every member for this node's level and draws
 * them as one InstancedMesh per color bucket — a whole house is a handful of
 * draw calls. Nothing here is persisted; edit a wall and the skeleton
 * recomputes on the spot.
 */

/** Color buckets — material first, with structural roles popped for reading. */
function colorOf(member: Member): string {
  // Wires color by CIRCUIT (sourceId carries the circuit id) so a run reads
  // as its zone in the building exactly like on the exported plan.
  if (member.system === 'electrical' && member.role === 'wire-run') {
    return circuitColor(member.sourceId)
  }
  // Plumbing runs color by SYSTEM (sourceId prefix): cold blue, hot red,
  // DWV slate — identical to the exported MEP sheet. The room-category
  // fallback's room-sourced runs keep their material colors below.
  if (member.system === 'plumbing' && member.role === 'pipe-run') {
    const pipe = plumbingPipeColor(member.sourceId)
    if (pipe) return pipe
  }
  switch (member.role) {
    case 'drywall':
      return '#ece7de'
    case 'sheathing':
      return '#c8a262'
    case 'wrb':
      return '#4f7d8c'
    case 'cladding':
      return '#aebfc7'
    default:
      break
  }
  switch (member.material) {
    case 'concrete':
      return '#9aa0a5'
    case 'pt-lumber':
      return '#7d9d6a'
    case 'steel':
      return '#8b8f96'
    case 'engineered':
      return '#c39b5e'
    case 'pvc':
      return '#e9e7df'
    case 'copper':
      return '#b0723d'
    case 'duct':
      return '#aab3bb'
    default:
      break
  }
  switch (member.role) {
    case 'rebar':
      return '#8a4b2a'
    case 'wire-run':
      return '#e6c84a'
    case 'header':
      return '#c1904f'
    case 'king-stud':
    case 'trimmer':
      return '#cfa269'
    default:
      return '#dbb98b'
  }
}

const FIXTURE_COLORS: Record<string, string> = {
  'exhaust-fan': '#9fb8c8',
  receptacle: '#f2b63d',
  'receptacle-gfci': '#e88f2a',
  switch: '#7fb3e0',
  light: '#f5e08a',
  'smoke-alarm': '#e06c6c',
  panel: '#8f8f8f',
}

/** Fixtures render as small instanced boxes (device-box scale). */
function fixtureBox(fixture: Fixture): { dims: [number, number, number]; color: string } {
  const color = FIXTURE_COLORS[fixture.kind] ?? '#f2b63d'
  if (fixture.kind === 'panel') return { dims: [inches(14), inches(30), inches(4)], color }
  if (fixture.kind === 'light') return { dims: [inches(6), inches(1.5), inches(6)], color }
  return { dims: [inches(3), inches(4.5), inches(2.5)], color }
}

type Bucket = {
  color: string
  entries: {
    dims: readonly [number, number, number]
    position: readonly [number, number, number]
    rotation: readonly [number, number, number]
  }[]
  /** Assembly-layer face normal — the dollhouse cut hides camera-facing buckets. */
  face?: readonly [number, number]
  /** No overlay ghost for this bucket. */
  ghostless?: boolean
}

/** Main group (the node's own level) + one group per FOREIGN source level
 * (cross-level roofs). Foreign groups hold level-LOCAL geometry and get
 * mounted into that level's Object3D by the renderer so the host's
 * stacked / exploded / solo level transforms apply natively. */
export type BuiltGroups = { group: Group; foreign: Map<string, Group> }

export function buildGroups(
  members: Member[],
  fixtures: Fixture[],
  seeThrough: boolean,
): BuiltGroups {
  const foreign = new Map<string, Group>()
  const own: Member[] = []
  const byLevel = new Map<string, Member[]>()
  for (const m of members) {
    if (m.levelId) {
      const list = byLevel.get(m.levelId) ?? []
      list.push(m)
      byLevel.set(m.levelId, list)
    } else own.push(m)
  }
  const group = buildGroup(own, fixtures, seeThrough)
  for (const [levelId, list] of byLevel) {
    const g = buildGroup(list, [], seeThrough)
    g.name = `bones-foreign-${levelId}`
    foreign.set(levelId, g)
  }
  return { group, foreign }
}

export function buildGroup(members: Member[], fixtures: Fixture[], seeThrough: boolean): Group {
  const buckets = new Map<string, Bucket>()
  const push = (
    key: string,
    color: string,
    dims: readonly [number, number, number],
    position: readonly [number, number, number],
    rotation: readonly [number, number, number],
    face?: readonly [number, number],
    ghostless?: boolean,
  ) => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { color, entries: [], face, ghostless }
      buckets.set(key, bucket)
    }
    bucket.entries.push({ dims, position, rotation })
  }

  for (const member of members) {
    const color = colorOf(member)
    if (member.face && !seeThrough) {
      // Solid mode: the HOST's wall skin is visible and our flush drywall
      // face z-fights it (random depth-precision squares — user report).
      // The host grey IS the drywall look there; layers render only in
      // X-ray, where the host shells are hidden ('down') and our stacks
      // are the walls. (They still count in the takeoff either way.)
      continue
    }
    if (member.face) {
      // Assembly layers: bucket PER FACE NORMAL (quantized) so the
      // dollhouse cut can hide camera-facing stacks as whole meshes.
      const key = `${color}|${member.face[0].toFixed(2)},${member.face[1].toFixed(2)}`
      push(key, color, member.dims, member.position, member.rotation, member.face, true)
      continue
    }
    // Ghost copies only make sense where no dollhouse opening can reveal
    // the members: below grade / under the floor. Wall, roof and MEP
    // members read through the OPENED near faces instead — ghosting them
    // made every wall look transparent (round-13 user report).
    const ghostless = member.system !== 'foundation' && member.system !== 'floor-framing'
    push(`${color}|${ghostless ? 'solid' : 'ghosted'}`, color, member.dims, member.position, member.rotation, undefined, ghostless)
  }
  for (const fixture of fixtures) {
    const { dims, color } = fixtureBox(fixture)
    push(`${color}|fixture`, color, dims, fixture.position, [0, fixture.rotationY, 0], undefined, true)
  }

  const group = new Group()
  const unitBox = new BoxGeometry(1, 1, 1)
  const matrix = new Matrix4()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  const translation = new Vector3()
  const euler = new Euler()

  // X-ray = TWO passes per bucket (round-11 regression: overlay-only
  // members painted over a TREE standing in front of the house — the
  // host's overlay pass composites over the finished scene with no
  // scene-depth test).
  //
  //  - A SOLID copy on the SCENE layer (0): normal depth against the whole
  //    scene, so anything nearer the camera — a tree, a neighboring house —
  //    occludes the skeleton exactly like real geometry. Inside walls it is
  //    hidden, which is fine: that is what the ghost is for.
  //  - A GHOST copy on the host OVERLAY layer (1) at partial opacity: the
  //    editor's post-processing pipeline (packages/viewer
  //    post-processing.tsx) renders that layer into its own freshly cleared
  //    depth buffer and composites it on top by alpha. The ghost therefore
  //    shows THROUGH walls/roofs/occluders (near member still hides far
  //    member — the round-2 requirement), while wherever the solid copy is
  //    directly visible the ghost blends member-color onto member-color and
  //    changes nothing.
  //
  // Every in-scene depth trick failed on this pipeline and is pinned in
  // tests: renderer.clearDepth() poisoned the WebGPU pass; an inverted
  // depth-wipe box never landed its depthWrite; transparent-list membership
  // lost to the host's MRT scene pass on camera change.
  //
  // Degraded-but-visible fallback: when post-processing is off (WebGL2
  // fallback, ?disable=postFx) the camera mask still includes layer 1, so
  // both copies render in the main pass with shared depth — no see-through,
  // but nothing disappears.
  const OVERLAY_LAYER = 1
  const GHOST_OPACITY = 0.45

  for (const bucket of buckets.values()) {
    // Normal depth-tested draws, so members occlude each other correctly —
    // the round-2 user-reported artifacts (footing over nearer studs, far
    // stud tops reading through the top plate) came from bypassing the
    // depth test.
    const solid = new InstancedMesh(
      unitBox,
      new MeshStandardMaterial({ color: bucket.color, roughness: 0.82 }),
      bucket.entries.length,
    )
    if (bucket.face) solid.userData.face = bucket.face
    const meshes = [solid]
    if (seeThrough && !bucket.ghostless) {
      const ghostMaterial = new MeshStandardMaterial({
        color: bucket.color,
        roughness: 0.82,
        transparent: true,
        opacity: GHOST_OPACITY,
      })
      // Self-occlusion inside the overlay pass needs the depth write that
      // transparent materials normally skip.
      ghostMaterial.depthWrite = true
      const ghost = new InstancedMesh(unitBox, ghostMaterial, bucket.entries.length)
      ghost.layers.set(OVERLAY_LAYER)
      meshes.push(ghost)
    }
    bucket.entries.forEach((entry, i) => {
      euler.set(entry.rotation[0], entry.rotation[1], entry.rotation[2])
      quaternion.setFromEuler(euler)
      translation.set(entry.position[0], entry.position[1], entry.position[2])
      scale.set(
        Math.max(entry.dims[0], 0.001),
        Math.max(entry.dims[1], 0.001),
        Math.max(entry.dims[2], 0.001),
      )
      matrix.compose(translation, quaternion, scale)
      for (const mesh of meshes) mesh.setMatrixAt(i, matrix)
    })
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = mesh === solid
      mesh.receiveShadow = mesh === solid
      mesh.frustumCulled = false
      group.add(mesh)
    }
  }
  return group
}

function disposeGroup(group: Group) {
  // All meshes share one unit-box geometry — dispose each UNIQUE geometry
  // exactly once.
  const geometries = new Set<BoxGeometry>()
  for (const child of group.children) {
    const mesh = child as InstancedMesh
    mesh.dispose?.()
    ;(mesh.material as MeshStandardMaterial | undefined)?.dispose?.()
    if (mesh.geometry) geometries.add(mesh.geometry as BoxGeometry)
  }
  for (const geometry of geometries) geometry.dispose()
}

export const FramingRenderer = ({ node }: { node: FramingNode }) => {
  const ref = useRef<Group>(null!)
  const viewDir = useRef(new Vector3())
  useRegistry(node.id, node.type, ref)

  // Any scene edit re-derives the skeleton — that's the contract (never stale).
  const nodes = useScene((s) => s.nodes)
  const result = useMemo(
    () => computeLevel(nodes as Record<string, Record<string, unknown>>, node),
    [nodes, node],
  )

  const built = useMemo(
    () => buildGroups(result.members, result.fixtures, node.seeThrough !== false),
    [result, node.seeThrough],
  )
  const group = built.group
  useEffect(() => {
    return () => {
      disposeGroup(built.group)
      for (const g of built.foreign.values()) {
        g.parent?.remove(g)
        disposeGroup(g)
      }
    }
  }, [built])

  // Cross-level members (the roof on its own storey) mount into THEIR
  // level's Object3D so the host's stacked/exploded/solo level transforms
  // and visibility apply natively — a baked storey offset was only right
  // in stacked view (prod 2026-08-15 round 3). The level object may
  // register after us, so (re)attach lazily in the frame loop below.
  const attachForeign = () => {
    for (const [levelId, g] of built.foreign) {
      const levelObj = sceneRegistry.nodes.get(levelId as Parameters<typeof sceneRegistry.nodes.get>[0])
      if (levelObj && g.parent !== levelObj) levelObj.add(g)
      // Imperative children don't unmount with the JSX — mirror the node's
      // visibility by hand (hiding the X-ray must hide the foreign roofs).
      g.visible = node.visible !== false
    }
  }

  // NOTE: the wall-mode takeover ('down' while X-raying) used to live here,
  // keyed to this renderer's lifetime — which is the NODE's lifetime, so
  // leaving the Bones panel (or merely loading a scene that contained an
  // X-ray node) left the host's walls hidden, persisted across reloads.
  // It moved to the panel (see ../view-takeover.ts), whose mount/unmount is
  // the lifetime the intent actually has. This renderer only draws.

  // Dollhouse cut (round 13): assembly-layer buckets carry their face
  // normal — hide the stacks whose face points TOWARD the camera so you
  // look INTO the cavity and see the far side's drywall as the backdrop.
  // The wall is never transparent; the near face is simply removed.
  useFrame(({ camera }) => {
    attachForeign()
    if (node.seeThrough === false) return
    const dir = camera.getWorldDirection(viewDir.current)
    for (const child of group.children) {
      const face = (child.userData as { face?: readonly [number, number] }).face
      if (!face) continue
      // face normal · view direction > 0 → face points away → keep it
      child.visible = face[0] * dir.x + face[1] * dir.z > 0.02
    }
  })

  if (!node.visible) return null
  return (
    <group ref={ref}>
      <primitive object={group} />
    </group>
  )
}

export default FramingRenderer
