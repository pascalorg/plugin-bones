import { describe, expect, it } from 'bun:test'
import { createWallModeTakeover, type WallModeViewer } from './view-takeover'

function fakeViewer(initial = 'full'): WallModeViewer & { log: string[] } {
  const viewer = {
    wallMode: initial,
    log: [] as string[],
    setWallMode(mode: string) {
      viewer.wallMode = mode
      viewer.log.push(mode)
    },
  }
  return viewer
}

describe('wall-mode takeover', () => {
  it('hides walls on engage and restores the previous mode on release', () => {
    const viewer = fakeViewer('full')
    const takeover = createWallModeTakeover(() => viewer)
    takeover.engage()
    expect(viewer.wallMode).toBe('down')
    takeover.release()
    expect(viewer.wallMode).toBe('full')
    expect(viewer.log).toEqual(['down', 'full'])
  })

  it('takes no ownership when the user already had walls down', () => {
    const viewer = fakeViewer('down')
    const takeover = createWallModeTakeover(() => viewer)
    takeover.engage()
    takeover.release()
    // Never toggled: the 'down' was the user's own preference.
    expect(viewer.log).toEqual([])
    expect(viewer.wallMode).toBe('down')
  })

  it('does not stomp a mode the user picked while engaged', () => {
    const viewer = fakeViewer('full')
    const takeover = createWallModeTakeover(() => viewer)
    takeover.engage()
    viewer.setWallMode?.('cutaway') // user changed it manually
    takeover.release()
    expect(viewer.wallMode).toBe('cutaway')
  })

  it('is idempotent: double engage keeps the ORIGINAL previous mode', () => {
    const viewer = fakeViewer('cutaway')
    const takeover = createWallModeTakeover(() => viewer)
    takeover.engage()
    takeover.engage()
    takeover.release()
    expect(viewer.wallMode).toBe('cutaway')
  })

  it('release without engage is a no-op', () => {
    const viewer = fakeViewer('full')
    const takeover = createWallModeTakeover(() => viewer)
    takeover.release()
    expect(viewer.log).toEqual([])
  })

  it('survives a viewer with no setter', () => {
    const takeover = createWallModeTakeover(() => ({}))
    takeover.engage()
    takeover.release()
  })
})
