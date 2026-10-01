import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { useEffect, useState } from 'react'
import { AdminApp } from './admin/AdminApp'
import { ClientApp } from './client/ClientApp'
import { C } from './lib/theme'

/** Native only: the headers paint under the status bar, so the glyph colour
 *  follows the route — light on the ink admin header, dark on cream. */
function syncStatusBar(isAdmin: boolean) {
  if (!Capacitor.isNativePlatform()) return
  StatusBar.setStyle({ style: isAdmin ? Style.Dark : Style.Light }).catch(() => {})
  if (Capacitor.getPlatform() === 'android') {
    StatusBar.setBackgroundColor({ color: isAdmin ? C.ink : C.bg }).catch(() => {})
  }
}

export function App() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const isAdmin = hash.startsWith('#/admin')
  useEffect(() => syncStatusBar(isAdmin), [isAdmin])
  return isAdmin ? <AdminApp /> : <ClientApp />
}
