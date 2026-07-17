import { render } from 'preact'
import { App, TABS } from './App'
import { setVscode, activeTab, isRestrictedBlockedTab } from './state'
import { parseEmbedParams } from '../../src/shared/embedParams'

import './styles/base.css'
import './styles/toolbar.css'
import './styles/tabs.css'
import './styles/components.css'
import './styles/waterfall.css'
import './styles/summaries.css'
import './styles/heatmap.css'
import './styles/export.css'
import './styles/help.css'
import './styles/tooltip.css'
import './styles/insights.css'
import './styles/graph.css'

const vscode = window.acquireVsCodeApi()
setVscode(vscode)

// TRDD-FMIZO8Y4 — the ai-maestro embed contract: ?tab=<id> deep-links a validated initial tab,
// ?embed=1 marks the body so VS-Code-era chrome (the sidebar toggle) hides inside a host iframe.
// Parsed ONCE before render so the first paint already lands on the requested view.
// TRDD-1ZH1D5EG — a restricted viewer cannot deep-link into Import (its tab button is hidden,
// so an activeTab of 'import' would strand them on a view whose only action 403s).
const embedParams = parseEmbedParams(
  window.location.search,
  TABS.map(t => t.id).filter(id => !isRestrictedBlockedTab(id)))
if (embedParams.tab) activeTab.value = embedParams.tab
if (embedParams.embed) document.body.classList.add('embedded')

render(<App />, document.getElementById('app')!)
