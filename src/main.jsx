import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import CollabMix from './collabmix-production.jsx'

function Root() {
  const params = new URLSearchParams(window.location.search);
  const hasRoomParam = params.has("room");
  return <CollabMix initialPage={hasRoomParam ? "lobby" : "landing"} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
