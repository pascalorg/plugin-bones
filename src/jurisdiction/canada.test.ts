import { describe, expect, it } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import { INCH } from '../core/units'
import { applyJurisdiction, jurisdictionOptions, profileFor } from './profiles'

/**
 * Canada rides the same data path as the US states: two JSON rows merged by
 * `profileFor`, then mapped onto the FramingSpec by `applyJurisdiction`. These
 * tests pin the parts that would silently regress — a missing data row
 * degrades to the INTL fallback rather than throwing, so "it still renders"
 * is not evidence that a province actually landed.
 */

const CANADA = [
  'CA-ON-S',
  'CA-ON-E',
  'CA-ON-N',
  'CA-BC',
  'CA-AB',
  'CA-SK',
  'CA-MB',
  'CA-QC',
  'CA-NB',
  'CA-NS',
  'CA-PE',
  'CA-NL',
  'CA-YT',
  'CA-NT',
  'CA-NU',
  'CA-GEN',
] as const

const footingInches = (code: string): number =>
  applyJurisdiction(DEFAULT_SPEC, profileFor(code)).footingDepth / INCH

describe('Canadian jurisdictions', () => {
  it('every province resolves to real data, not the INTL fallback', () => {
    for (const code of CANADA) {
      const p = profileFor(code)
      // The fallback returns `{...INTL_PROFILE, code, name: code}` — so a name
      // equal to the bare code means the data row is missing.
      expect(p.name).not.toBe(code)
      expect(p.name.startsWith('Canada')).toBe(true)
      expect(p.residentialCode).not.toBe('IRC (edition unverified)')
    }
  })

  it('cites the National Building Code, not the IRC', () => {
    expect(profileFor('CA-SK').residentialCode).toContain('National Building Code')
    expect(profileFor('CA-ON-S').residentialCode).toContain('Ontario Building Code')
    expect(profileFor('CA-QC').residentialCode).toContain('2015')
  })

  it('no Canadian code collides with a US state code', () => {
    const codes = jurisdictionOptions().map((o) => o.code)
    expect(new Set(codes).size).toBe(codes.length)
    // The obvious trap: bare 'CA' is California and must stay California.
    expect(profileFor('CA').name).toBe('California')
  })

  it('southern Ontario frames like the GTA: shallow-ish frost, no ties, 2x6 rafters', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-ON-S'))
    expect(footingInches('CA-ON-S')).toBeCloseTo(47, 5)
    expect(spec.hurricaneTies).toBe(false)
    expect(spec.seismicHoldDowns).toBe(false)
    expect(spec.rafterSize).toBe(DEFAULT_SPEC.rafterSize)
  })

  it('the Ottawa Valley digs deeper and bumps the rafter for snow', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-ON-E'))
    expect(footingInches('CA-ON-E')).toBeCloseTo(71, 5)
    expect(spec.rafterSize).toBe('2x8')
  })

  it('prairie frost depths exceed every US state', () => {
    // The reason Canada needed real rows instead of a US proxy: the deepest
    // US frost line in the data is 60in, and Saskatchewan runs deeper.
    expect(footingInches('CA-SK')).toBeCloseTo(84, 5)
    expect(footingInches('CA-MB')).toBeCloseTo(78, 5)
    expect(footingInches('CA-SK')).toBeGreaterThan(footingInches('ND'))
  })

  it('coastal BC turns on seismic hold-downs and tightens anchor bolts', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-BC'))
    expect(spec.seismicHoldDowns).toBe(true)
    expect(spec.anchorBoltSpacing).toBeCloseTo(4 * 12 * INCH, 5)
  })

  it('Atlantic Canada gets uplift ties, the interior does not', () => {
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-NS')).hurricaneTies).toBe(true)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-NL')).hurricaneTies).toBe(true)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-SK')).hurricaneTies).toBe(false)
  })

  it('exterior walls stay framed everywhere in Canada', () => {
    for (const code of CANADA) {
      expect(profileFor(code).exteriorWallDefault).toBe('framed')
    }
  })

  it('permafrost territories carry an explicit warning in their notes', () => {
    for (const code of ['CA-YT', 'CA-NT', 'CA-NU']) {
      expect(profileFor(code).notes.join(' ')).toContain('PERMAFROST')
    }
  })

  it('the dropdown still leads with INTL and now carries Canada', () => {
    const options = jurisdictionOptions()
    expect(options[0]?.code).toBe('INTL')
    expect(options.filter((o) => o.code.startsWith('CA-')).length).toBe(CANADA.length)
  })
})
