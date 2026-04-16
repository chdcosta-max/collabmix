import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import CollabMix from './collabmix-production.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <CollabMix initialPage="landing" />
  </StrictMode>,
)
