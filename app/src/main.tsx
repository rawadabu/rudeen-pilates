import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initNativePush, registerSW } from './lib/push'
import './styles.css'

registerSW()
initNativePush()
createRoot(document.getElementById('root')!).render(<App />)
