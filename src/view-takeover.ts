/**
 * Wall-mode takeover for the X-ray: while the user is LOOKING at the Bones
 * panel, hide the host's wall shells ('down') so the skeleton and Bones' own
 * assembly layers read as the walls; put everything back when they leave.
 *
 * Owned by the PANEL, not the renderer. The renderer lives as long as the
 * `bones:framing` node does, so a renderer-owned takeover kept the host's
 * walls hidden after the user switched sidebar tabs — and, because wallMode
 * is a persisted viewer preference, the "stuck" state survived reloads and
 * even fired on merely opening a scene that contained an X-ray node. The
 * panel unmounts exactly when the user leaves, which is the lifetime this
 * intent actually has.
 *
 * Kept free of viewer imports so the state machine tests headlessly; the
 * panel passes `() => useViewer.getState()`.
 */

export type WallModeViewer = {
  wallMode?: string
  setWallMode?: (mode: string) => void
}

export type WallModeTakeover = {
  engage: () => void
  release: () => void
}

export function createWallModeTakeover(getViewer: () => WallModeViewer): WallModeTakeover {
  let previous: string | undefined
  let active = false
  return {
    engage() {
      if (active) return
      const viewer = getViewer()
      // Already 'down' (user preference) — take no ownership, restore nothing.
      if (!viewer.setWallMode || viewer.wallMode === 'down') return
      previous = viewer.wallMode
      active = true
      viewer.setWallMode('down')
    },
    release() {
      if (!active) return
      active = false
      const viewer = getViewer()
      // Don't stomp a mode the user picked while the panel was open.
      if (viewer.wallMode === 'down' && previous && viewer.setWallMode) {
        viewer.setWallMode(previous)
      }
      previous = undefined
    },
  }
}
