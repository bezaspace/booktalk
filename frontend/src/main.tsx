import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Note: no StrictMode — it double-invokes effects, which would double-open
// AudioContexts and double-load the PDF on mount. Lazy init + cleanup handle
// correctness; StrictMode's dev-only double-mount adds no value here.
createRoot(document.getElementById('root')!).render(<App />)
