import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import App from './App.tsx'
import { LibraryAccess, TranslationSession } from './components/library/LibraryAccess'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraryAccess>
      <TranslationSession />
      <App />
    </LibraryAccess>
  </StrictMode>,
)
