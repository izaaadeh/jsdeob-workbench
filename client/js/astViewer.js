/**
 * Enhanced AST Viewer Module - Comprehensive AST visualization
 */

const ASTViewer = {
  ast: null,
  inputAst: null,
  outputAst: null,
  currentSource: 'input', // 'input' or 'output'
  isDiffMode: false,
  selectedNode: null,
  expandedNodes: new Set(),
  nodeMap: new Map(),
  nodeIdCounter: 0,
  inputLiveSync: true, // When true, Input AST syncs with cursor (ON by default)
  outputLiveSync: true, // When true, Output AST syncs with cursor (ON by default)
  autoSwitch: true, // When true, auto-switch AST tab when editor is focused
  _syncingFromCursor: false, // Flag to prevent cursor feedback loop
  
  // Performance limits
  MAX_RENDER_NODES: 5000, // Max nodes to render before showing warning
  MAX_RENDER_DEPTH: 50, // Max depth to render (reduced for deeply nested code)
  _renderNodeCount: 0, // Counter during render
  _renderLimitHit: false, // Flag when limit is hit
  
  // Lazy loading configuration
  lazyLoadEnabled: true, // When true, only render visible nodes on demand
  lazyLoadDepth: 3, // Depth to pre-render (nodes deeper than this load on expand)
  lazyLoadThreshold: 1000, // Node count threshold to trigger lazy mode
  _lazyNodeData: new Map(), // Store unrendered node data for lazy loading
  _lazyModeActive: false, // Flag when lazy mode is in effect
  
  // ===== OPTIMIZATION: Spatial index for fast position lookup =====
  _lineIndex: null, // Map<lineNumber, Array<{nodeId, startCol, endCol, endLine}>>
  _nodesByLine: null, // Quick lookup by line number
  _positionCacheEnabled: true,
  _lastHighlightLine: -1, // Debounce rapid cursor moves
  _highlightDebounceTimer: null,
  
  // Search state
  searchMatches: [],
  currentMatchIndex: -1,
  
  // Properties to show inline with the node type (primitives only)
  inlineProps: new Set([
    'name', 'raw', 'operator', 'kind', 'computed', 
    'async', 'generator', 'static', 'method', 'shorthand',
    'prefix', 'delegate', 'await', 'optional', 'definite'
  ]),
  
  // Skip these properties entirely (metadata)
  skipProps: new Set([
    'type', 'start', 'end', 'loc', 'range', 'extra',
    'tokens', 'errors', 'directives'
  ]),
  
  // Debounce timer for live parsing
  _parseDebounceTimer: null,
  _parseDebounceDelay: 300, // ms delay before re-parsing

  /**
   * Initialize AST viewer
   */
  init() {
    this.setupEventListeners();
    this.setupSearchListeners();
    this.setupSettingsUI();
    this.loadSettings();
    
    // Initialize sync button states (sync is ON by default)
    const inputSyncBtn = document.getElementById('btn-sync-input-ast');
    const outputSyncBtn = document.getElementById('btn-sync-output-ast');
    
    if (inputSyncBtn) {
      inputSyncBtn.classList.add('active');
      inputSyncBtn.title = 'Input AST Sync ON - Click to disable';
    }
    if (outputSyncBtn) {
      outputSyncBtn.classList.add('active');
      outputSyncBtn.title = 'Output AST Sync ON - Click to disable';
    }
    
    // Parse initial input code if any
    setTimeout(() => {
      const inputCode = EditorManager.getInput();
      if (inputCode && inputCode.trim()) {
        this.updateFromCode(inputCode);
      }
    }, 500);
  },
  
  /**
   * Setup search event listeners
   */
  setupSearchListeners() {
    const searchInput = document.getElementById('ast-search-input');
    if (!searchInput) return;
    
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.performSearch(e.target.value);
      }, 150);
    });
    
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          this.navigateSearch(-1); // Previous
        } else {
          this.navigateSearch(1); // Next
        }
        e.preventDefault();
      } else if (e.key === 'Escape') {
        searchInput.value = '';
        this.clearSearch();
      }
    });
  },
  
  /**
   * Perform search in AST nodes
   */
  performSearch(query) {
    this.clearSearch();
    
    if (!query || query.length < 2) {
      document.getElementById('ast-search-results').textContent = '';
      return;
    }
    
    const queryLower = query.toLowerCase();
    const container = document.getElementById('ast-tree');
    const allHeaders = container.querySelectorAll('.ast-node-header');
    
    allHeaders.forEach(header => {
      const text = header.textContent.toLowerCase();
      if (text.includes(queryLower)) {
        this.searchMatches.push(header);
        header.classList.add('search-match');
        
        // Expand all parent nodes to make match visible
        let parent = header.closest('.ast-node');
        while (parent) {
          if (parent.classList.contains('collapsed')) {
            parent.classList.remove('collapsed');
            const nodeId = parent.dataset.nodeId;
            if (nodeId) this.expandedNodes.add(nodeId);
          }
          parent = parent.parentElement?.closest('.ast-node');
        }
      }
    });
    
    const resultsSpan = document.getElementById('ast-search-results');
    if (this.searchMatches.length > 0) {
      this.currentMatchIndex = 0;
      this.highlightCurrentMatch();
      resultsSpan.textContent = `1/${this.searchMatches.length}`;
    } else {
      resultsSpan.textContent = 'No matches';
    }
  },
  
  /**
   * Navigate through search results
   */
  navigateSearch(direction) {
    if (this.searchMatches.length === 0) return;
    
    this.currentMatchIndex += direction;
    if (this.currentMatchIndex >= this.searchMatches.length) {
      this.currentMatchIndex = 0;
    } else if (this.currentMatchIndex < 0) {
      this.currentMatchIndex = this.searchMatches.length - 1;
    }
    
    this.highlightCurrentMatch();
    document.getElementById('ast-search-results').textContent = 
      `${this.currentMatchIndex + 1}/${this.searchMatches.length}`;
  },
  
  /**
   * Highlight current search match
   */
  highlightCurrentMatch() {
    this.searchMatches.forEach((m, i) => {
      m.classList.toggle('search-current', i === this.currentMatchIndex);
    });
    
    if (this.searchMatches[this.currentMatchIndex]) {
      this.searchMatches[this.currentMatchIndex].scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center' 
      });
    }
  },
  
  /**
   * Clear search highlighting
   */
  clearSearch() {
    this.searchMatches.forEach(m => {
      m.classList.remove('search-match', 'search-current');
    });
    this.searchMatches = [];
    this.currentMatchIndex = -1;
  },
  
  /**
   * Load settings from localStorage
   */
  loadSettings() {
    try {
      const saved = localStorage.getItem('ast-viewer-settings');
      if (saved) {
        const settings = JSON.parse(saved);
        if (typeof settings.lazyLoadEnabled === 'boolean') this.lazyLoadEnabled = settings.lazyLoadEnabled;
        if (typeof settings.lazyLoadDepth === 'number') this.lazyLoadDepth = settings.lazyLoadDepth;
        if (typeof settings.lazyLoadThreshold === 'number') this.lazyLoadThreshold = settings.lazyLoadThreshold;
        if (typeof settings.MAX_RENDER_NODES === 'number') this.MAX_RENDER_NODES = settings.MAX_RENDER_NODES;
        if (typeof settings.MAX_RENDER_DEPTH === 'number') this.MAX_RENDER_DEPTH = settings.MAX_RENDER_DEPTH;
      }
    } catch (e) {
      console.warn('Failed to load AST viewer settings:', e);
    }
    this.updateSettingsUI();
  },
  
  /**
   * Save settings to localStorage
   */
  saveSettings() {
    try {
      const settings = {
        lazyLoadEnabled: this.lazyLoadEnabled,
        lazyLoadDepth: this.lazyLoadDepth,
        lazyLoadThreshold: this.lazyLoadThreshold,
        MAX_RENDER_NODES: this.MAX_RENDER_NODES,
        MAX_RENDER_DEPTH: this.MAX_RENDER_DEPTH
      };
      localStorage.setItem('ast-viewer-settings', JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save AST viewer settings:', e);
    }
  },
  
  /**
   * Update settings UI to reflect current values
   */
  updateSettingsUI() {
    const lazyToggle = document.getElementById('ast-lazy-toggle');
    const depthInput = document.getElementById('ast-lazy-depth');
    const thresholdInput = document.getElementById('ast-lazy-threshold');
    const maxNodesInput = document.getElementById('ast-max-nodes');
    const maxDepthInput = document.getElementById('ast-max-depth');
    
    if (lazyToggle) lazyToggle.checked = this.lazyLoadEnabled;
    if (depthInput) depthInput.value = this.lazyLoadDepth;
    if (thresholdInput) thresholdInput.value = this.lazyLoadThreshold;
    if (maxNodesInput) maxNodesInput.value = this.MAX_RENDER_NODES;
    if (maxDepthInput) maxDepthInput.value = this.MAX_RENDER_DEPTH;
  },
  
  /**
   * Setup settings UI panel
   */
  setupSettingsUI() {
    // Create settings button if not exists
    const toolActions = document.querySelector('#tool-ast .tool-actions');
    if (!toolActions || document.getElementById('btn-ast-settings')) return;
    
    // Create settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'btn-ast-settings';
    settingsBtn.className = 'btn btn-icon btn-tiny';
    settingsBtn.title = 'AST Viewer Settings';
    settingsBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    `;
    toolActions.insertBefore(settingsBtn, toolActions.firstChild);
    
    // Create settings dropdown
    const dropdown = document.createElement('div');
    dropdown.id = 'ast-settings-dropdown';
    dropdown.className = 'ast-settings-dropdown';
    dropdown.innerHTML = `
      <div class="ast-settings-header">AST Viewer Settings</div>
      <div class="ast-settings-content">
        <div class="ast-settings-group">
          <label class="ast-settings-label">
            <input type="checkbox" id="ast-lazy-toggle" ${this.lazyLoadEnabled ? 'checked' : ''}>
            <span>Lazy Loading</span>
          </label>
          <div class="ast-settings-hint">Only render nodes on demand when expanded</div>
        </div>
        
        <div class="ast-settings-group">
          <label class="ast-settings-label">Initial Render Depth</label>
          <input type="number" id="ast-lazy-depth" min="1" max="20" value="${this.lazyLoadDepth}" class="ast-settings-input">
          <div class="ast-settings-hint">Nodes deeper than this are loaded on click</div>
        </div>
        
        <div class="ast-settings-group">
          <label class="ast-settings-label">Lazy Mode Threshold</label>
          <input type="number" id="ast-lazy-threshold" min="100" max="10000" step="100" value="${this.lazyLoadThreshold}" class="ast-settings-input">
          <div class="ast-settings-hint">Enable lazy mode when node count exceeds this</div>
        </div>
        
        <div class="ast-settings-divider"></div>
        
        <div class="ast-settings-group">
          <label class="ast-settings-label">Max Render Nodes</label>
          <input type="number" id="ast-max-nodes" min="500" max="50000" step="500" value="${this.MAX_RENDER_NODES}" class="ast-settings-input">
          <div class="ast-settings-hint">Stop rendering after this many nodes</div>
        </div>
        
        <div class="ast-settings-group">
          <label class="ast-settings-label">Max Render Depth</label>
          <input type="number" id="ast-max-depth" min="10" max="200" value="${this.MAX_RENDER_DEPTH}" class="ast-settings-input">
          <div class="ast-settings-hint">Maximum nesting depth to render</div>
        </div>
        
        <div class="ast-settings-actions">
          <button class="btn btn-small btn-secondary" id="ast-settings-reset">Reset Defaults</button>
        </div>
      </div>
    `;
    toolActions.appendChild(dropdown);
    
    // Toggle dropdown
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('visible');
    });
    
    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== settingsBtn) {
        dropdown.classList.remove('visible');
      }
    });
    
    // Settings change handlers
    document.getElementById('ast-lazy-toggle')?.addEventListener('change', (e) => {
      this.lazyLoadEnabled = e.target.checked;
      this.saveSettings();
      this.render(); // Re-render with new setting
    });
    
    document.getElementById('ast-lazy-depth')?.addEventListener('change', (e) => {
      this.lazyLoadDepth = Math.max(1, Math.min(20, parseInt(e.target.value) || 3));
      e.target.value = this.lazyLoadDepth;
      this.saveSettings();
    });
    
    document.getElementById('ast-lazy-threshold')?.addEventListener('change', (e) => {
      this.lazyLoadThreshold = Math.max(100, Math.min(10000, parseInt(e.target.value) || 1000));
      e.target.value = this.lazyLoadThreshold;
      this.saveSettings();
    });
    
    document.getElementById('ast-max-nodes')?.addEventListener('change', (e) => {
      this.MAX_RENDER_NODES = Math.max(500, Math.min(50000, parseInt(e.target.value) || 5000));
      e.target.value = this.MAX_RENDER_NODES;
      this.saveSettings();
    });
    
    document.getElementById('ast-max-depth')?.addEventListener('change', (e) => {
      this.MAX_RENDER_DEPTH = Math.max(10, Math.min(200, parseInt(e.target.value) || 50));
      e.target.value = this.MAX_RENDER_DEPTH;
      this.saveSettings();
    });
    
    document.getElementById('ast-settings-reset')?.addEventListener('click', () => {
      this.lazyLoadEnabled = true;
      this.lazyLoadDepth = 3;
      this.lazyLoadThreshold = 1000;
      this.MAX_RENDER_NODES = 5000;
      this.MAX_RENDER_DEPTH = 50;
      this.updateSettingsUI();
      this.saveSettings();
      this.render();
    });
  },
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    document.getElementById('btn-expand-ast')?.addEventListener('click', () => {
      this.expandAll();
    });
    
    document.getElementById('btn-collapse-ast')?.addEventListener('click', () => {
      this.collapseAll();
    });
    
    document.getElementById('btn-copy-ast-tree')?.addEventListener('click', () => {
      this.copyFullTree();
    });
    
    document.getElementById('btn-refresh-ast')?.addEventListener('click', () => {
      if (this.currentSource === 'input') {
        this.updateFromCode(EditorManager.getInput());
      } else {
        this.updateOutputAST(EditorManager.getOutput());
      }
      App.log('AST refreshed', 'info');
    });
    
    // Input sync toggle button
    document.getElementById('btn-sync-input-ast')?.addEventListener('click', () => {
      this.toggleInputSync();
    });
    
    // Output sync toggle button  
    document.getElementById('btn-sync-output-ast')?.addEventListener('click', () => {
      this.toggleOutputSync();
    });
    
    // Cursor sync - check which sync is enabled
    window.addEventListener('cursor-changed', (e) => {
      if (e.detail.editor === 'input' && this.inputLiveSync && this.currentSource === 'input') {
        this.highlightNodeAtPosition(e.detail.position);
      } else if (e.detail.editor === 'output' && this.outputLiveSync && this.currentSource === 'output') {
        this.highlightNodeAtPosition(e.detail.position);
      }
    });
    
    // Auto-switch AST tab when editor is focused
    window.addEventListener('editor-focused', (e) => {
      if (e.detail.editor !== this.currentSource) {
        this.switchSource(e.detail.editor);
      }
    });
    
    // Live AST parsing - update AST as user types (debounced)
    window.addEventListener('input-changed', (e) => {
      // Skip parsing for very large files to prevent hanging
      const code = e.detail.code || '';
      if (code.length > 500000) {
        // For very large files, don't auto-parse
        return;
      }
      
      // Check for deeply nested code that could crash the server
      let maxNesting = 0, currentNesting = 0;
      for (let i = 0; i < Math.min(code.length, 50000); i++) {
        const c = code[i];
        if (c === '[' || c === '(' || c === '{') {
          currentNesting++;
          if (currentNesting > maxNesting) maxNesting = currentNesting;
        } else if (c === ']' || c === ')' || c === '}') {
          currentNesting--;
        }
      }
      if (maxNesting > 200) {
        // Code is too deeply nested, skip auto-parse
        console.warn('Skipping auto-parse: code has deep nesting (' + maxNesting + ' levels)');
        return;
      }
      
      // Only update if input sync is enabled and we're viewing input AST
      if (this.inputLiveSync && this.currentSource === 'input') {
        clearTimeout(this._parseDebounceTimer);
        // Use longer delay for larger files
        const delay = code.length > 100000 ? 800 : this._parseDebounceDelay;
        this._parseDebounceTimer = setTimeout(() => {
          this.updateFromCode(code);
        }, delay);
      }
    });
    
    // AST source tab switching
    document.querySelectorAll('.ast-source-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchSource(tab.dataset.source);
      });
    });
    
    // AST panel resize handler
    this.setupAstResize();
  },
  
  /**
   * Setup AST tree/details resize handler
   */
  setupAstResize() {
    const resizeHandle = document.getElementById('ast-resize-handle');
    const astTree = document.getElementById('ast-tree');
    const astDetails = document.getElementById('ast-details');
    const toolPane = document.getElementById('tool-ast');
    
    if (!resizeHandle || !astTree || !astDetails || !toolPane) return;
    
    let isResizing = false;
    let startY = 0;
    let startDetailsHeight = 0;
    
    resizeHandle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only left mouse button
      
      isResizing = true;
      startY = e.clientY;
      startDetailsHeight = astDetails.offsetHeight;
      
      // Add overlay to prevent text selection during resize
      const overlay = document.createElement('div');
      overlay.id = 'ast-resize-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:ns-resize;';
      document.body.appendChild(overlay);
      
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      
      const deltaY = startY - e.clientY;
      const newHeight = Math.max(80, Math.min(startDetailsHeight + deltaY, toolPane.offsetHeight - 150));
      
      astDetails.style.height = newHeight + 'px';
    });
    
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        document.getElementById('ast-resize-overlay')?.remove();
      }
    });
  },
  
  /**
   * Set diff mode - show/hide source tabs and update ASTs
   */
  async setDiffMode(enabled, inputCode, outputCode) {
    this.isDiffMode = enabled;
    const tabsContainer = document.getElementById('ast-source-tabs');
    
    if (enabled) {
      // Show tabs
      tabsContainer?.classList.add('visible');
      
      // Parse both ASTs and wait for completion
      await Promise.all([
        this.parseAndStoreAST(inputCode, 'input'),
        this.parseAndStoreAST(outputCode, 'output')
      ]);
      
      // Show input AST by default (now that parsing is complete)
      this.switchSource('input');
    } else {
      // Hide tabs
      tabsContainer?.classList.remove('visible');
      this.currentSource = 'input';
      this.outputAst = null;
      
      // Update tab UI
      document.querySelectorAll('.ast-source-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.source === 'input');
      });
      
      // Re-render with input AST
      if (this.inputAst) {
        this.ast = this.inputAst;
        this.render();
      }
    }
  },
  
  /**
   * Parse code and store AST for a specific source
   */
  async parseAndStoreAST(code, source) {
    if (!code || !code.trim()) {
      if (source === 'input') {
        this.inputAst = null;
      } else {
        this.outputAst = null;
      }
      return;
    }
    
    try {
      const response = await fetch('/api/transform/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      
      const data = await response.json();
      
      if (data.success && data.ast) {
        if (source === 'input') {
          this.inputAst = data.ast;
        } else {
          this.outputAst = data.ast;
        }
        
        // If this is the current source, render it
        if (this.currentSource === source) {
          this.ast = data.ast;
          this.render();
        }
      }
    } catch (error) {
      console.error(`Error parsing ${source} AST:`, error);
    }
  },
  
  /**
   * Switch between input and output AST
   */
  async switchSource(source) {
    this.currentSource = source;
    
    // Update tab UI
    document.querySelectorAll('.ast-source-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === source);
    });
    
    // Switch to the appropriate AST
    if (source === 'input') {
      this.ast = this.inputAst;
    } else {
      // If output AST is not cached, parse the current output code
      if (!this.outputAst) {
        const outputCode = EditorManager.getOutput();
        if (outputCode && outputCode.trim()) {
          await this.parseAndStoreAST(outputCode, 'output');
        }
      }
      this.ast = this.outputAst;
    }
    
    // Clear selection and re-render
    this.selectedNode = null;
    this.expandedNodes.clear();
    this.render();
  },
  
  /**
   * Update AST from code (for input code changes)
   */
  async updateFromCode(code) {
    if (!code || !code.trim()) {
      this.clear();
      return;
    }
    
    try {
      const result = await API.parse(code);
      if (result.success) {
        this.ast = result.ast;
        this.inputAst = result.ast; // Also cache as input AST
        this.render();
      }
    } catch (error) {
      console.error('Failed to parse AST:', error);
      this.showError(error.message);
    }
  },
  
  /**
   * Update output AST (called when transforms complete)
   */
  async updateOutputAST(code) {
    if (!code || !code.trim()) {
      this.outputAst = null;
      return;
    }
    
    try {
      const response = await fetch('/api/transform/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      
      const data = await response.json();
      
      if (data.success && data.ast) {
        this.outputAst = data.ast;
        
        // Auto-switch to output when transforms complete and re-render
        this.currentSource = 'output';
        this.ast = this.outputAst;
        
        // Update tab UI to reflect output is now selected
        document.querySelectorAll('.ast-source-tab').forEach(tab => {
          tab.classList.toggle('active', tab.dataset.source === 'output');
        });
        
        this.render();
      }
    } catch (error) {
      console.error('Error parsing output AST:', error);
    }
  },
  
  /**
   * Count total nodes in an AST (quick estimation)
   */
  countNodes(node, count = 0, maxCount = 10000) {
    if (count > maxCount) return count; // Early exit
    if (!node || typeof node !== 'object') return count;
    
    if (Array.isArray(node)) {
      for (const item of node) {
        count = this.countNodes(item, count + 1, maxCount);
        if (count > maxCount) return count;
      }
      return count;
    }
    
    count++;
    for (const key of Object.keys(node)) {
      if (this.skipProps.has(key)) continue;
      count = this.countNodes(node[key], count, maxCount);
      if (count > maxCount) return count;
    }
    return count;
  },
  
  /**
   * Build spatial index for fast position lookups
   * Groups nodes by their starting line for O(1) line lookup + O(n) scan within line
   */
  buildPositionIndex() {
    this._lineIndex = new Map();
    this._nodesByLine = new Map();
    
    for (const [nodeId, data] of this.nodeMap.entries()) {
      const node = data.node;
      if (!node || !node.loc) continue;
      
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;
      const size = (endLine - startLine) * 10000 + (node.loc.end.column - node.loc.start.column);
      
      // Index by starting line
      if (!this._lineIndex.has(startLine)) {
        this._lineIndex.set(startLine, []);
      }
      this._lineIndex.get(startLine).push({
        nodeId,
        startCol: node.loc.start.column,
        endLine: endLine,
        endCol: node.loc.end.column,
        size
      });
      
      // Also index multi-line nodes by each line they span (store with size for sorting)
      for (let line = startLine; line <= endLine; line++) {
        if (!this._nodesByLine.has(line)) {
          this._nodesByLine.set(line, []);
        }
        this._nodesByLine.get(line).push({ nodeId, size });
      }
    }
    
    // Sort each line's nodes by size (smallest first = most specific)
    for (const [line, nodes] of this._lineIndex.entries()) {
      nodes.sort((a, b) => a.size - b.size);
    }
    
    // Sort _nodesByLine by size too
    for (const [line, entries] of this._nodesByLine.entries()) {
      entries.sort((a, b) => a.size - b.size);
    }
  },
  
  /**
   * Build spatial index for lazy nodes (unrendered nodes)
   */
  buildLazyPositionIndex() {
    this._lazyLineIndex = new Map();
    
    for (const [nodeId, data] of this._lazyNodeData.entries()) {
      const node = data.node;
      if (!node || !node.loc) continue;
      
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;
      
      // Index lazy nodes by all lines they span
      for (let line = startLine; line <= endLine; line++) {
        if (!this._lazyLineIndex.has(line)) {
          this._lazyLineIndex.set(line, []);
        }
        this._lazyLineIndex.get(line).push({
          nodeId,
          startLine,
          startCol: node.loc.start.column,
          endLine,
          endCol: node.loc.end.column
        });
      }
    }
  },
  
  /**
   * Render the AST tree
   */
  render() {
    const container = document.getElementById('ast-tree');
    if (!container || !this.ast) {
      if (container) {
        container.innerHTML = '<div class="ast-empty">Parse code to view AST</div>';
      }
      return;
    }
    
    // Reset render counters and lazy data
    this._renderNodeCount = 0;
    this._renderLimitHit = false;
    this._lazyNodeData.clear();
    this._lineIndex = null;
    this._nodesByLine = null;
    
    // Quick node count check
    const nodeCount = this.countNodes(this.ast, 0, this.MAX_RENDER_NODES + 1);
    
    // Determine if we should use lazy mode
    this._lazyModeActive = this.lazyLoadEnabled && nodeCount > this.lazyLoadThreshold;
    
    if (nodeCount > this.MAX_RENDER_NODES && !this._lazyModeActive) {
      container.innerHTML = `
        <div class="ast-warning">
          <div class="ast-warning-icon">⚠️</div>
          <div class="ast-warning-title">AST Too Complex</div>
          <div class="ast-warning-message">
            This code creates an extremely large AST (${nodeCount.toLocaleString()}+ nodes).
            <br>Rendering is disabled to prevent browser freezing.
          </div>
          <div class="ast-warning-tips">
            <strong>This often happens with:</strong>
            <ul>
              <li>JSFuck-style obfuscation (using []!+() patterns)</li>
              <li>Heavily nested expressions</li>
              <li>Minified code with long expression chains</li>
            </ul>
          </div>
          <div class="ast-warning-actions">
            <button class="btn btn-secondary btn-small" onclick="ASTViewer.forceRender()">
              Render Anyway (may freeze browser)
            </button>
            <button class="btn btn-primary btn-small" onclick="ASTViewer.enableLazyAndRender()">
              Enable Lazy Loading & Render
            </button>
          </div>
        </div>
      `;
      return;
    }
    
    this.nodeMap.clear();
    this.nodeIdCounter = 0;
    this._truncatedNodeData = new Map(); // Clear truncated node data
    
    container.innerHTML = this.renderNode(this.ast, null, 'root', 0);
    
    // Build spatial index after rendering (async to not block)
    requestAnimationFrame(() => {
      this.buildPositionIndex();
      if (this._lazyModeActive) {
        this.buildLazyPositionIndex();
      }
    });
    
    // Show mode indicator
    if (this._lazyModeActive) {
      const indicator = document.createElement('div');
      indicator.className = 'ast-lazy-indicator';
      indicator.innerHTML = `🔄 Lazy mode active (${nodeCount.toLocaleString()} nodes) - Click nodes to expand`;
      container.insertBefore(indicator, container.firstChild);
    }
    
    // Show truncation warning if limit was hit during render
    if (this._renderLimitHit) {
      const warning = document.createElement('div');
      warning.className = 'ast-truncated-warning';
      warning.innerHTML = `⚠️ AST truncated at ${this.MAX_RENDER_NODES} nodes. Deep nodes are hidden.`;
      container.insertBefore(warning, container.firstChild);
    }
    
    this.attachNodeListeners();
  },
  
  /**
   * Enable lazy loading and re-render
   */
  enableLazyAndRender() {
    this.lazyLoadEnabled = true;
    this._lazyModeActive = true;
    this.saveSettings();
    this.updateSettingsUI();
    this.render();
  },
  
  /**
   * Force render even if AST is too large (user requested)
   */
  forceRender() {
    const container = document.getElementById('ast-tree');
    if (!container || !this.ast) return;
    
    // Temporarily increase limit
    const oldLimit = this.MAX_RENDER_NODES;
    this.MAX_RENDER_NODES = 50000;
    this._renderNodeCount = 0;
    this._renderLimitHit = false;
    this._lazyModeActive = false; // Force render disables lazy mode
    
    this.nodeMap.clear();
    this.nodeIdCounter = 0;
    this._truncatedNodeData = new Map(); // Clear truncated node data
    
    container.innerHTML = '<div class="ast-loading">Rendering large AST... (this may take a while)</div>';
    
    // Use setTimeout to allow UI to update
    setTimeout(() => {
      try {
        container.innerHTML = this.renderNode(this.ast, null, 'root', 0);
        this.attachNodeListeners();
        
        // Build position index for fast lookups
        this.buildPositionIndex();
        
        if (this._renderLimitHit) {
          const warning = document.createElement('div');
          warning.className = 'ast-truncated-warning';
          warning.innerHTML = `⚠️ AST truncated. Showing first ${this.MAX_RENDER_NODES} nodes. <span class="ast-truncated-hint">Click truncated placeholders to load more.</span>`;
          container.insertBefore(warning, container.firstChild);
        }
      } catch (e) {
        container.innerHTML = `<div class="ast-error">Render failed: ${e.message}</div>`;
      }
      
      this.MAX_RENDER_NODES = oldLimit;
    }, 50);
  },
  
  /**
   * Render a single AST node with its property name
   * Uses a depth limit to prevent stack overflow on deeply nested ASTs
   */
  renderNode(node, parent, propName, depth) {
    // Check render limits
    this._renderNodeCount++;
    if (this._renderNodeCount > this.MAX_RENDER_NODES) {
      this._renderLimitHit = true;
      // Store truncated node data for on-demand loading (similar to lazy loading)
      const truncId = `ast-trunc-${this.nodeIdCounter++}`;
      this._truncatedNodeData = this._truncatedNodeData || new Map();
      this._truncatedNodeData.set(truncId, { node, parent, propName, depth });
      return `<div class="ast-truncated" data-trunc-id="${truncId}">... (truncated - click to load)</div>`;
    }
    
    // ALWAYS enforce a hard depth limit to prevent stack overflow
    // This is separate from the configurable MAX_RENDER_DEPTH
    const HARD_DEPTH_LIMIT = 150; // Safe limit to prevent stack overflow
    if (depth > HARD_DEPTH_LIMIT) {
      this._renderLimitHit = true;
      const truncId = `ast-trunc-${this.nodeIdCounter++}`;
      this._truncatedNodeData = this._truncatedNodeData || new Map();
      this._truncatedNodeData.set(truncId, { node, parent, propName, depth: 0 });
      return `<div class="ast-truncated" data-trunc-id="${truncId}">... (depth limit - click to load)</div>`;
    }
    
    // Configurable depth limit (only when lazy loading is enabled)
    if (this.lazyLoadEnabled && depth > this.MAX_RENDER_DEPTH) {
      this._renderLimitHit = true;
      const truncId = `ast-trunc-${this.nodeIdCounter++}`;
      this._truncatedNodeData = this._truncatedNodeData || new Map();
      this._truncatedNodeData.set(truncId, { node, parent, propName, depth: 0 }); // Reset depth for rendering
      return `<div class="ast-truncated" data-trunc-id="${truncId}">... (max depth - click to load)</div>`;
    }
    
    if (node === null || node === undefined) {
      return this.renderPrimitive(propName, node, depth);
    }
    
    if (Array.isArray(node)) {
      return this.renderArray(node, propName, depth);
    }
    
    if (typeof node !== 'object') {
      return this.renderPrimitive(propName, node, depth);
    }
    
    // It's an AST node (has a type property)
    if (!node.type) {
      return this.renderObject(node, propName, depth);
    }
    
    const nodeId = `ast-node-${this.nodeIdCounter++}`;
    this.nodeMap.set(nodeId, { node, propName, depth });
    
    const hasChildren = this.getChildProperties(node).length > 0;
    
    // In lazy mode, nodes beyond lazyLoadDepth should be collapsed and not pre-rendered
    const shouldLazyLoad = this._lazyModeActive && depth >= this.lazyLoadDepth && hasChildren;
    const isExpanded = this.expandedNodes.has(nodeId) || (!shouldLazyLoad && depth < 1);
    const collapsedClass = !isExpanded && hasChildren ? 'collapsed' : '';
    const lazyClass = shouldLazyLoad && !this.expandedNodes.has(nodeId) ? 'ast-lazy-node' : '';
    
    let html = `<div class="ast-node ${collapsedClass} ${lazyClass}" data-node-id="${nodeId}" data-depth="${depth}">`;
    
    // Node header
    html += `<div class="ast-node-header" data-node-id="${nodeId}">`;
    
    // Toggle arrow
    if (hasChildren) {
      html += `<span class="ast-toggle">▶</span>`;
    } else {
      html += `<span class="ast-toggle-placeholder"></span>`;
    }
    
    // Property name (if not root) - use !== undefined to allow index 0
    if (propName !== undefined && propName !== null && propName !== 'root') {
      html += `<span class="ast-prop-name">${propName}:</span> `;
    }
    
    // Node type
    html += `<span class="ast-node-type">${node.type}</span>`;
    
    // Get inline properties
    const inlineProps = this.getNodeProperties(node);
    
    // Inline properties (name, value, operator, kind, boolean flags)
    if (inlineProps) {
      html += ` <span class="ast-inline-props">${inlineProps}</span>`;
    }
    
    // Location badge
    if (node.loc) {
      html += ` <span class="ast-loc">${node.loc.start.line}:${node.loc.start.column}</span>`;
    }
    
    // Show lazy load indicator
    if (shouldLazyLoad && !this.expandedNodes.has(nodeId)) {
      const childCount = this.countNodes(node, 0, 1000);
      html += ` <span class="ast-lazy-badge" title="Click to load ${childCount}+ nodes">⏳ ${childCount}+ nodes</span>`;
      // Store lazy node data for later loading
      this._lazyNodeData.set(nodeId, { node, propName, depth });
    }
    
    html += `</div>`;
    
    // Children - only render if not lazy or if explicitly expanded
    if (hasChildren) {
      html += `<div class="ast-node-children">`;
      if (shouldLazyLoad && !this.expandedNodes.has(nodeId)) {
        // Placeholder for lazy loading
        html += `<div class="ast-lazy-placeholder" data-node-id="${nodeId}">Click to load children...</div>`;
      } else {
        html += this.renderChildren(node, depth + 1);
      }
      html += `</div>`;
    }
    
    html += `</div>`;
    
    return html;
  },
  
  /**
   * Load lazy node children on demand
   */
  loadLazyNode(nodeId) {
    const lazyData = this._lazyNodeData.get(nodeId);
    if (!lazyData) return;
    
    const nodeEl = document.querySelector(`.ast-node[data-node-id="${nodeId}"]`);
    if (!nodeEl) return;
    
    const childrenContainer = nodeEl.querySelector('.ast-node-children');
    if (!childrenContainer) return;
    
    // Mark as expanded
    this.expandedNodes.add(nodeId);
    nodeEl.classList.remove('collapsed', 'ast-lazy-node');
    
    // Remove lazy badge
    const lazyBadge = nodeEl.querySelector('.ast-lazy-badge');
    if (lazyBadge) lazyBadge.remove();
    
    // Render children based on type
    const { node, depth, isArray } = lazyData;
    
    if (isArray) {
      // Render array items
      let html = '';
      node.forEach((item, index) => {
        html += this.renderNode(item, node, index, depth + 1);
      });
      childrenContainer.innerHTML = html;
    } else {
      // Render object children
      childrenContainer.innerHTML = this.renderChildren(node, depth + 1);
    }
    
    // Re-attach listeners to new nodes
    this.attachNodeListeners();
    
    // Remove from lazy data
    this._lazyNodeData.delete(nodeId);
  },
  
  /**
   * Load a truncated node on demand (replaces the truncated placeholder with actual content)
   */
  loadTruncatedNode(truncId, truncEl) {
    const truncData = this._truncatedNodeData?.get(truncId);
    if (!truncData) return;
    
    const { node, parent, propName, depth } = truncData;
    
    // Temporarily increase the render limit to render this branch
    const savedLimit = this.MAX_RENDER_NODES;
    const savedCount = this._renderNodeCount;
    const savedLimitHit = this._renderLimitHit;
    
    // Allow rendering 500 more nodes
    this.MAX_RENDER_NODES = this._renderNodeCount + 500;
    this._renderLimitHit = false;
    
    // Render the node
    const html = this.renderNode(node, parent, propName, depth);
    
    // Restore limits
    this.MAX_RENDER_NODES = savedLimit;
    // Keep updated count
    this._renderLimitHit = savedLimitHit || this._renderLimitHit;
    
    // Replace the truncated placeholder with rendered content
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const newEl = wrapper.firstElementChild;
    
    if (newEl) {
      truncEl.replaceWith(newEl);
      
      // Re-attach listeners
      this.attachNodeListeners();
      
      // Rebuild position index
      this.buildPositionIndex();
    }
    
    // Remove from truncated data
    this._truncatedNodeData.delete(truncId);
  },

  /**
   * Render array of nodes
   */
  renderArray(arr, propName, depth) {
    if (arr.length === 0) {
      return `
        <div class="ast-node ast-array-empty" data-depth="${depth}">
          <div class="ast-node-header">
            <span class="ast-toggle-placeholder"></span>
            <span class="ast-prop-name">${propName}:</span>
            <span class="ast-array-badge">[]</span>
          </div>
        </div>
      `;
    }
    
    const nodeId = `ast-node-${this.nodeIdCounter++}`;
    this.nodeMap.set(nodeId, { node: arr, propName, depth, isArray: true });
    
    // Check if we should lazy load this array
    const shouldLazyLoad = this._lazyModeActive && depth >= this.lazyLoadDepth;
    const isExpanded = this.expandedNodes.has(nodeId) || (!shouldLazyLoad && depth < 3);
    const collapsedClass = !isExpanded ? 'collapsed' : '';
    const lazyClass = shouldLazyLoad && !this.expandedNodes.has(nodeId) ? 'ast-lazy-node' : '';
    
    let html = `<div class="ast-node ast-array ${collapsedClass} ${lazyClass}" data-node-id="${nodeId}" data-depth="${depth}">`;
    html += `<div class="ast-node-header" data-node-id="${nodeId}">`;
    html += `<span class="ast-toggle">▶</span>`;
    html += `<span class="ast-prop-name">${propName}:</span>`;
    html += ` <span class="ast-array-badge">[${arr.length}]</span>`;
    
    // Show lazy load indicator for arrays
    if (shouldLazyLoad && !this.expandedNodes.has(nodeId)) {
      const childCount = arr.reduce((sum, item) => sum + this.countNodes(item, 0, 100), 0);
      html += ` <span class="ast-lazy-badge" title="Click to load ${childCount}+ nodes">⏳ ${childCount}+ nodes</span>`;
      this._lazyNodeData.set(nodeId, { node: arr, propName, depth, isArray: true });
    }
    
    html += `</div>`;
    
    html += `<div class="ast-node-children">`;
    if (shouldLazyLoad && !this.expandedNodes.has(nodeId)) {
      html += `<div class="ast-lazy-placeholder" data-node-id="${nodeId}">Click to load ${arr.length} items...</div>`;
    } else {
      arr.forEach((item, index) => {
        html += this.renderNode(item, arr, index, depth + 1);
      });
    }
    html += `</div>`;
    
    html += `</div>`;
    
    return html;
  },
  
  /**
   * Render primitive value
   */
  renderPrimitive(propName, value, depth) {
    let valueStr, valueClass;
    
    if (value === null) {
      valueStr = 'null';
      valueClass = 'ast-null';
    } else if (value === undefined) {
      valueStr = 'undefined';
      valueClass = 'ast-undefined';
    } else if (typeof value === 'string') {
      valueStr = JSON.stringify(value);
      valueClass = 'ast-string';
    } else if (typeof value === 'number') {
      valueStr = String(value);
      valueClass = 'ast-number';
    } else if (typeof value === 'boolean') {
      valueStr = String(value);
      valueClass = 'ast-boolean';
    } else {
      valueStr = String(value);
      valueClass = 'ast-value';
    }
    
    return `
      <div class="ast-node ast-primitive" data-depth="${depth}">
        <div class="ast-node-header">
          <span class="ast-toggle-placeholder"></span>
          <span class="ast-prop-name">${propName}:</span>
          <span class="${valueClass}">${this.escapeHtml(valueStr)}</span>
        </div>
      </div>
    `;
  },
  
  /**
   * Render a plain object (non-AST node)
   */
  renderObject(obj, propName, depth) {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return `
        <div class="ast-node" data-depth="${depth}">
          <div class="ast-node-header">
            <span class="ast-toggle-placeholder"></span>
            <span class="ast-prop-name">${propName}:</span>
            <span class="ast-object-badge">{}</span>
          </div>
        </div>
      `;
    }
    
    const nodeId = `ast-node-${this.nodeIdCounter++}`;
    const isExpanded = this.expandedNodes.has(nodeId) || depth < 2;
    const collapsedClass = !isExpanded ? 'collapsed' : '';
    
    let html = `<div class="ast-node ${collapsedClass}" data-node-id="${nodeId}" data-depth="${depth}">`;
    html += `<div class="ast-node-header" data-node-id="${nodeId}">`;
    html += `<span class="ast-toggle">▶</span>`;
    html += `<span class="ast-prop-name">${propName}:</span>`;
    html += ` <span class="ast-object-badge">{${keys.length}}</span>`;
    html += `</div>`;
    
    html += `<div class="ast-node-children">`;
    for (const key of keys) {
      html += this.renderNode(obj[key], obj, key, depth + 1);
    }
    html += `</div>`;
    
    html += `</div>`;
    
    return html;
  },
  
  /**
   * Render children of an AST node
   */
  renderChildren(node, depth) {
    let html = '';
    const childProps = this.getChildProperties(node);
    
    for (const prop of childProps) {
      const value = node[prop];
      html += this.renderNode(value, node, prop, depth);
    }
    
    return html;
  },
  
  /**
   * Get child properties of a node (properties that contain AST nodes)
   */
  getChildProperties(node) {
    const props = [];
    
    for (const key of Object.keys(node)) {
      if (this.skipProps.has(key) || this.inlineProps.has(key)) continue;
      
      const value = node[key];
      
      // Skip value if it's a primitive (shown inline)
      if (key === 'value' && (typeof value !== 'object' || value === null)) {
        continue;
      }
      
      // Include arrays and objects (potential AST nodes)
      if (Array.isArray(value) || (value && typeof value === 'object')) {
        props.push(key);
      }
    }
    
    // Sort to show common properties first
    const order = ['id', 'key', 'value', 'init', 'body', 'declarations', 'expression',
                   'left', 'right', 'test', 'consequent', 'alternate', 'callee', 
                   'arguments', 'object', 'property', 'params', 'elements', 'properties'];
    
    props.sort((a, b) => {
      const aIdx = order.indexOf(a);
      const bIdx = order.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    
    return props;
  },
  
  /**
   * Get inline properties and flags for a node
   * Returns { inline: string, flags: array } 
   * Returns inline properties as a formatted string
   */
  getNodeProperties(node) {
    const parts = [];
    
    // Key properties shown inline
    if (node.name !== undefined && node.name !== null) {
      parts.push(`<span class="ast-prop-inline">name=</span><span class="ast-ident">"${this.escapeHtml(String(node.name))}"</span>`);
    }
    
    if (node.value !== undefined && node.value !== null && typeof node.value !== 'object') {
      const val = typeof node.value === 'string' 
        ? `"${this.escapeHtml(this.truncate(node.value, 30))}"`
        : String(node.value);
      const cls = typeof node.value === 'string' ? 'ast-string' : 
                  typeof node.value === 'number' ? 'ast-number' : 
                  typeof node.value === 'boolean' ? 'ast-boolean' : 'ast-value';
      parts.push(`<span class="ast-prop-inline">value=</span><span class="${cls}">${val}</span>`);
    }
    
    if (node.operator) {
      parts.push(`<span class="ast-prop-inline">op=</span><span class="ast-operator">"${this.escapeHtml(node.operator)}"</span>`);
    }
    
    if (node.kind) {
      parts.push(`<span class="ast-prop-inline">kind=</span><span class="ast-keyword">"${node.kind}"</span>`);
    }
    
    // Show raw for hex/octal literals (inline)
    if (node.extra?.raw && node.extra.raw !== String(node.value)) {
      parts.push(`<span class="ast-prop-inline">raw=</span><span class="ast-raw">"${this.escapeHtml(node.extra.raw)}"</span>`);
    }
    
    // Boolean flags shown inline
    if (node.computed !== undefined) {
      parts.push(`<span class="ast-prop-inline">computed=</span><span class="ast-boolean-${node.computed}">${node.computed}</span>`);
    }
    if (node.async !== undefined) {
      parts.push(`<span class="ast-prop-inline">async=</span><span class="ast-boolean-${node.async}">${node.async}</span>`);
    }
    if (node.generator !== undefined) {
      parts.push(`<span class="ast-prop-inline">generator=</span><span class="ast-boolean-${node.generator}">${node.generator}</span>`);
    }
    if (node.static !== undefined) {
      parts.push(`<span class="ast-prop-inline">static=</span><span class="ast-boolean-${node.static}">${node.static}</span>`);
    }
    if (node.optional !== undefined) {
      parts.push(`<span class="ast-prop-inline">optional=</span><span class="ast-boolean-${node.optional}">${node.optional}</span>`);
    }
    if (node.shorthand !== undefined) {
      parts.push(`<span class="ast-prop-inline">shorthand=</span><span class="ast-boolean-${node.shorthand}">${node.shorthand}</span>`);
    }
    if (node.method !== undefined) {
      parts.push(`<span class="ast-prop-inline">method=</span><span class="ast-boolean-${node.method}">${node.method}</span>`);
    }
    if (node.prefix !== undefined) {
      parts.push(`<span class="ast-prop-inline">prefix=</span><span class="ast-boolean-${node.prefix}">${node.prefix}</span>`);
    }
    if (node.await !== undefined) {
      parts.push(`<span class="ast-prop-inline">await=</span><span class="ast-boolean-${node.await}">${node.await}</span>`);
    }
    if (node.delegate !== undefined) {
      parts.push(`<span class="ast-prop-inline">delegate=</span><span class="ast-boolean-${node.delegate}">${node.delegate}</span>`);
    }
    if (node.tail !== undefined) {
      parts.push(`<span class="ast-prop-inline">tail=</span><span class="ast-boolean-${node.tail}">${node.tail}</span>`);
    }
    
    // Special cases for certain node types
    switch (node.type) {
      case 'RegExpLiteral':
        parts.length = 0; // Clear and use custom format
        parts.push(`<span class="ast-regex">/${this.escapeHtml(node.pattern)}/${node.flags || ''}</span>`);
        break;
        
      case 'TemplateElement':
        if (node.value?.raw && !parts.some(p => p.includes('value='))) {
          const raw = this.truncate(node.value.raw, 30);
          parts.push(`<span class="ast-prop-inline">raw=</span><span class="ast-string">"${this.escapeHtml(raw)}"</span>`);
        }
        break;
        
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        if (node.source?.value) {
          parts.push(`<span class="ast-prop-inline">from=</span><span class="ast-string">"${this.escapeHtml(node.source.value)}"</span>`);
        }
        break;
        
      case 'BreakStatement':
      case 'ContinueStatement':
        if (node.label?.name) {
          parts.push(`<span class="ast-prop-inline">label=</span><span class="ast-ident">"${this.escapeHtml(node.label.name)}"</span>`);
        }
        break;
    }
    
    return parts.join(' ');
  },
  
  /**
   * Truncate string
   */
  truncate(str, maxLen) {
    if (typeof str !== 'string') return String(str);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  },
  
  /**
   * Escape HTML entities
   */
  escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
  
  // ==================== Context Menu ====================
  
  contextMenuNode: null,
  contextMenuNodeId: null,
  replaceModalNode: null,
  
  // "Replace with another node" selection mode
  replaceSelectionMode: false,
  replaceTargetNode: null,  // The node to be replaced
  replaceTargetType: null,  // Type of the target node
  
  /**
   * Attach click listeners to nodes
   */
  attachNodeListeners() {
    document.querySelectorAll('.ast-node-header').forEach(header => {
      // Mark headers with AST nodes as having context menu
      const nodeId = header.dataset.nodeId;
      if (nodeId) {
        const data = this.nodeMap.get(nodeId);
        if (data && data.node && data.node.type) {
          header.classList.add('has-context');
        }
      }
      
      header.addEventListener('click', (e) => {
        if (!nodeId) return;
        
        const nodeEl = header.closest('.ast-node');
        
        // Check if this is a lazy node that needs to be loaded
        if (nodeEl.classList.contains('ast-lazy-node')) {
          this.loadLazyNode(nodeId);
          return;
        }
        
        // Toggle expand/collapse
        if (e.target.closest('.ast-toggle')) {
          nodeEl.classList.toggle('collapsed');
          if (nodeEl.classList.contains('collapsed')) {
            this.expandedNodes.delete(nodeId);
          } else {
            this.expandedNodes.add(nodeId);
          }
        } else {
          // Select node
          this.selectNode(nodeId);
        }
      });
      
      // Right-click context menu
      header.addEventListener('contextmenu', (e) => {
        if (!nodeId) return;
        
        const data = this.nodeMap.get(nodeId);
        if (data && data.node && data.node.type) {
          e.preventDefault();
          this.showContextMenu(e.clientX, e.clientY, nodeId, data);
        }
      });
    });
    
    // Handle lazy placeholder clicks
    document.querySelectorAll('.ast-lazy-placeholder').forEach(placeholder => {
      placeholder.addEventListener('click', (e) => {
        const nodeId = placeholder.dataset.nodeId;
        if (nodeId) {
          this.loadLazyNode(nodeId);
        }
      });
    });
    
    // Handle truncated node clicks (load on demand)
    document.querySelectorAll('.ast-truncated[data-trunc-id]').forEach(truncEl => {
      truncEl.addEventListener('click', (e) => {
        const truncId = truncEl.dataset.truncId;
        if (truncId) {
          this.loadTruncatedNode(truncId, truncEl);
        }
      });
    });
    
    // Close context menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.ast-context-menu')) {
        this.hideContextMenu();
      }
    });
    
    // Close context menu on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
        this.closeReplaceModal();
        // Also cancel replace selection mode
        if (this.replaceSelectionMode) {
          this.cancelReplaceSelection();
        }
      }
    });
  },
  
  /**
   * Show context menu at position
   */
  showContextMenu(x, y, nodeId, data) {
    const menu = document.getElementById('ast-context-menu');
    const header = document.getElementById('ast-context-menu-header');
    const items = document.getElementById('ast-context-menu-items');
    
    if (!menu || !items) return;
    
    this.contextMenuNode = data.node;
    this.contextMenuNodeId = nodeId;
    
    // Update header with node type
    header.textContent = data.node.type;
    
    // Mark the node header as active
    document.querySelectorAll('.ast-node-header.context-active').forEach(el => {
      el.classList.remove('context-active');
    });
    const nodeHeader = document.querySelector(`.ast-node-header[data-node-id="${nodeId}"]`);
    if (nodeHeader) {
      nodeHeader.classList.add('context-active');
    }
    
    // Build menu items based on node type
    items.innerHTML = this.buildContextMenuItems(data.node);
    
    // Position menu
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('visible');
    
    // Adjust if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }
  },
  
  /**
   * Hide context menu
   */
  hideContextMenu() {
    const menu = document.getElementById('ast-context-menu');
    if (menu) {
      menu.classList.remove('visible');
    }
    document.querySelectorAll('.ast-node-header.context-active').forEach(el => {
      el.classList.remove('context-active');
    });
    this.contextMenuNode = null;
    this.contextMenuNodeId = null;
  },
  
  /**
   * Build context menu items HTML
   */
  buildContextMenuItems(node) {
    let html = '';
    
    // Copy actions
    html += `
      <div class="ast-context-menu-item" onclick="ASTViewer.contextCopyJSON()">
        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Node JSON
      </div>
      <div class="ast-context-menu-item" onclick="ASTViewer.contextCopyPath()">
        <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Copy Path Access
      </div>
    `;
    
    html += '<div class="ast-context-menu-divider"></div>';
    
    // Transform actions
    html += `
      <div class="ast-context-menu-item" onclick="ASTViewer.contextRemove()">
        <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        path.remove()
        <span class="shortcut">Del</span>
      </div>
      <div class="ast-context-menu-item" onclick="ASTViewer.contextReplaceWith()">
        <svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        path.replaceWith(...)
      </div>
      <div class="ast-context-menu-item" onclick="ASTViewer.contextReplaceWithNode()">
        <svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/></svg>
        Replace with another node...
      </div>
    `;
    
    // Node-specific actions
    if (node.type === 'Identifier') {
      html += `
        <div class="ast-context-menu-item" onclick="ASTViewer.contextRenameBinding()">
          <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          Rename all occurrences
        </div>
        <div class="ast-context-menu-item" onclick="ASTViewer.contextFindInScope()">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          Find in Scope
        </div>
      `;
    }
    
    if (node.type.includes('Literal')) {
      html += `
        <div class="ast-context-menu-item" onclick="ASTViewer.contextChangeValue()">
          <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Change value
        </div>
      `;
    }
    
    if (node.type === 'CallExpression') {
      html += `
        <div class="ast-context-menu-item" onclick="ASTViewer.contextUnwrapCall()">
          <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4-3-9s1.34-9 3-9"/></svg>
          Unwrap to first argument
        </div>
      `;
    }
    
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      html += `
        <div class="ast-context-menu-item" onclick="ASTViewer.contextEvaluate()">
          <svg viewBox="0 0 24 24"><path d="m5 12 7-7 7 7"/><path d="m12 19V5"/></svg>
          Evaluate if constant
        </div>
      `;
    }
    
    html += '<div class="ast-context-menu-divider"></div>';
    
    // Generate template
    html += `
      <div class="ast-context-menu-item" onclick="ASTViewer.contextGenerateVisitor()">
        <svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Generate visitor template
      </div>
    `;
    
    return html;
  },
  
  // ==================== Context Menu Actions ====================
  
  contextCopyJSON() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const json = JSON.stringify(node, null, 2);
    navigator.clipboard.writeText(json);
    App.log('Node JSON copied to clipboard', 'success');
  },
  
  contextCopyPath() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const pathCode = `path.node // ${node.type}`;
    navigator.clipboard.writeText(pathCode);
    App.log('Path access code copied', 'success');
  },
  
  /**
   * Generate specific matching conditions for a node
   */
  generateNodeMatcher(node, pathPrefix = 'path.node', depth = 0, maxDepth = 3) {
    const conditions = [];
    const indent = '    '.repeat(depth);
    
    if (!node || typeof node !== 'object' || depth > maxDepth) {
      return conditions;
    }
    
    // Always match type first
    if (node.type) {
      conditions.push(`${pathPrefix}.type === '${node.type}'`);
    }
    
    // Match based on node type - be smart about what to match
    switch (node.type) {
      case 'Identifier':
        if (node.name) {
          conditions.push(`${pathPrefix}.name === '${node.name}'`);
        }
        break;
        
      case 'StringLiteral':
        if (node.value !== undefined) {
          conditions.push(`${pathPrefix}.value === ${JSON.stringify(node.value)}`);
        }
        break;
        
      case 'NumericLiteral':
        if (node.value !== undefined) {
          conditions.push(`${pathPrefix}.value === ${node.value}`);
        }
        break;
        
      case 'BooleanLiteral':
        conditions.push(`${pathPrefix}.value === ${node.value}`);
        break;
        
      case 'NullLiteral':
        // Just type match is enough
        break;
        
      case 'VariableDeclaration':
        if (node.kind) {
          conditions.push(`${pathPrefix}.kind === '${node.kind}'`);
        }
        if (node.declarations && node.declarations.length > 0) {
          const decl = node.declarations[0];
          if (decl.id && decl.id.name) {
            conditions.push(`${pathPrefix}.declarations[0]?.id?.name === '${decl.id.name}'`);
          }
          // Also match the init type if present
          if (decl.init && decl.init.type) {
            conditions.push(`${pathPrefix}.declarations[0]?.init?.type === '${decl.init.type}'`);
            // For literals, match the value
            if (decl.init.type === 'StringLiteral' && decl.init.value !== undefined) {
              conditions.push(`${pathPrefix}.declarations[0]?.init?.value === ${JSON.stringify(decl.init.value)}`);
            } else if (decl.init.type === 'NumericLiteral' && decl.init.value !== undefined) {
              conditions.push(`${pathPrefix}.declarations[0]?.init?.value === ${decl.init.value}`);
            }
          }
        }
        break;
        
      case 'VariableDeclarator':
        if (node.id && node.id.name) {
          conditions.push(`${pathPrefix}.id?.name === '${node.id.name}'`);
        }
        if (node.init && node.init.type) {
          conditions.push(`${pathPrefix}.init?.type === '${node.init.type}'`);
        }
        break;
        
      case 'CallExpression':
        if (node.callee) {
          if (node.callee.type === 'Identifier' && node.callee.name) {
            conditions.push(`${pathPrefix}.callee?.type === 'Identifier'`);
            conditions.push(`${pathPrefix}.callee?.name === '${node.callee.name}'`);
          } else if (node.callee.type === 'MemberExpression') {
            if (node.callee.object?.name) {
              conditions.push(`${pathPrefix}.callee?.object?.name === '${node.callee.object.name}'`);
            }
            if (node.callee.property?.name) {
              conditions.push(`${pathPrefix}.callee?.property?.name === '${node.callee.property.name}'`);
            }
          }
        }
        break;
        
      case 'MemberExpression':
        if (node.object?.type === 'Identifier' && node.object.name) {
          conditions.push(`${pathPrefix}.object?.name === '${node.object.name}'`);
        }
        if (node.property?.type === 'Identifier' && node.property.name) {
          conditions.push(`${pathPrefix}.property?.name === '${node.property.name}'`);
        }
        conditions.push(`${pathPrefix}.computed === ${node.computed || false}`);
        break;
        
      case 'BinaryExpression':
      case 'LogicalExpression':
        if (node.operator) {
          conditions.push(`${pathPrefix}.operator === '${node.operator}'`);
        }
        // Match left/right types
        if (node.left?.type) {
          conditions.push(`${pathPrefix}.left?.type === '${node.left.type}'`);
          if (node.left.type === 'Identifier' && node.left.name) {
            conditions.push(`${pathPrefix}.left?.name === '${node.left.name}'`);
          } else if (node.left.type === 'StringLiteral') {
            conditions.push(`${pathPrefix}.left?.value === ${JSON.stringify(node.left.value)}`);
          } else if (node.left.type === 'NumericLiteral') {
            conditions.push(`${pathPrefix}.left?.value === ${node.left.value}`);
          }
        }
        if (node.right?.type) {
          conditions.push(`${pathPrefix}.right?.type === '${node.right.type}'`);
          if (node.right.type === 'Identifier' && node.right.name) {
            conditions.push(`${pathPrefix}.right?.name === '${node.right.name}'`);
          } else if (node.right.type === 'StringLiteral') {
            conditions.push(`${pathPrefix}.right?.value === ${JSON.stringify(node.right.value)}`);
          } else if (node.right.type === 'NumericLiteral') {
            conditions.push(`${pathPrefix}.right?.value === ${node.right.value}`);
          }
        }
        break;
        
      case 'UnaryExpression':
        if (node.operator) {
          conditions.push(`${pathPrefix}.operator === '${node.operator}'`);
        }
        if (node.argument?.type) {
          conditions.push(`${pathPrefix}.argument?.type === '${node.argument.type}'`);
        }
        break;
        
      case 'AssignmentExpression':
        if (node.operator) {
          conditions.push(`${pathPrefix}.operator === '${node.operator}'`);
        }
        if (node.left?.name) {
          conditions.push(`${pathPrefix}.left?.name === '${node.left.name}'`);
        }
        break;
        
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.id?.name) {
          conditions.push(`${pathPrefix}.id?.name === '${node.id.name}'`);
        }
        if (node.params) {
          conditions.push(`${pathPrefix}.params?.length === ${node.params.length}`);
        }
        break;
        
      case 'IfStatement':
        if (node.test?.type) {
          conditions.push(`${pathPrefix}.test?.type === '${node.test.type}'`);
          if (node.test.type === 'BooleanLiteral') {
            conditions.push(`${pathPrefix}.test?.value === ${node.test.value}`);
          } else if (node.test.type === 'Identifier') {
            conditions.push(`${pathPrefix}.test?.name === '${node.test.name}'`);
          }
        }
        break;
        
      case 'ReturnStatement':
        if (node.argument?.type) {
          conditions.push(`${pathPrefix}.argument?.type === '${node.argument.type}'`);
        }
        break;
        
      case 'ObjectProperty':
        if (node.key?.name) {
          conditions.push(`${pathPrefix}.key?.name === '${node.key.name}'`);
        } else if (node.key?.value !== undefined) {
          conditions.push(`${pathPrefix}.key?.value === ${JSON.stringify(node.key.value)}`);
        }
        break;
        
      case 'ArrayExpression':
        if (node.elements) {
          conditions.push(`${pathPrefix}.elements?.length === ${node.elements.length}`);
        }
        break;
        
      case 'ObjectExpression':
        if (node.properties) {
          conditions.push(`${pathPrefix}.properties?.length === ${node.properties.length}`);
        }
        break;
        
      default:
        // For other types, try to match common properties
        if (node.name) {
          conditions.push(`${pathPrefix}.name === '${node.name}'`);
        }
        if (node.value !== undefined && typeof node.value !== 'object') {
          conditions.push(`${pathPrefix}.value === ${JSON.stringify(node.value)}`);
        }
        if (node.operator) {
          conditions.push(`${pathPrefix}.operator === '${node.operator}'`);
        }
    }
    
    return conditions;
  },
  
  /**
   * Format conditions into a readable if statement
   */
  formatConditions(conditions, indent = '    ') {
    if (conditions.length === 0) {
      return 'true';
    }
    if (conditions.length === 1) {
      return conditions[0];
    }
    // Format nicely with line breaks
    return conditions.join(' &&\n' + indent);
  },
  
  contextRemove() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    const hasConditions = conditions.length > 1;
    
    let code;
    if (hasConditions) {
      code = `// Remove specific ${node.type}
// Matching: ${this.getNodeSummary(node)}
traverse({
  ${node.type}(path) {
    if (${conditionStr}) {
      path.remove();
      stats.removed = (stats.removed || 0) + 1;
    }
  }
});

console.log('Removed', stats.removed || 0, '${node.type} node(s)');`;
    } else {
      code = `// Remove ALL ${node.type} nodes
// WARNING: This will remove ALL ${node.type} nodes!
// Consider adding more specific conditions
traverse({
  ${node.type}(path) {
    path.remove();
    stats.removed = (stats.removed || 0) + 1;
  }
});

console.log('Removed', stats.removed || 0, '${node.type} node(s)');`;
    }
    
    this.openGeneratedTransform(code, `Remove ${node.type}`);
  },
  
  /**
   * Get a short summary of a node for comments
   */
  getNodeSummary(node) {
    if (!node) return '';
    
    switch (node.type) {
      case 'Identifier':
        return `identifier "${node.name}"`;
      case 'StringLiteral':
        return `string "${this.truncate(node.value, 30)}"`;
      case 'NumericLiteral':
        return `number ${node.value}`;
      case 'BooleanLiteral':
        return `boolean ${node.value}`;
      case 'VariableDeclaration':
        const names = node.declarations?.map(d => d.id?.name).filter(Boolean).join(', ');
        return `${node.kind} ${names}`;
      case 'VariableDeclarator':
        return `${node.id?.name || '?'} = ...`;
      case 'CallExpression':
        if (node.callee?.name) return `${node.callee.name}(...)`;
        if (node.callee?.property?.name) return `...${node.callee.property.name}(...)`;
        return 'call expression';
      case 'MemberExpression':
        return `${node.object?.name || '?'}.${node.property?.name || '?'}`;
      case 'BinaryExpression':
        return `... ${node.operator} ...`;
      case 'FunctionDeclaration':
        return `function ${node.id?.name || 'anonymous'}()`;
      case 'IfStatement':
        return `if (${node.test?.type || '?'})`;
      default:
        return node.type;
    }
  },

  contextReplaceWith() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    this.replaceModalNode = node;
    this.showReplaceModal();
  },
  
  /**
   * Start "replace with another node" selection mode
   */
  contextReplaceWithNode() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    // Store the target node (the one to be replaced)
    this.replaceTargetNode = node;
    this.replaceTargetType = node.type;
    this.replaceSelectionMode = true;
    
    // Show visual indicator
    this.showReplaceSelectionBanner();
    
    // Highlight the target node
    document.querySelectorAll('.ast-node-header').forEach(el => {
      el.classList.remove('replace-target', 'replace-source-candidate');
    });
    
    const targetHeader = document.querySelector(`.ast-node-header[data-node-id="${this.contextMenuNodeId}"]`);
    if (targetHeader) {
      targetHeader.classList.add('replace-target');
    }
    
    // Mark all other nodes as potential sources
    document.querySelectorAll('.ast-node-header').forEach(el => {
      const nodeId = el.dataset.nodeId;
      if (nodeId && nodeId !== this.contextMenuNodeId) {
        const data = this.nodeMap.get(nodeId);
        if (data && data.node && data.node.type) {
          el.classList.add('replace-source-candidate');
        }
      }
    });
    
    App.log('Click on another node to use as replacement source', 'info');
  },
  
  /**
   * Show banner for replace selection mode
   */
  showReplaceSelectionBanner() {
    // Remove any existing banner
    this.hideReplaceSelectionBanner();
    
    const banner = document.createElement('div');
    banner.id = 'replace-selection-banner';
    banner.className = 'replace-selection-banner';
    banner.innerHTML = `
      <span class="banner-icon">🎯</span>
      <span class="banner-text">
        <strong>Select replacement node</strong> — Click on another AST node to replace <code>${this.replaceTargetType}</code>
      </span>
      <button class="btn btn-small btn-secondary" onclick="ASTViewer.cancelReplaceSelection()">Cancel</button>
    `;
    
    // Insert at top of AST panel
    const astPanel = document.getElementById('ast-panel');
    if (astPanel) {
      astPanel.insertBefore(banner, astPanel.firstChild);
    }
  },
  
  /**
   * Hide replace selection banner
   */
  hideReplaceSelectionBanner() {
    const banner = document.getElementById('replace-selection-banner');
    if (banner) {
      banner.remove();
    }
  },
  
  /**
   * Cancel replace selection mode
   */
  cancelReplaceSelection() {
    this.replaceSelectionMode = false;
    this.replaceTargetNode = null;
    this.replaceTargetType = null;
    this.hideReplaceSelectionBanner();
    
    // Remove highlights
    document.querySelectorAll('.ast-node-header').forEach(el => {
      el.classList.remove('replace-target', 'replace-source-candidate');
    });
    
    App.log('Replace selection cancelled', 'info');
  },
  
  /**
   * Handle node selection when in replace mode
   */
  handleReplaceSourceSelection(nodeId) {
    const sourceData = this.nodeMap.get(nodeId);
    if (!sourceData || !sourceData.node) return;
    
    const sourceNode = sourceData.node;
    const targetNode = this.replaceTargetNode;
    const targetType = this.replaceTargetType;
    
    // Exit selection mode
    this.cancelReplaceSelection();
    
    // Generate the transform code
    const targetConditions = this.generateNodeMatcher(targetNode);
    const targetConditionStr = this.formatConditions(targetConditions);
    
    // Generate template for source node
    const sourceTemplate = this.nodeToTemplate(sourceNode);
    
    const code = `// Replace ${targetType} with cloned ${sourceNode.type}
// Target: ${this.getNodeSummary(targetNode)}
// Source: ${this.getNodeSummary(sourceNode)}

// The replacement node (cloned from source)
const replacementNode = ${sourceTemplate};

traverse({
  ${targetType}(path) {
    if (${targetConditionStr}) {
      path.replaceWith(t.cloneNode(replacementNode, true));
      path.skip(); // Prevent infinite loop
      stats.replaced = (stats.replaced || 0) + 1;
    }
  }
});

console.log('Replaced', stats.replaced || 0, 'node(s)');`;
    
    this.openGeneratedTransform(code, `Replace ${targetType} with ${sourceNode.type}`);
  },
  
  contextRenameBinding() {
    const node = this.contextMenuNode;
    if (!node || node.type !== 'Identifier') return;
    this.hideContextMenu();
    
    const oldName = node.name;
    const newName = prompt(`Rename "${oldName}" to:`, oldName);
    
    if (newName && newName !== oldName) {
      const code = `// Rename "${oldName}" to "${newName}"
// This renames ALL occurrences of this identifier
traverse({
  Identifier(path) {
    if (path.node.name === '${oldName}') {
      path.node.name = '${newName}';
      stats.renamed = (stats.renamed || 0) + 1;
    }
  }
});

console.log('Renamed', stats.renamed || 0, 'occurrences');`;
      
      this.openGeneratedTransform(code, `Rename ${oldName} → ${newName}`);
    }
  },
  
  /**
   * Find identifier in scope panel
   */
  contextFindInScope() {
    const node = this.contextMenuNode;
    if (!node || node.type !== 'Identifier') {
      App.log('No Identifier node selected', 'warn');
      return;
    }
    
    const name = node.name;
    const astSource = this.currentSource; // Remember current AST source (input/output)
    this.hideContextMenu();
    
    // Switch to Scope tab in tools panel
    const scopeTab = document.querySelector('.tool-tab[data-tab="scope"]');
    if (scopeTab) {
      scopeTab.click();
    }
    
    // Sync scope source with AST source
    if (ScopeAnalyzer.currentSource !== astSource) {
      ScopeAnalyzer.switchSource(astSource);
    }
    
    // Ensure scope is analyzed first
    const analyzeAndFind = async () => {
      // If no scopes, analyze first
      if (ScopeAnalyzer.scopes.length === 0) {
        await ScopeAnalyzer.refresh();
      }
      
      // Set search input value and trigger filter
      const searchInput = document.getElementById('scope-search');
      if (searchInput) {
        searchInput.value = name;
        searchInput.focus();
        
        // Trigger the filter
        ScopeAnalyzer.filterBindings(name);
        
        // Also try to select the exact match - use escaped selector
        setTimeout(() => {
          // Find the binding item with matching data-name attribute
          const bindingItems = document.querySelectorAll('.binding-item');
          let exactMatch = null;
          
          for (const item of bindingItems) {
            if (item.dataset.name === name) {
              exactMatch = item;
              break;
            }
          }
          
          if (exactMatch) {
            ScopeAnalyzer.selectBinding(exactMatch);
            exactMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Flash effect
            exactMatch.classList.add('scope-flash');
            setTimeout(() => exactMatch.classList.remove('scope-flash'), 800);
            
            // Expand refs if available
            if (exactMatch.classList.contains('has-refs')) {
              exactMatch.classList.add('refs-expanded');
            }
            
            App.log(`Found "${name}" in ${astSource} scope`, 'success');
          } else {
            App.log(`"${name}" not found in current scope`, 'warn');
          }
        }, 200);
      } else {
        App.log('Scope search input not found', 'error');
      }
    };
    
    analyzeAndFind();
  },
  
  contextChangeValue() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    const currentValue = node.value;
    const newValue = prompt('New value:', String(currentValue));
    
    if (newValue !== null && newValue !== String(currentValue)) {
      let replaceCode;
      if (node.type === 'StringLiteral') {
        replaceCode = `t.stringLiteral(${JSON.stringify(newValue)})`;
      } else if (node.type === 'NumericLiteral') {
        replaceCode = `t.numericLiteral(${parseFloat(newValue)})`;
      } else if (node.type === 'BooleanLiteral') {
        replaceCode = `t.booleanLiteral(${newValue === 'true'})`;
      } else {
        replaceCode = `t.valueToNode(${JSON.stringify(newValue)})`;
      }
      
      const code = `// Change ${node.type} value: ${JSON.stringify(currentValue)} → ${JSON.stringify(newValue)}
// Matching: ${this.getNodeSummary(node)}
traverse({
  ${node.type}(path) {
    if (${conditionStr}) {
      path.replaceWith(${replaceCode});
      path.skip(); // Prevent infinite loop
      stats.changed = (stats.changed || 0) + 1;
    }
  }
});

console.log('Changed', stats.changed || 0, 'value(s)');`;
      
      this.openGeneratedTransform(code, `Change value to ${newValue}`);
    }
  },
  
  contextUnwrapCall() {
    const node = this.contextMenuNode;
    if (!node || node.type !== 'CallExpression') return;
    this.hideContextMenu();
    
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    
    let calleeName = 'function';
    if (node.callee.type === 'Identifier') {
      calleeName = node.callee.name;
    } else if (node.callee.type === 'MemberExpression' && node.callee.property.name) {
      calleeName = node.callee.property.name;
    }
    
    const code = `// Unwrap ${calleeName}() to first argument
// Matching: ${this.getNodeSummary(node)}
traverse({
  CallExpression(path) {
    if (${conditionStr}) {
      if (path.node.arguments.length > 0) {
        path.replaceWith(path.node.arguments[0]);
        path.skip(); // Prevent infinite loop
        stats.unwrapped = (stats.unwrapped || 0) + 1;
      }
    }
  }
});

console.log('Unwrapped', stats.unwrapped || 0, 'call(s)');`;
    
    this.openGeneratedTransform(code, `Unwrap ${calleeName}()`);
  },
  
  contextEvaluate() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    
    const code = `// Evaluate constant expression
// Matching: ${this.getNodeSummary(node)}
traverse({
  ${node.type}(path) {
    if (${conditionStr}) {
      const result = path.evaluate();
      if (result.confident) {
        path.replaceWith(t.valueToNode(result.value));
        path.skip(); // Prevent infinite loop
        stats.evaluated = (stats.evaluated || 0) + 1;
      }
    }
  }
});

console.log('Evaluated', stats.evaluated || 0, 'expression(s)');`;
    
    this.openGeneratedTransform(code, `Evaluate ${node.type}`);
  },
  
  contextGenerateVisitor() {
    const node = this.contextMenuNode;
    if (!node) return;
    this.hideContextMenu();
    
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    const template = this.nodeToTemplate(node);
    
    const code = `// Visitor for specific ${node.type}
// Matching: ${this.getNodeSummary(node)}
traverse({
  ${node.type}(path) {
    // Match this specific node:
    if (${conditionStr}) {
      // TODO: Add your transformation here
      // path.remove();
      // path.replaceWith(newNode);
      // path.skip();
      
      stats.found = (stats.found || 0) + 1;
    }
  }
});

console.log('Found', stats.found || 0, 'matching node(s)');

// To recreate this exact node with t.*:
// ${template.split('\n').join('\n// ')}`;
    
    this.openGeneratedTransform(code, `${node.type} visitor`);
  },
  
  getNodePropertiesComment(node) {
    const lines = [];
    for (const [key, value] of Object.entries(node)) {
      if (this.skipProps.has(key)) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') {
        if (Array.isArray(value)) {
          lines.push(`// path.node.${key} = [...] (${value.length} items)`);
        } else if (value.type) {
          lines.push(`// path.node.${key} = ${value.type}`);
        }
      } else {
        lines.push(`// path.node.${key} = ${JSON.stringify(value)}`);
      }
    }
    return lines.slice(0, 8).join('\n    ');
  },
  
  // ==================== Replace Modal ====================
  
  showReplaceModal() {
    const modal = document.getElementById('ast-replace-modal');
    if (!modal) return;
    
    // Position near center of screen
    modal.style.left = '50%';
    modal.style.top = '30%';
    modal.style.transform = 'translate(-50%, 0)';
    modal.classList.add('visible');
    
    // Setup type change listener
    const typeSelect = document.getElementById('ast-replace-type');
    const valueInput = document.getElementById('ast-replace-value');
    const valueGroup = document.getElementById('ast-replace-value-group');
    const valueLabel = document.getElementById('ast-replace-value-label');
    
    typeSelect.onchange = () => this.updateReplacePreview();
    valueInput.oninput = () => this.updateReplacePreview();
    
    // Set default based on current node
    if (this.replaceModalNode) {
      const type = this.replaceModalNode.type;
      if (type === 'StringLiteral') {
        typeSelect.value = 'stringLiteral';
        valueInput.value = this.replaceModalNode.value || '';
      } else if (type === 'NumericLiteral') {
        typeSelect.value = 'numericLiteral';
        valueInput.value = String(this.replaceModalNode.value || 0);
      } else if (type === 'BooleanLiteral') {
        typeSelect.value = 'booleanLiteral';
        valueInput.value = String(this.replaceModalNode.value);
      } else if (type === 'Identifier') {
        typeSelect.value = 'identifier';
        valueInput.value = this.replaceModalNode.name || '';
      }
    }
    
    this.updateReplacePreview();
  },
  
  closeReplaceModal() {
    const modal = document.getElementById('ast-replace-modal');
    if (modal) {
      modal.classList.remove('visible');
    }
    this.replaceModalNode = null;
  },
  
  updateReplacePreview() {
    const typeSelect = document.getElementById('ast-replace-type');
    const valueInput = document.getElementById('ast-replace-value');
    const preview = document.getElementById('ast-replace-preview');
    const valueGroup = document.getElementById('ast-replace-value-group');
    const valueLabel = document.getElementById('ast-replace-value-label');
    
    const type = typeSelect.value;
    const value = valueInput.value;
    
    // Update value label and visibility based on type
    const needsValue = ['stringLiteral', 'numericLiteral', 'booleanLiteral', 'identifier'].includes(type);
    valueGroup.style.display = needsValue ? 'block' : 'none';
    
    if (type === 'identifier') {
      valueLabel.textContent = 'Name';
      valueInput.placeholder = 'variableName';
    } else if (type === 'booleanLiteral') {
      valueLabel.textContent = 'Value (true/false)';
      valueInput.placeholder = 'true';
    } else {
      valueLabel.textContent = 'Value';
      valueInput.placeholder = 'Enter value...';
    }
    
    // Generate code preview
    let code = this.generateReplaceCode(type, value);
    preview.textContent = code;
  },
  
  generateReplaceCode(type, value) {
    switch (type) {
      case 'stringLiteral':
        return `t.stringLiteral(${JSON.stringify(value)})`;
      case 'numericLiteral':
        return `t.numericLiteral(${parseFloat(value) || 0})`;
      case 'booleanLiteral':
        return `t.booleanLiteral(${value === 'true'})`;
      case 'nullLiteral':
        return `t.nullLiteral()`;
      case 'identifier':
        return `t.identifier(${JSON.stringify(value || 'name')})`;
      case 'callExpression':
        return `t.callExpression(\n  t.identifier('funcName'),\n  [] // arguments\n)`;
      case 'memberExpression':
        return `t.memberExpression(\n  t.identifier('object'),\n  t.identifier('property')\n)`;
      case 'binaryExpression':
        return `t.binaryExpression(\n  '+', // operator\n  t.numericLiteral(1),\n  t.numericLiteral(2)\n)`;
      case 'unaryExpression':
        return `t.unaryExpression(\n  '!', // operator\n  t.booleanLiteral(false)\n)`;
      case 'arrayExpression':
        return `t.arrayExpression([])`;
      case 'objectExpression':
        return `t.objectExpression([])`;
      case 'expressionStatement':
        return `t.expressionStatement(\n  t.identifier('expression')\n)`;
      case 'returnStatement':
        return `t.returnStatement(\n  t.identifier('value') // or null\n)`;
      case 'emptyStatement':
        return `t.emptyStatement()`;
      default:
        return `// Select a type`;
    }
  },
  
  copyReplaceCode() {
    const preview = document.getElementById('ast-replace-preview');
    if (preview) {
      navigator.clipboard.writeText(preview.textContent);
      App.log('Replace code copied', 'success');
    }
  },
  
  applyReplace() {
    if (!this.replaceModalNode) return;
    
    const typeSelect = document.getElementById('ast-replace-type');
    const valueInput = document.getElementById('ast-replace-value');
    
    const type = typeSelect.value;
    const value = valueInput.value;
    const replaceCode = this.generateReplaceCode(type, value);
    const node = this.replaceModalNode;
    const originalType = node.type;
    
    // Use smart matching conditions
    const conditions = this.generateNodeMatcher(node);
    const conditionStr = this.formatConditions(conditions);
    
    const code = `// Replace ${originalType} with ${type}
// Matching: ${this.getNodeSummary(node)}
traverse({
  ${originalType}(path) {
    if (${conditionStr}) {
      path.replaceWith(${replaceCode});
      path.skip(); // Prevent infinite loop
      stats.replaced = (stats.replaced || 0) + 1;
    }
  }
});

console.log('Replaced', stats.replaced || 0, 'node(s)');`;
    
    this.closeReplaceModal();
    this.openGeneratedTransform(code, `Replace ${originalType}`);
  },
  
  /**
   * Open the custom script editor with generated transform code
   */
  openGeneratedTransform(code, name) {
    // Open the script panel (replaced old inline editor modal)
    App.openScriptPanel();
    
    // Create a new tab with the generated code
    setTimeout(() => {
      App.openInNewTab(code, name || 'Generated Transform');
    }, 200);
  },
  
  /**
   * Select a node and show details
   */
  selectNode(nodeId) {
    // Check if we're in replace selection mode
    if (this.replaceSelectionMode) {
      // Don't allow selecting the target node as source
      const targetHeader = document.querySelector('.ast-node-header.replace-target');
      if (targetHeader && targetHeader.dataset.nodeId === nodeId) {
        App.log('Cannot replace node with itself', 'warn');
        return;
      }
      
      this.handleReplaceSourceSelection(nodeId);
      return;
    }
    
    // Remove previous selection
    document.querySelectorAll('.ast-node-header.selected').forEach(el => {
      el.classList.remove('selected');
    });
    
    // Add new selection
    const header = document.querySelector(`.ast-node-header[data-node-id="${nodeId}"]`);
    if (header) {
      header.classList.add('selected');
    }
    
    const data = this.nodeMap.get(nodeId);
    if (data) {
      this.selectedNode = data.node;
      this.showNodeDetails(data.node, data.propName);
      
      // Only jump to location if NOT triggered by cursor sync (to prevent feedback loop)
      if (!this._syncingFromCursor && data.node && data.node.loc) {
        const targetEditor = this.currentSource === 'output' ? 'output' : 'input';
        EditorManager.jumpToPosition(targetEditor, data.node.loc.start.line, data.node.loc.start.column + 1);
      }
    }
  },
  
  /**
   * Show node details panel
   */
  showNodeDetails(node, propName) {
    const container = document.getElementById('ast-details');
    if (!container) return;
    
    if (!node || typeof node !== 'object') {
      container.innerHTML = '<div class="ast-details-empty">Select a node to view details</div>';
      return;
    }
    
    let html = '<div class="ast-details-content">';
    
    // Type header with visitor pattern hint
    if (node.type) {
      html += `<div class="ast-detail-header">${node.type}</div>`;
      html += `<div class="ast-detail-visitor">
        <code class="ast-visitor-code">${node.type}(path) { ... }</code>
        <button class="btn btn-tiny btn-icon" onclick="ASTViewer.copyVisitorTemplate()" title="Copy visitor template">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>`;
    }
    
    // Source code for this node
    if (node.start !== undefined && node.end !== undefined) {
      const code = this.currentSource === 'output' ? EditorManager.getOutput() : EditorManager.getInput();
      if (code) {
        const nodeCode = code.slice(node.start, Math.min(node.end, node.start + 200));
        const truncated = nodeCode.length < (node.end - node.start);
        html += `
          <div class="ast-detail-section">
            <div class="ast-detail-section-title">Source Code</div>
            <pre class="ast-detail-code">${this.escapeHtml(nodeCode)}${truncated ? '...' : ''}</pre>
          </div>
        `;
      }
    }
    
    // Key properties section
    html += '<div class="ast-detail-section">';
    html += '<div class="ast-detail-section-title">Properties</div>';
    html += '<div class="ast-detail-props">';
    
    // Categorize properties
    const valueProps = [];
    const nodeProps = [];
    const arrayProps = [];
    const metaProps = [];
    
    for (const [key, value] of Object.entries(node)) {
      if (this.skipProps.has(key)) {
        if (key !== 'loc') metaProps.push([key, value]);
        continue;
      }
      
      if (value === null || value === undefined) {
        valueProps.push([key, value]);
      } else if (Array.isArray(value)) {
        arrayProps.push([key, value]);
      } else if (typeof value === 'object' && value.type) {
        nodeProps.push([key, value]);
      } else {
        valueProps.push([key, value]);
      }
    }
    
    // Show value properties first (most useful for writing transforms)
    for (const [key, value] of valueProps) {
      let valueHtml;
      
      if (value === null) {
        valueHtml = '<span class="ast-null">null</span>';
      } else if (value === undefined) {
        valueHtml = '<span class="ast-undefined">undefined</span>';
      } else if (typeof value === 'string') {
        valueHtml = `<span class="ast-string">${this.escapeHtml(JSON.stringify(value))}</span>`;
      } else if (typeof value === 'number') {
        valueHtml = `<span class="ast-number">${value}</span>`;
      } else if (typeof value === 'boolean') {
        valueHtml = `<span class="ast-boolean">${value}</span>`;
      } else {
        valueHtml = this.escapeHtml(String(value));
      }
      
      html += `
        <div class="ast-detail-row">
          <span class="ast-detail-key">${key}</span>
          <span class="ast-detail-value">${valueHtml}</span>
          <code class="ast-access-hint">path.node.${key}</code>
        </div>
      `;
    }
    
    // Show node properties
    for (const [key, value] of nodeProps) {
      html += `
        <div class="ast-detail-row">
          <span class="ast-detail-key">${key}</span>
          <span class="ast-detail-value"><span class="ast-node-ref">${value.type}</span></span>
          <code class="ast-access-hint">path.get('${key}')</code>
        </div>
      `;
    }
    
    // Show array properties
    for (const [key, value] of arrayProps) {
      const types = [...new Set(value.map(v => v?.type || typeof v))].join(', ');
      html += `
        <div class="ast-detail-row">
          <span class="ast-detail-key">${key}</span>
          <span class="ast-detail-value"><span class="ast-array-badge">[${value.length}]</span> <span class="ast-types-hint">${types}</span></span>
          <code class="ast-access-hint">path.get('${key}')</code>
        </div>
      `;
    }
    
    html += '</div></div>';
    
    // Location details
    if (node.loc) {
      html += `
        <div class="ast-detail-section">
          <div class="ast-detail-section-title">Location</div>
          <div class="ast-detail-row">
            <span class="ast-detail-key">start</span>
            <span class="ast-detail-value">${node.loc.start.line}:${node.loc.start.column}</span>
          </div>
          <div class="ast-detail-row">
            <span class="ast-detail-key">end</span>
            <span class="ast-detail-value">${node.loc.end.line}:${node.loc.end.column}</span>
          </div>
        </div>
      `;
    }
    
    // Actions
    html += `
      <div class="ast-detail-actions">
        <button class="btn btn-small btn-primary" onclick="ASTViewer.generateNodeTemplate()">
          Create Template
        </button>
        <button class="btn btn-small btn-secondary" onclick="ASTViewer.copyNode()">
          Copy JSON
        </button>
        <button class="btn btn-small btn-secondary" onclick="ASTViewer.copyAsTree()">
          Copy Tree
        </button>
      </div>
    `;
    
    html += '</div>';
    
    container.innerHTML = html;
  },
  
  /**
   * Generate a complete Babel types template for recreating the selected node
   */
  generateNodeTemplate() {
    if (!this.selectedNode || !this.selectedNode.type) {
      App.log('No node selected', 'warn');
      return;
    }
    
    const template = this.nodeToTemplate(this.selectedNode);
    const visitorType = this.selectedNode.type;
    
    const fullTemplate = `// Visitor for ${visitorType}
traverse({
  ${visitorType}(path) {
    // Match specific node patterns here
    // Example: if (path.node.name !== 'target') return;
    
    // Create replacement node using t.* methods:
    const newNode = ${template};
    
    // Apply the replacement
    path.replaceWith(newNode);
    path.skip(); // Prevent infinite loop
    stats.replaced = (stats.replaced || 0) + 1;
  }
});`;
    
    navigator.clipboard.writeText(fullTemplate)
      .then(() => App.log('Template copied to clipboard', 'success'))
      .catch(() => App.log('Failed to copy', 'error'));
  },
  
  /**
   * Convert an AST node to a t.* template string
   */
  nodeToTemplate(node, indent = 4) {
    const spaces = ' '.repeat(indent);
    const innerSpaces = ' '.repeat(indent + 2);
    
    if (node === null || node === undefined) {
      return 'null';
    }
    
    if (typeof node !== 'object') {
      return JSON.stringify(node);
    }
    
    if (Array.isArray(node)) {
      if (node.length === 0) return '[]';
      const items = node.map(item => this.nodeToTemplate(item, indent + 2));
      return `[\n${innerSpaces}${items.join(`,\n${innerSpaces}`)}\n${spaces}]`;
    }
    
    // It's an AST node with a type
    if (node.type) {
      const type = node.type;
      const args = this.getTemplateArgs(node, indent + 2);
      
      if (args.length === 0) {
        return `t.${this.camelCase(type)}()`;
      }
      
      // Format based on complexity
      const argsStr = args.join(', ');
      if (argsStr.length < 60 && !argsStr.includes('\n')) {
        return `t.${this.camelCase(type)}(${argsStr})`;
      }
      
      return `t.${this.camelCase(type)}(\n${innerSpaces}${args.join(`,\n${innerSpaces}`)}\n${spaces})`;
    }
    
    // Plain object
    const entries = Object.entries(node)
      .filter(([k]) => !this.skipProps.has(k))
      .map(([k, v]) => `${k}: ${this.nodeToTemplate(v, indent + 2)}`);
    
    if (entries.length === 0) return '{}';
    return `{\n${innerSpaces}${entries.join(`,\n${innerSpaces}`)}\n${spaces}}`;
  },
  
  /**
   * Get template arguments for a babel type
   */
  getTemplateArgs(node, indent) {
    const type = node.type;
    
    // Define argument order for common node types
    const argOrder = {
      Identifier: ['name'],
      StringLiteral: ['value'],
      NumericLiteral: ['value'],
      BooleanLiteral: ['value'],
      NullLiteral: [],
      RegExpLiteral: ['pattern', 'flags'],
      
      BinaryExpression: ['operator', 'left', 'right'],
      UnaryExpression: ['operator', 'argument', 'prefix'],
      LogicalExpression: ['operator', 'left', 'right'],
      AssignmentExpression: ['operator', 'left', 'right'],
      UpdateExpression: ['operator', 'argument', 'prefix'],
      
      MemberExpression: ['object', 'property', 'computed', 'optional'],
      CallExpression: ['callee', 'arguments'],
      NewExpression: ['callee', 'arguments'],
      
      ArrayExpression: ['elements'],
      ObjectExpression: ['properties'],
      ObjectProperty: ['key', 'value', 'computed', 'shorthand'],
      
      FunctionDeclaration: ['id', 'params', 'body', 'generator', 'async'],
      FunctionExpression: ['id', 'params', 'body', 'generator', 'async'],
      ArrowFunctionExpression: ['params', 'body', 'async'],
      
      VariableDeclaration: ['kind', 'declarations'],
      VariableDeclarator: ['id', 'init'],
      
      IfStatement: ['test', 'consequent', 'alternate'],
      ConditionalExpression: ['test', 'consequent', 'alternate'],
      
      ForStatement: ['init', 'test', 'update', 'body'],
      WhileStatement: ['test', 'body'],
      DoWhileStatement: ['body', 'test'],
      ForInStatement: ['left', 'right', 'body'],
      ForOfStatement: ['left', 'right', 'body', 'await'],
      
      SwitchStatement: ['discriminant', 'cases'],
      SwitchCase: ['test', 'consequent'],
      
      ReturnStatement: ['argument'],
      ThrowStatement: ['argument'],
      BreakStatement: ['label'],
      ContinueStatement: ['label'],
      
      TryStatement: ['block', 'handler', 'finalizer'],
      CatchClause: ['param', 'body'],
      
      BlockStatement: ['body'],
      ExpressionStatement: ['expression'],
      
      SequenceExpression: ['expressions'],
      TemplateLiteral: ['quasis', 'expressions'],
      TemplateElement: ['value', 'tail'],
      
      SpreadElement: ['argument'],
      RestElement: ['argument'],
      
      ThisExpression: [],
      Super: [],
    };
    
    const order = argOrder[type];
    if (order) {
      return order
        .filter(key => node[key] !== undefined)
        .map(key => this.nodeToTemplate(node[key], indent));
    }
    
    // Fallback: include all non-meta properties
    const args = [];
    for (const [key, value] of Object.entries(node)) {
      if (this.skipProps.has(key)) continue;
      if (key === 'type') continue;
      if (value === undefined || value === null) continue;
      args.push(this.nodeToTemplate(value, indent));
    }
    return args;
  },
  
  /**
   * Convert PascalCase to camelCase for t.* methods
   */
  camelCase(str) {
    return str.charAt(0).toLowerCase() + str.slice(1);
  },
  
  /**
   * Copy visitor template for the selected node
   */
  copyVisitorTemplate() {
    if (!this.selectedNode || !this.selectedNode.type) return;
    
    const type = this.selectedNode.type;
    const props = [];
    
    // Get useful properties to destructure
    for (const [key, value] of Object.entries(this.selectedNode)) {
      if (this.skipProps.has(key)) continue;
      if (typeof value !== 'object' || value === null) {
        props.push(key);
      }
    }
    
    const propsStr = props.length > 0 ? `\n    const { ${props.slice(0, 5).join(', ')} } = path.node;` : '';
    
    const template = `${type}(path) {${propsStr}
    // Your transform code here
    
    // Examples:
    // path.node.name = 'newName';
    // path.replaceWith(t.identifier('x'));
    // path.remove();
  }`;
    
    navigator.clipboard.writeText(template)
      .then(() => App.log('Visitor template copied', 'success'))
      .catch(() => App.log('Failed to copy', 'error'));
  },
  
  /**
   * Copy selected node as tree text (like console output)
   */
  copyAsTree() {
    if (!this.selectedNode) return;
    
    const text = this.nodeToTreeText(this.selectedNode, 0, '');
    navigator.clipboard.writeText(text)
      .then(() => App.log('Tree text copied', 'success'))
      .catch(() => App.log('Failed to copy', 'error'));
  },
  
  /**
   * Convert node to tree text format (like printAST)
   */
  nodeToTreeText(node, indent = 0, label = '') {
    const prefix = '  '.repeat(indent);
    const labelStr = label ? `${label}: ` : '';
    
    if (node === null || node === undefined) {
      return `${prefix}${labelStr}null\n`;
    }
    
    if (typeof node !== 'object') {
      return `${prefix}${labelStr}${JSON.stringify(node)}\n`;
    }
    
    if (Array.isArray(node)) {
      let text = `${prefix}${labelStr}[Array: ${node.length} items]\n`;
      node.forEach((item, i) => {
        text += this.nodeToTreeText(item, indent + 1, `[${i}]`);
      });
      return text;
    }
    
    // It's an AST node
    const type = node.type || 'Object';
    const extras = [];
    
    // Add useful info based on node properties
    if (node.name) extras.push(`name: "${node.name}"`);
    if (node.value !== undefined && typeof node.value !== 'object') {
      extras.push(`value: ${JSON.stringify(node.value)}`);
    }
    if (node.operator) extras.push(`operator: "${node.operator}"`);
    if (node.kind) extras.push(`kind: "${node.kind}"`);
    if (node.computed) extras.push('computed');
    if (node.async) extras.push('async');
    if (node.generator) extras.push('generator');
    
    const extrasStr = extras.length ? ` (${extras.join(', ')})` : '';
    let text = `${prefix}${labelStr}${type}${extrasStr}\n`;
    
    // Skip these keys
    const skipKeys = new Set(['type', 'start', 'end', 'loc', 'name', 'value', 'operator', 'kind', 'raw', 'extra', 'computed', 'async', 'generator', 'range', 'comments', 'leadingComments', 'trailingComments']);
    
    for (const key of Object.keys(node)) {
      if (skipKeys.has(key)) continue;
      if (node[key] === null || node[key] === undefined) continue;
      text += this.nodeToTreeText(node[key], indent + 1, key);
    }
    
    return text;
  },
  
  /**
   * Jump to selected node in editor
   */
  jumpToNode() {
    if (this.selectedNode && this.selectedNode.loc) {
      const targetEditor = this.currentSource === 'output' ? 'output' : 'input';
      EditorManager.jumpToPosition(targetEditor, this.selectedNode.loc.start.line, this.selectedNode.loc.start.column + 1);
    }
  },
  
  /**
   * Copy node as JSON
   */
  copyNode() {
    if (this.selectedNode) {
      const clean = this.cleanNodeForCopy(this.selectedNode);
      navigator.clipboard.writeText(JSON.stringify(clean, null, 2))
        .then(() => App.log('Node copied to clipboard', 'success'))
        .catch(() => App.log('Failed to copy', 'error'));
    }
  },
  
  /**
   * Clean node for copying (remove circular refs and loc)
   */
  cleanNodeForCopy(node, seen = new WeakSet()) {
    if (!node || typeof node !== 'object') return node;
    if (seen.has(node)) return '[Circular]';
    seen.add(node);
    
    if (Array.isArray(node)) {
      return node.map(item => this.cleanNodeForCopy(item, seen));
    }
    
    const clean = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
      clean[key] = this.cleanNodeForCopy(value, seen);
    }
    return clean;
  },
  
  /**
   * Helper: Expand, select, and scroll to a node
   */
  _expandSelectAndScroll(nodeId) {
    // Expand all parent nodes
    this.expandParentsOf(nodeId);
    
    // Expand the target node itself if collapsed
    const nodeEl = document.querySelector(`.ast-node[data-node-id="${nodeId}"]`);
    if (nodeEl && nodeEl.classList.contains('collapsed')) {
      nodeEl.classList.remove('collapsed');
      this.expandedNodes.add(nodeId);
    }
    
    // Set flag to prevent jumping back to editor
    this._syncingFromCursor = true;
    this.selectNode(nodeId);
    this._syncingFromCursor = false;
    
    // Scroll node into view
    const header = document.querySelector(`.ast-node-header[data-node-id="${nodeId}"]`);
    if (header) {
      header.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
  
  /**
   * Highlight node at cursor position (called during sync) - debounced for performance
   */
  highlightNodeAtPosition(position) {
    if (!this.ast) return;
    
    const line = position.lineNumber;
    const column = position.column - 1;
    
    // Debounce rapid cursor movements (e.g., during selection or scrolling)
    if (this._highlightDebounceTimer) {
      clearTimeout(this._highlightDebounceTimer);
    }
    
    this._highlightDebounceTimer = setTimeout(() => {
      this._doHighlightNodeAtPosition(line, column);
    }, 50); // 50ms debounce
  },
  
  /**
   * Internal: Actually perform the highlight after debounce
   */
  _doHighlightNodeAtPosition(line, column) {
    // In lazy mode, we need to find and load the path to the node
    if (this._lazyModeActive) {
      this.lazyLoadToPosition(line, column);
      return;
    }
    
    let nodeId = this.findNodeAtPosition(line, column);
    
    // If not found in nodeMap, the node might be truncated
    // Try to find and render the path to it
    if (!nodeId && this._renderLimitHit) {
      nodeId = this._loadTruncatedNodePath(line, column);
    }
    
    if (nodeId) {
      this._expandSelectAndScroll(nodeId);
    }
  },
  
  /**
   * Lazy load nodes to reach a specific position - recursively loads until target is found
   */
  lazyLoadToPosition(line, column, maxIterations = 20) {
    // Find the node path from the AST to the target position
    const path = this.findNodePathAtPosition(this.ast, line, column, []);
    
    if (!path || path.length === 0) return;
    
    const targetNode = path[path.length - 1];
    
    // Check if target is already rendered
    for (const [nodeId, data] of this.nodeMap.entries()) {
      if (data.node === targetNode) {
        // Found it! Select and scroll to it
        this._expandSelectAndScroll(nodeId);
        return;
      }
    }
    
    // Target not rendered yet - need to load lazy nodes in the path
    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;
      
      // Find lazy nodes that contain the target position
      let loadedAny = false;
      
      // Check all lazy nodes for ones containing our position
      for (const [nodeId, lazyData] of this._lazyNodeData.entries()) {
        if (!lazyData) continue;
        
        const node = lazyData.node;
        if (!node || !node.loc) continue;
        
        // Check if this lazy node contains the target position
        const start = node.loc.start;
        const end = node.loc.end;
        const inRange = (
          (line > start.line || (line === start.line && column >= start.column)) &&
          (line < end.line || (line === end.line && column <= end.column))
        );
        
        if (inRange) {
          this.loadLazyNode(nodeId);
          loadedAny = true;
          // Only load one at a time to allow checking if target is now available
          break;
        }
      }
      
      if (!loadedAny) {
        // No more lazy nodes to load at this position
        break;
      }
      
      // Check if target is now rendered
      for (const [nodeId, data] of this.nodeMap.entries()) {
        if (data.node === targetNode) {
          // Found it! Select and scroll to it
          this._expandSelectAndScroll(nodeId);
          return;
        }
      }
    }
    
    // Rebuild indexes
    this.buildPositionIndex();
    if (this._lazyModeActive) {
      this.buildLazyPositionIndex();
    }
    
    // Final attempt - find the closest rendered node
    const nodeId = this.findNodeAtPosition(line, column);
    if (nodeId) {
      this._expandSelectAndScroll(nodeId);
    }
  },
  
  /**
   * Load a truncated node path on-demand (when lazy loading is OFF but tree was truncated)
   * This finds the node in the raw AST and loads any truncated ancestors to reach it
   */
  _loadTruncatedNodePath(line, column) {
    // Find the path in the raw AST
    const path = this.findNodePathAtPosition(this.ast, line, column, []);
    if (!path || path.length === 0) return null;
    
    const targetNode = path[path.length - 1];
    
    // Check if target node is already rendered
    for (const [nodeId, data] of this.nodeMap.entries()) {
      if (data.node === targetNode) {
        return nodeId;
      }
    }
    
    // Find any truncated nodes in the path and load them
    if (this._truncatedNodeData && this._truncatedNodeData.size > 0) {
      for (const [truncId, truncData] of this._truncatedNodeData.entries()) {
        // Check if this truncated node is in the path to our target
        if (path.includes(truncData.node)) {
          const truncEl = document.querySelector(`.ast-truncated[data-trunc-id="${truncId}"]`);
          if (truncEl) {
            this.loadTruncatedNode(truncId, truncEl);
            // After loading, try to find the target again
            for (const [nodeId, data] of this.nodeMap.entries()) {
              if (data.node === targetNode) {
                return nodeId;
              }
            }
            // Recursively try again (in case multiple truncated nodes need loading)
            return this._loadTruncatedNodePath(line, column);
          }
        }
      }
    }
    
    // Find the deepest rendered ancestor and expand from there
    let deepestRenderedId = null;
    
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      for (const [nodeId, data] of this.nodeMap.entries()) {
        if (data.node === node) {
          deepestRenderedId = nodeId;
          break;
        }
      }
      if (deepestRenderedId) break;
    }
    
    if (deepestRenderedId) {
      // Expand to the deepest rendered node
      this.expandParentsOf(deepestRenderedId);
      
      // The target might not be rendered yet if it's past the truncation point
      // In that case, return the closest ancestor
      return deepestRenderedId;
    }
    
    return null;
  },

  /**
   * Find path of nodes from root to position - ITERATIVE version to prevent stack overflow
   */
  findNodePathAtPosition(rootNode, line, column, path) {
    const stack = [{ node: rootNode, path: [] }];
    let bestPath = null;
    
    while (stack.length > 0) {
      const { node, path: currentPath } = stack.pop();
      
      if (!node || typeof node !== 'object') continue;
      
      if (Array.isArray(node)) {
        // Add array items to stack in reverse order (to process first item first)
        for (let i = node.length - 1; i >= 0; i--) {
          stack.push({ node: node[i], path: currentPath });
        }
        continue;
      }
      
      if (!node.loc) continue;
      
      const start = node.loc.start;
      const end = node.loc.end;
      
      const inRange = (
        (line > start.line || (line === start.line && column >= start.column)) &&
        (line < end.line || (line === end.line && column <= end.column))
      );
      
      if (!inRange) continue;
      
      // This node contains the position - add to path
      const newPath = [...currentPath, node];
      
      // Track as best path so far (deeper paths are better)
      if (!bestPath || newPath.length > bestPath.length) {
        bestPath = newPath;
      }
      
      // Add children to stack (in reverse order to process first child first)
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        if (this.skipProps.has(key)) continue;
        const child = node[key];
        if (child && typeof child === 'object') {
          stack.push({ node: child, path: newPath });
        }
      }
    }
    
    return bestPath;
  },
  
  /**
   * Find the most specific node at position - O(1) line lookup with spatial index
   */
  findNodeAtPosition(line, column) {
    // Use line index if available for O(1) line lookup
    if (this._positionCacheEnabled && this._lineIndex && this._lineIndex.size > 0) {
      // Get candidates from lineIndex (which has full node data)
      const lineData = this._lineIndex.get(line);
      if (lineData && lineData.length > 0) {
        // lineIndex entries are sorted by size (smallest first)
        for (const entry of lineData) {
          const data = this.nodeMap.get(entry.nodeId);
          if (!data || !data.node || !data.node.loc) continue;
          
          const node = data.node;
          const start = node.loc.start;
          const end = node.loc.end;
          
          const inRange = (
            (line > start.line || (line === start.line && column >= start.column)) &&
            (line < end.line || (line === end.line && column <= end.column))
          );
          
          if (inRange) {
            return entry.nodeId;
          }
        }
      }
      
      // Check nodes that span multiple lines using _nodesByLine (sorted by size)
      const spanningNodes = this._nodesByLine?.get(line);
      if (spanningNodes && spanningNodes.length > 0) {
        // Already sorted by size (smallest first), so first match is best
        for (const entry of spanningNodes) {
          const data = this.nodeMap.get(entry.nodeId);
          if (!data || !data.node || !data.node.loc) continue;
          
          const node = data.node;
          const start = node.loc.start;
          const end = node.loc.end;
          
          const inRange = (
            (line > start.line || (line === start.line && column >= start.column)) &&
            (line < end.line || (line === end.line && column <= end.column))
          );
          
          if (inRange) {
            return entry.nodeId;
          }
        }
      }
      
      // Fall back to checking nearby lines
      return this._findNodeAtPositionFallback(line, column);
    }
    
    // Fallback to full iteration if index not built
    return this._findNodeAtPositionFallback(line, column);
  },
  
  /**
   * Fallback method for position lookup - searches by line index or full iteration
   */
  _findNodeAtPositionFallback(line, column) {
    let bestMatch = null;
    let bestSize = Infinity;
    
    // Check the line index for all lines up to the target line
    if (this._positionCacheEnabled && this._lineIndex && this._lineIndex.size > 0) {
      // Get sorted line numbers <= target line
      const sortedLines = Array.from(this._lineIndex.keys())
        .filter(l => l <= line)
        .sort((a, b) => b - a)
        .slice(0, 20); // Check last 20 lines max
      
      for (const l of sortedLines) {
        const entries = this._lineIndex.get(l);
        for (const entry of entries) {
          const data = this.nodeMap.get(entry.nodeId);
          if (!data || !data.node || !data.node.loc) continue;
          
          const node = data.node;
          const start = node.loc.start;
          const end = node.loc.end;
          
          const inRange = (
            (line > start.line || (line === start.line && column >= start.column)) &&
            (line < end.line || (line === end.line && column <= end.column))
          );
          
          if (inRange) {
            const size = (end.line - start.line) * 1000 + (end.column - start.column);
            if (size < bestSize) {
              bestSize = size;
              bestMatch = entry.nodeId;
            }
          }
        }
      }
      
      if (bestMatch) return bestMatch;
    }
    
    // Full iteration fallback
    for (const [nodeId, data] of this.nodeMap.entries()) {
      const node = data.node;
      if (!node || !node.loc) continue;
      
      const start = node.loc.start;
      const end = node.loc.end;
      
      const inRange = (
        (line > start.line || (line === start.line && column >= start.column)) &&
        (line < end.line || (line === end.line && column <= end.column))
      );
      
      if (inRange) {
        const size = (end.line - start.line) * 1000 + (end.column - start.column);
        if (size < bestSize) {
          bestSize = size;
          bestMatch = nodeId;
        }
      }
    }
    
    return bestMatch;
  },
  
  /**
   * Expand all parent nodes
   */
  expandParentsOf(nodeId) {
    const nodeEl = document.querySelector(`.ast-node[data-node-id="${nodeId}"]`);
    if (!nodeEl) return;
    
    let parent = nodeEl.parentElement?.closest('.ast-node');
    while (parent) {
      parent.classList.remove('collapsed');
      const parentId = parent.dataset.nodeId;
      if (parentId) this.expandedNodes.add(parentId);
      parent = parent.parentElement?.closest('.ast-node');
    }
  },
  
  /**
   * Expand all nodes
   */
  expandAll() {
    document.querySelectorAll('.ast-node.collapsed').forEach(node => {
      node.classList.remove('collapsed');
      const nodeId = node.dataset.nodeId;
      if (nodeId) this.expandedNodes.add(nodeId);
    });
  },
  
  /**
   * Collapse all nodes
   */
  collapseAll() {
    document.querySelectorAll('.ast-node').forEach(node => {
      const hasChildren = node.querySelector('.ast-node-children');
      if (hasChildren) {
        node.classList.add('collapsed');
        const nodeId = node.dataset.nodeId;
        if (nodeId) this.expandedNodes.delete(nodeId);
      }
    });
  },
  
  /**
   * Toggle input AST live sync mode
   */
  toggleInputSync() {
    this.inputLiveSync = !this.inputLiveSync;
    
    const btn = document.getElementById('btn-sync-input-ast');
    if (btn) {
      btn.classList.toggle('active', this.inputLiveSync);
      btn.title = this.inputLiveSync 
        ? 'Input AST Sync ON - Click to disable' 
        : 'Sync Input AST with cursor';
    }
    
    if (this.inputLiveSync) {
      // Switch to input tab and parse
      this.switchSource('input');
      this.updateFromCode(EditorManager.getInput());
      App.log('Input AST Sync ON', 'info');
    } else {
      App.log('Input AST Sync OFF', 'info');
    }
  },
  
  /**
   * Toggle output AST live sync mode
   */
  toggleOutputSync() {
    this.outputLiveSync = !this.outputLiveSync;
    
    const btn = document.getElementById('btn-sync-output-ast');
    if (btn) {
      btn.classList.toggle('active', this.outputLiveSync);
      btn.title = this.outputLiveSync 
        ? 'Output AST Sync ON - Click to disable' 
        : 'Sync Output AST with cursor';
    }
    
    if (this.outputLiveSync) {
      // Switch to output tab and parse
      this.switchSource('output');
      this.updateOutputAST(EditorManager.getOutput());
      App.log('Output AST Sync ON', 'info');
    } else {
      App.log('Output AST Sync OFF', 'info');
    }
  },
  
  /**
   * Copy entire AST as tree text
   */
  copyFullTree() {
    if (!this.ast) {
      App.log('No AST to copy', 'warn');
      return;
    }
    
    const text = this.nodeToTreeText(this.ast, 0, '');
    navigator.clipboard.writeText(text)
      .then(() => App.log('Full AST tree copied', 'success'))
      .catch(() => App.log('Failed to copy', 'error'));
  },
  
  /**
   * Show error message
   */
  showError(message) {
    const container = document.getElementById('ast-tree');
    if (container) {
      // Check for stack overflow errors (common with deeply nested JSFuck code)
      const isStackOverflow = message.includes('Maximum call stack') || 
                              message.includes('stack size exceeded');
      
      if (isStackOverflow) {
        container.innerHTML = `
          <div class="ast-warning">
            <div class="ast-warning-icon">⚠️</div>
            <div class="ast-warning-title">Code Too Complex to Parse</div>
            <div class="ast-warning-message">
              The code has extremely deep nesting that exceeds the parser's stack limit.<br>
              This is common with JSFuck-style or heavily obfuscated code.
            </div>
            <div class="ast-warning-tips">
              <strong>Tips:</strong>
              <ul>
                <li>Run the transforms anyway - they may still work!</li>
                <li>The AST viewer just can't display it, but transforms operate on the server</li>
                <li>Try running <strong>ConstantFolding</strong> first to simplify the code</li>
                <li>After simplification, the AST may become viewable</li>
              </ul>
            </div>
          </div>
        `;
      } else {
        container.innerHTML = `
          <div class="ast-error">
            <strong>Parse Error</strong><br>
            ${this.escapeHtml(message)}
          </div>
        `;
      }
    }
  },
  
  /**
   * Clear AST view
   */
  clear() {
    this.ast = null;
    this.selectedNode = null;
    this.nodeMap.clear();
    
    const treeContainer = document.getElementById('ast-tree');
    if (treeContainer) {
      treeContainer.innerHTML = '<div class="ast-empty">Parse code to view AST</div>';
    }
    
    const detailsContainer = document.getElementById('ast-details');
    if (detailsContainer) {
      detailsContainer.innerHTML = '<div class="ast-details-empty">Select a node to view details</div>';
    }
  }
};

