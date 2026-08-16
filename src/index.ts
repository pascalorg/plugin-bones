import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { BONES_ICON } from './art'
import { lumberDefinition } from './definition'
import { framingDefinition } from './framing/definition'

type PluginHostPanel = {
  id: string
  label: string
  icon: { kind: 'url'; src: string }
  component: () => Promise<{ default: React.ComponentType }>
  pluginId: string
  description: string
  creator: {
    name: string
    url?: string
  }
  pluginUrl: string
  defaultInstalled: boolean
}

/**
 * The Bones plugin manifest — the entire public surface of this package.
 * A host loads it through the same `loadPlugin` path the built-ins use:
 * one node kind today (`bones:lumber`) and one left-rail panel (`Bones`).
 * Framing inference kinds (`bones:framing`, …) land next — see SPEC.md.
 */
export const bonesPlugin: Plugin = {
  id: 'pascal:bones',
  apiVersion: 1,
  nodes: [
    framingDefinition as unknown as AnyNodeDefinition,
    lumberDefinition as unknown as AnyNodeDefinition,
  ],
}

export const bonesHostPanel: PluginHostPanel = {
  id: 'pascal:bones:panel',
  label: 'Bones',
  icon: { kind: 'url', src: BONES_ICON },
  component: () => import('./panel'),
  pluginId: bonesPlugin.id,
  description:
    'Alpha access — new and evolving fast. The engineering X-ray for Pascal: see through the finishes to the actual construction — wall framing, floors, roof, foundation, and electrical, derived from your model and sized to your jurisdiction.',
  creator: {
    name: 'Julien Brissonneau',
    url: 'https://github.com/Snoopy147',
  },
  pluginUrl: 'https://github.com/pascalorg/plugin-bones',
  defaultInstalled: true,
}

export { lumberDefinition } from './definition'
export { LumberNode } from './schema'
export { LUMBER_CROSS_SECTIONS, LUMBER_SIZES, lumberBoxDims } from './lumber'

// Headless engine surface. The derivation pipeline is pure (no React, no
// three, no stores) — a host estimator can compute the same members and
// quantities the panel shows, per level, without mounting anything.
// `computeLevelUncached` exists so a multi-level rollup loop doesn't thrash
// the 1-deep render memo that the panel and 3D renderer share.
export {
  computeLevel,
  computeLevelUncached,
  type ComputeResult,
  wallConstruction,
} from './framing/compute'
export { FramingNode } from './framing/schema'
export {
  computeTakeoff,
  cutList,
  cutListCsv,
  takeoffCsv,
  type CutRow,
  type TakeoffAreas,
  type TakeoffRow,
} from './engines/takeoff'
export { extractRoofs } from './engines/roof-framing'
export { extractLevels, type LevelSlice } from './core/wall-model'
export type { BonesSystem, Fixture, FixtureKind, Member, MemberRole } from './core/types'
