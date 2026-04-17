import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Landing from './App.jsx'
import CollabMix from './collabmix-production.jsx'

function Root() {
  const [djName, setDjName] = useState(null)
  if (djName !== null) return <CollabMix initialPage="lobby" djName={djName} />
  return <Landing onLaunch={() => setDjName("")} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