/**
 * Scope Analyzer Module
 */
const ScopeAnalyzer = {
  scopes: [],
  inputScopes: [],
  outputScopes: [],
  currentSource: 'input',
  selectedBinding: null,
  
  init() {
    document.getElementById('btn-refresh-scope')?.addEventListener('click', () => {
      this.refresh();
    });
    
    // Scope search
    const searchInput = document.getElementById('scope-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.filterBindings(e.target.value);
      });
      
      // Clear search on Escape
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          this.filterBindings('');
        }
      });
    }
    
    // Scope source tab switching
    document.querySelectorAll('.scope-source-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchSource(tab.dataset.source);
      });
    });
    
    // Auto-switch scope tab when editor is focused
    window.addEventListener('editor-focused', (e) => {
      if (e.detail.editor !== this.currentSource) {
        this.switchSource(e.detail.editor);
      }
    });
    
    // Sync from cursor position
    window.addEventListener('cursor-changed', (e) => {
      if (e.detail.editor === 'input' && this.currentSource === 'input') {
        this.highlightBindingAtPosition(e.detail.position);
      } else if (e.detail.editor === 'output' && this.currentSource === 'output') {
        this.highlightBindingAtPosition(e.detail.position);
      }
    });
  },
  
  /**
   * Refresh scope analysis for current source
   */
  refresh() {
    if (this.currentSource === 'input') {
      this.analyze(EditorManager.getInput(), 'input');
    } else {
      this.analyze(EditorManager.getOutput(), 'output');
    }
  },
  
  /**
   * Switch between input and output scope
   */
  async switchSource(source) {
    this.currentSource = source;
    
    // Update tab UI
    document.querySelectorAll('.scope-source-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.source === source);
    });
    
    // Get code for the selected source
    const code = source === 'input' ? EditorManager.getInput() : EditorManager.getOutput();
    
    // Check if we have cached scopes for this source
    const cachedScopes = source === 'input' ? this.inputScopes : this.outputScopes;
    
    if (cachedScopes && cachedScopes.length > 0) {
      this.scopes = cachedScopes;
      this.render();
    } else if (code && code.trim()) {
      // Parse and cache
      await this.analyze(code, source);
    } else {
      this.clear();
    }
  },
  
  /**
   * Update output scope (called when transforms complete)
   */
  async updateOutputScope(code) {
    if (!code || !code.trim()) {
      this.outputScopes = [];
      return;
    }
    
    try {
      const result = await API.analyzeScope(code);
      if (result.success) {
        this.outputScopes = result.scopes;
        
        // If currently viewing output, re-render
        if (this.currentSource === 'output') {
          this.scopes = this.outputScopes;
          this.render();
        }
      }
    } catch (error) {
      console.error('Error analyzing output scope:', error);
    }
  },
  
  async analyze(code, source = 'input') {
    if (!code || !code.trim()) {
      this.clear();
      return;
    }
    
    try {
      const result = await API.analyzeScope(code);
      if (result.success) {
        // Cache based on source
        if (source === 'input') {
          this.inputScopes = result.scopes;
        } else {
          this.outputScopes = result.scopes;
        }
        
        // If this is the current source, display it
        if (this.currentSource === source) {
          this.scopes = result.scopes;
          this.render();
        }
      }
    } catch (error) {
      console.error('Failed to analyze scope:', error);
      this.showError(error.message);
    }
  },
  
  render() {
    const container = document.getElementById('scope-tree');
    if (!container || this.scopes.length === 0) {
      if (container) {
        container.innerHTML = '<div class="scope-empty">Analyze code to view scopes</div>';
      }
      return;
    }
    
    let html = '';
    
    for (let i = 0; i < this.scopes.length; i++) {
      html += this.renderScope(this.scopes[i], i, 0);
    }
    
    container.innerHTML = html;
    this.attachListeners();
  },
  
  renderScope(scope, index, depth) {
    const bindingCount = Object.keys(scope.bindings).length;
    const scopeLoc = scope.loc || {};
    const startLine = scopeLoc.start?.line || 0;
    const endLine = scopeLoc.end?.line || 0;
    
    let html = `
      <div class="scope-item" data-index="${index}" data-start-line="${startLine}" data-end-line="${endLine}">
        <div class="scope-header" style="padding-left: ${depth * 16 + 8}px;">
          <span class="scope-toggle">▶</span>
          <span class="scope-type">${scope.type}</span>
          <span class="scope-count">(${bindingCount} bindings)</span>
          ${startLine ? `<span class="scope-line">L${startLine}</span>` : ''}
        </div>
    `;
    
    if (bindingCount > 0) {
      html += `<div class="scope-bindings">`;
      
      for (const [name, binding] of Object.entries(scope.bindings)) {
        const refs = binding.references || [];
        const refCount = refs.length;
        const line = binding.loc?.start?.line || 0;
        const col = binding.loc?.start?.column || 0;
        const endLine = binding.loc?.end?.line || line;
        const endCol = binding.loc?.end?.column || col;
        
        // Build references data attribute
        const refsData = refs
          .filter(ref => ref.line)
          .map(ref => `${ref.line}:${ref.column || 0}`)
          .join(',');
        
        const hasRefs = refCount > 0;
        
        html += `
          <div class="binding-item ${hasRefs ? 'has-refs' : ''}" 
               data-name="${name}" 
               data-line="${line}" 
               data-col="${col}"
               data-end-line="${endLine}"
               data-end-col="${endCol}"
               data-refs="${refsData}"
               style="padding-left: ${depth * 16 + 24}px;">
            <div class="binding-header">
              ${hasRefs ? '<span class="binding-toggle">▶</span>' : '<span class="binding-toggle-placeholder"></span>'}
              <span class="binding-name">${name}</span>
              <span class="binding-kind">${binding.kind}</span>
              <span class="binding-refs ${hasRefs ? 'clickable' : ''}">${refCount} ref${refCount !== 1 ? 's' : ''}</span>
              ${binding.constant ? '<span class="binding-const">const</span>' : ''}
            </div>`;
        
        // Add references list if there are any
        if (hasRefs) {
          html += `<div class="binding-refs-list" style="padding-left: ${depth * 16 + 40}px;">`;
          
          refs.forEach((ref, refIndex) => {
            if (ref.line) {
              const refType = ref.type || 'reference';
              const refIcon = refType === 'write' ? '✎' : refType === 'declaration' ? '◆' : '→';
              const refLabel = refType === 'write' ? 'write' : refType === 'declaration' ? 'decl' : 'read';
              
              html += `
                <div class="binding-ref-item" 
                     data-line="${ref.line}" 
                     data-col="${ref.column || 0}"
                     data-name="${name}"
                     title="Line ${ref.line}, Col ${ref.column || 0}">
                  <span class="ref-icon">${refIcon}</span>
                  <span class="ref-location">L${ref.line}:${ref.column || 0}</span>
                  <span class="ref-type">${refLabel}</span>
                </div>
              `;
            }
          });
          
          html += `</div>`;
        }
        
        html += `</div>`;
      }
      
      html += `</div>`;
    }
    
    html += `</div>`;
    
    return html;
  },
  
  attachListeners() {
    document.querySelectorAll('.scope-header').forEach(header => {
      header.addEventListener('click', () => {
        const item = header.closest('.scope-item');
        item.classList.toggle('collapsed');
      });
      
      // Prevent default context menu on scope headers
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    });
    
    // Capture current source for use in click handler
    const targetEditor = this.currentSource === 'output' ? 'output' : 'input';
    
    // Binding header click - show references list immediately
    document.querySelectorAll('.binding-header').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const bindingItem = header.closest('.binding-item');
        
        // Select this binding
        this.selectBinding(bindingItem);
        
        // If it has refs, expand the list automatically
        if (bindingItem.classList.contains('has-refs')) {
          // Collapse any other expanded binding first
          document.querySelectorAll('.binding-item.refs-expanded').forEach(el => {
            if (el !== bindingItem) {
              el.classList.remove('refs-expanded');
            }
          });
          
          // Expand this one
          bindingItem.classList.add('refs-expanded');
        }
        
        // Jump to declaration in editor
        const line = parseInt(bindingItem.dataset.line);
        if (line > 0) {
          EditorManager.jumpToPosition(targetEditor, line, 1);
        }
      });
      
      // Prevent default context menu on binding headers
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    });
    
    // Binding toggle - expand/collapse refs list
    document.querySelectorAll('.binding-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const bindingItem = toggle.closest('.binding-item');
        bindingItem.classList.toggle('refs-expanded');
      });
    });
    
    // Refs count click - toggle refs list
    document.querySelectorAll('.binding-refs.clickable').forEach(refsLabel => {
      refsLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        const bindingItem = refsLabel.closest('.binding-item');
        bindingItem.classList.toggle('refs-expanded');
      });
    });
    
    // Reference item click - jump to location and highlight in AST
    document.querySelectorAll('.binding-ref-item').forEach(refItem => {
      refItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const line = parseInt(refItem.dataset.line);
        const col = parseInt(refItem.dataset.col) || 0;
        const name = refItem.dataset.name;
        
        if (line > 0) {
          // Jump to position in editor
          EditorManager.jumpToPosition(targetEditor, line, col + 1);
          
          // Try to find and highlight in AST
          this.highlightIdentifierInAST(name, line, col);
          
          // Visual feedback on the ref item
          refItem.classList.add('ref-active');
          setTimeout(() => refItem.classList.remove('ref-active'), 500);
        }
      });
      
      // Prevent default context menu on ref items
      refItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    });
    
    // Prevent context menu on scope tree container
    const scopeTree = document.getElementById('scope-tree');
    if (scopeTree) {
      scopeTree.addEventListener('contextmenu', (e) => {
        e.preventDefault();
      });
    }
  },
  
  /**
   * Highlight an identifier in the AST viewer at specific location
   */
  highlightIdentifierInAST(name, line, col) {
    // Switch to AST tab
    const astTab = document.querySelector('.tool-tab[data-tab="ast"]');
    if (astTab && !astTab.classList.contains('active')) {
      astTab.click();
    }
    
    // Find matching node in AST
    setTimeout(() => {
      const astNodes = document.querySelectorAll('.ast-node-header');
      let bestMatch = null;
      
      for (const node of astNodes) {
        const nodeType = node.querySelector('.ast-node-type')?.textContent;
        const nodeName = node.querySelector('.ast-node-name')?.textContent;
        const nodeLoc = node.dataset.startLine;
        
        // Match Identifier with same name and line
        if (nodeType === 'Identifier' && nodeName === name && parseInt(nodeLoc) === line) {
          bestMatch = node;
          break;
        }
      }
      
      if (bestMatch) {
        // Expand parents if needed
        let parent = bestMatch.closest('.ast-children');
        while (parent) {
          const parentNode = parent.closest('.ast-node');
          if (parentNode && parentNode.classList.contains('collapsed')) {
            parentNode.classList.remove('collapsed');
          }
          parent = parentNode?.parentElement?.closest('.ast-children');
        }
        
        // Highlight and scroll
        document.querySelectorAll('.ast-node-header.highlighted').forEach(el => {
          el.classList.remove('highlighted');
        });
        bestMatch.classList.add('highlighted');
        bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // Flash effect
        bestMatch.classList.add('ast-flash');
        setTimeout(() => bestMatch.classList.remove('ast-flash'), 800);
      }
    }, 100);
  },
  
  /**
   * Select a binding visually
   */
  selectBinding(bindingEl) {
    // Remove previous selection
    document.querySelectorAll('.binding-item.selected').forEach(el => {
      el.classList.remove('selected');
    });
    
    if (bindingEl) {
      bindingEl.classList.add('selected');
      this.selectedBinding = bindingEl.dataset.name;
    } else {
      this.selectedBinding = null;
    }
  },
  
  /**
   * Highlight binding at cursor position
   */
  highlightBindingAtPosition(position) {
    if (this.scopes.length === 0) return;
    
    const line = position.lineNumber;
    const column = position.column - 1;
    
    // Find binding that matches this position
    let bestMatch = null;
    let bestDistance = Infinity;
    
    document.querySelectorAll('.binding-item').forEach(item => {
      const bindingLine = parseInt(item.dataset.line) || 0;
      const bindingCol = parseInt(item.dataset.col) || 0;
      const bindingEndLine = parseInt(item.dataset.endLine) || bindingLine;
      const bindingEndCol = parseInt(item.dataset.endCol) || bindingCol;
      
      // Check if cursor is on the binding declaration
      const onDeclaration = (
        (line > bindingLine || (line === bindingLine && column >= bindingCol)) &&
        (line < bindingEndLine || (line === bindingEndLine && column <= bindingEndCol))
      );
      
      if (onDeclaration) {
        bestMatch = item;
        bestDistance = 0;
        return;
      }
      
      // Check if cursor is on any reference
      const refs = item.dataset.refs;
      if (refs) {
        refs.split(',').forEach(ref => {
          if (!ref) return;
          const [refLine, refCol] = ref.split(':').map(Number);
          // Check if cursor is near this reference (same line, within ~20 chars)
          if (line === refLine && Math.abs(column - refCol) < 20) {
            const dist = Math.abs(column - refCol);
            if (dist < bestDistance) {
              bestDistance = dist;
              bestMatch = item;
            }
          }
        });
      }
    });
    
    if (bestMatch) {
      // Expand parent scope if collapsed
      const scopeItem = bestMatch.closest('.scope-item');
      if (scopeItem && scopeItem.classList.contains('collapsed')) {
        scopeItem.classList.remove('collapsed');
      }
      
      this.selectBinding(bestMatch);
      
      // Scroll into view
      bestMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },
  
  /**
   * Highlight scope containing current cursor position
   */
  highlightScopeAtPosition(position) {
    const line = position.lineNumber;
    
    // Find innermost scope containing this line
    let bestMatch = null;
    let smallestRange = Infinity;
    
    document.querySelectorAll('.scope-item').forEach(item => {
      const startLine = parseInt(item.dataset.startLine) || 0;
      const endLine = parseInt(item.dataset.endLine) || 0;
      
      if (startLine && endLine && line >= startLine && line <= endLine) {
        const range = endLine - startLine;
        if (range < smallestRange) {
          smallestRange = range;
          bestMatch = item;
        }
      }
    });
    
    // Remove previous scope highlight
    document.querySelectorAll('.scope-item.highlighted').forEach(el => {
      el.classList.remove('highlighted');
    });
    
    if (bestMatch) {
      bestMatch.classList.add('highlighted');
      if (bestMatch.classList.contains('collapsed')) {
        bestMatch.classList.remove('collapsed');
      }
    }
  },
  
  /**
   * Filter bindings by search query
   */
  filterBindings(query) {
    const searchCountEl = document.getElementById('scope-search-count');
    const normalizedQuery = query.toLowerCase().trim();
    
    // Get all binding items and scope items
    const bindingItems = document.querySelectorAll('.binding-item');
    const scopeItems = document.querySelectorAll('.scope-item');
    
    if (!normalizedQuery) {
      // Clear all filtering
      bindingItems.forEach(item => {
        item.classList.remove('search-hidden', 'search-match');
      });
      scopeItems.forEach(scope => {
        scope.classList.remove('search-hidden', 'has-search-match');
      });
      if (searchCountEl) searchCountEl.textContent = '';
      return;
    }
    
    let matchCount = 0;
    const matchedScopes = new Set();
    
    // Filter bindings
    bindingItems.forEach(item => {
      const name = item.dataset.name?.toLowerCase() || '';
      const kind = item.querySelector('.binding-kind')?.textContent?.toLowerCase() || '';
      
      // Match against name or kind
      const matches = name.includes(normalizedQuery) || kind.includes(normalizedQuery);
      
      if (matches) {
        item.classList.remove('search-hidden');
        item.classList.add('search-match');
        matchCount++;
        
        // Mark parent scope as having a match
        const parentScope = item.closest('.scope-item');
        if (parentScope) {
          matchedScopes.add(parentScope);
        }
      } else {
        item.classList.add('search-hidden');
        item.classList.remove('search-match');
      }
    });
    
    // Show/hide scopes based on whether they have matches
    scopeItems.forEach(scope => {
      if (matchedScopes.has(scope)) {
        scope.classList.remove('search-hidden', 'collapsed');
        scope.classList.add('has-search-match');
      } else {
        // Check if any child bindings are visible
        const visibleBindings = scope.querySelectorAll('.binding-item:not(.search-hidden)');
        if (visibleBindings.length === 0) {
          scope.classList.add('search-hidden');
          scope.classList.remove('has-search-match');
        } else {
          scope.classList.remove('search-hidden', 'collapsed');
          scope.classList.add('has-search-match');
        }
      }
    });
    
    // Update count display
    if (searchCountEl) {
      searchCountEl.textContent = matchCount > 0 ? `${matchCount} found` : 'No matches';
      searchCountEl.className = 'scope-search-count ' + (matchCount > 0 ? 'has-matches' : 'no-matches');
    }
    
    // Scroll to first match
    if (matchCount > 0) {
      const firstMatch = document.querySelector('.binding-item.search-match');
      if (firstMatch) {
        firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  },

  showError(message) {
    const container = document.getElementById('scope-tree');
    if (container) {
      container.innerHTML = `<div class="scope-error">${message}</div>`;
    }
  },
  
  clear() {
    this.scopes = [];
    const container = document.getElementById('scope-tree');
    if (container) {
      container.innerHTML = '<div class="scope-empty">Analyze code to view scopes</div>';
    }
  }
};

// Export
window.ASTViewer = ASTViewer;
window.ScopeAnalyzer = ScopeAnalyzer;
