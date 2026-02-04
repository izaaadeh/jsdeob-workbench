/**
 * Main Application Module
 */

const App = {
  currentProject: null,
  projectModified: false, // Track if current project has unsaved changes
  lastSavedState: null, // Snapshot of project state at last save
  stepCode: null, // Code at current step (for step-through mode)
  autoParseTimeout: null,
  autoRunEnabled: false,
  singleEditorMode: false, // Single editor mode - transforms apply directly to input
  autoRunTimeout: null,
  autoRunDelay: 500, // ms delay before auto-running (optimized for responsiveness)
  isRunning: false, // Flag to prevent recursive runs
  isCancelling: false, // Flag for cancellation state
  
  // Script panel tabs
  scriptTabs: [], // Array of { id, name, code, modified }
  activeTabId: null,
  tabCounter: 0,
  
  // Debounce helper
  _debounceTimers: {},
  debounce(key, fn, delay) {
    if (this._debounceTimers[key]) {
      clearTimeout(this._debounceTimers[key]);
    }
    this._debounceTimers[key] = setTimeout(() => {
      delete this._debounceTimers[key];
      fn();
    }, delay);
  },
  
  /**
   * Initialize the application
   */
  async init() {
    console.log('Initializing JS Deobfuscation Workbench...');
    
    try {
      // Initialize Monaco Editor
      await EditorManager.init();
      console.log('Editor initialized');
      
      // Initialize Web Worker for heavy operations (non-blocking)
      API.initWorker().then(() => {
        console.log('Transform worker initialized');
      }).catch(err => {
        console.warn('Worker init failed, using server fallback:', err);
      });
      
      // Initialize Recipe Manager
      await RecipeManager.init();
      console.log('Recipe Manager initialized');
      
      // Initialize AST Viewer
      ASTViewer.init();
      ScopeAnalyzer.init();
      console.log('AST Viewer initialized');
      
      // Initialize String Decoder
      StringDecoder.init();
      console.log('String Decoder initialized');
      
      // Setup UI event listeners
      this.setupEventListeners();
      this.setupResizeHandlers();
      this.setupKeyboardShortcuts();
      
      // Load projects list
      await this.loadProjectsList();
      
      // Load and apply saved settings (or defaults)
      const savedSettings = this.loadSettings() || {
        defaults: { auto: true, single: false, simple: false },
        ast: { showComments: true, showLoc: false, showExtra: true, showTokens: true }
      };
      this.applySettings(savedSettings);
      
      // Set sample code
      this.setSampleCode();
      
      // Setup beforeunload handler for unsaved changes
      this.setupBeforeUnload();
      
      // Setup content change tracking for project indicator
      this.setupContentChangeTracking();
      
      console.log('Application initialized successfully');
      this.log('Ready', 'success');
    } catch (error) {
      console.error('Failed to initialize application:', error);
      this.log(`Initialization error: ${error.message}`, 'error');
    }
  },
  
  /**
   * Setup beforeunload handler to warn about unsaved changes
   */
  setupBeforeUnload() {
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = ''; // Chrome requires returnValue to be set
        return ''; // Some browsers show this message, others show generic
      }
    });
  },
  
  /**
   * Setup content change tracking to update project indicator
   */
  setupContentChangeTracking() {
    // Debounced update for project indicator
    let updateTimeout = null;
    const debouncedUpdate = () => {
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        this.updateProjectIndicator();
      }, 300);
    };
    
    // Listen for input editor changes
    window.addEventListener('input-changed', debouncedUpdate);
    
    // Listen for output changes
    window.addEventListener('output-changed', debouncedUpdate);
    
    // Listen for recipe chain changes
    window.addEventListener('chain-changed', debouncedUpdate);
  },
  
  /**
   * Check if there are any unsaved changes
   */
  hasUnsavedChanges() {
    // Check for modified script panel tabs
    if (this.scriptTabs.some(tab => tab.modified)) {
      return true;
    }
    
    // Check if project has unsaved changes
    if (this.isProjectModified()) {
      return true;
    }
    
    return false;
  },
  
  /**
   * Check if the current project state differs from last saved state
   */
  isProjectModified() {
    const currentState = this.getProjectState();
    
    // If no project loaded and we have content, it's unsaved
    if (!this.currentProject) {
      const hasContent = currentState.inputCode.trim() || 
                         currentState.outputCode.trim() || 
                         currentState.recipe.length > 0;
      return hasContent;
    }
    
    // Compare to last saved state
    if (!this.lastSavedState) {
      return true; // No saved state to compare, assume modified
    }
    
    return currentState.inputCode !== this.lastSavedState.inputCode ||
           currentState.outputCode !== this.lastSavedState.outputCode ||
           JSON.stringify(currentState.recipe) !== JSON.stringify(this.lastSavedState.recipe);
  },
  
  /**
   * Get current project state for comparison
   */
  getProjectState() {
    return {
      inputCode: EditorManager.getInput() || '',
      outputCode: EditorManager.getOutput() || '',
      recipe: RecipeManager.getChainData() || []
    };
  },
  
  /**
   * Mark project as saved (update last saved state)
   */
  markProjectSaved() {
    this.lastSavedState = this.getProjectState();
    this.projectModified = false;
    this.updateProjectIndicator();
  },
  
  /**
   * Update project modified indicator in UI
   */
  updateProjectIndicator() {
    const select = document.getElementById('project-select');
    const isModified = this.isProjectModified();
    
    // Update document title to show unsaved indicator
    const baseTitle = 'JS Deobfuscation Workbench';
    if (this.currentProject) {
      document.title = (isModified ? '● ' : '') + this.currentProject.name + ' - ' + baseTitle;
    } else if (isModified) {
      document.title = '● Unsaved Project - ' + baseTitle;
    } else {
      document.title = baseTitle;
    }
  },
  
  /**
   * Setup all event listeners
   */
  setupEventListeners() {
    // Header buttons
    document.getElementById('btn-new-project')?.addEventListener('click', () => this.newProject());
    document.getElementById('btn-save-project')?.addEventListener('click', () => this.openSaveModal());
    document.getElementById('btn-import')?.addEventListener('click', () => this.importProject());
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportProject());
    document.getElementById('btn-settings')?.addEventListener('click', () => this.openSettings());
    
    // Project selector with unsaved changes check
    document.getElementById('project-select')?.addEventListener('change', (e) => {
      if (e.target.value) {
        // Check for unsaved changes before switching
        if (this.isProjectModified()) {
          // Revert selection immediately (modal will handle the actual switch)
          const targetProjectId = e.target.value;
          e.target.value = this.currentProject?.id || '';
          this.showUnsavedChangesModal('loadProject', targetProjectId);
          return;
        }
        this.loadProject(e.target.value);
      }
    });
    
    // Editor buttons
    document.getElementById('btn-clear-input')?.addEventListener('click', () => {
      EditorManager.clearInput();
      EditorManager.focusInput();
      this.log('Input cleared');
    });
    
    document.getElementById('btn-lock-input')?.addEventListener('click', () => {
      EditorManager.toggleInputLock();
    });
    
    document.getElementById('btn-lock-output')?.addEventListener('click', () => {
      EditorManager.toggleOutputLock();
    });
    
    // Word wrap toggles
    document.getElementById('btn-wrap-input')?.addEventListener('click', (e) => {
      const isWrapped = EditorManager.toggleInputWordWrap();
      e.currentTarget.classList.toggle('active', isWrapped);
      this.log(isWrapped ? 'Input word wrap enabled' : 'Input word wrap disabled');
    });
    
    document.getElementById('btn-wrap-output')?.addEventListener('click', (e) => {
      const isWrapped = EditorManager.toggleOutputWordWrap();
      e.currentTarget.classList.toggle('active', isWrapped);
      this.log(isWrapped ? 'Output word wrap enabled' : 'Output word wrap disabled');
    });
    
    document.getElementById('btn-format-input')?.addEventListener('click', () => this.formatInput());
    document.getElementById('btn-paste-input')?.addEventListener('click', () => this.pasteFromClipboard());
    document.getElementById('btn-copy-output')?.addEventListener('click', () => this.copyOutput());
    document.getElementById('btn-use-as-input')?.addEventListener('click', () => this.useOutputAsInput());
    document.getElementById('btn-toggle-diff')?.addEventListener('click', () => EditorManager.toggleDiff('initial'));
    document.getElementById('btn-diff-step')?.addEventListener('click', () => EditorManager.toggleDiff('step'));
    
    // Step diff navigation buttons
    document.getElementById('diff-step-prev')?.addEventListener('click', () => EditorManager.prevStepDiff());
    document.getElementById('diff-step-next')?.addEventListener('click', () => EditorManager.nextStepDiff());
    
    // Diff mode dropdown
    const diffModeSelect = document.getElementById('diff-mode-select');
    if (diffModeSelect) {
      // Load saved preference
      const savedMode = localStorage.getItem('diffMode') || 'sideBySide';
      diffModeSelect.value = savedMode;
      
      diffModeSelect.addEventListener('change', (e) => {
        localStorage.setItem('diffMode', e.target.value);
        // If diff is currently active, refresh it
        if (EditorManager.isDiffMode) {
          const currentType = EditorManager.diffType;
          EditorManager.toggleDiff(currentType); // Turn off
          EditorManager.toggleDiff(currentType); // Turn on with new mode
        }
      });
    }
    
    // Action bar buttons
    document.getElementById('undo-btn')?.addEventListener('click', () => EditorManager.undo());
    document.getElementById('redo-btn')?.addEventListener('click', () => EditorManager.redo());
    document.getElementById('swap-btn')?.addEventListener('click', () => {
      EditorManager.swapInputOutput();
      this.log('Swapped input and output');
    });
    document.getElementById('apply-to-input-btn')?.addEventListener('click', () => this.useOutputAsInput());
    document.getElementById('edit-mode-btn')?.addEventListener('click', () => {
      const isEdit = EditorManager.toggleEditMode();
      this.log(isEdit ? 'Edit mode enabled - output is now editable' : 'View mode enabled - output is read-only');
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Skip shortcuts when in Monaco editor - let Monaco handle its own keys
      const inMonacoEditor = e.target.closest('.monaco-editor');
      const inSimpleEditor = e.target.classList.contains('simple-editor');
      
      // Ctrl+Enter: Apply output to input
      if (e.ctrlKey && e.key === 'Enter' && !inMonacoEditor) {
        e.preventDefault();
        this.useOutputAsInput();
      }
      // Ctrl+Shift+E: Toggle edit mode
      if (e.ctrlKey && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        const isEdit = EditorManager.toggleEditMode();
        this.log(isEdit ? 'Edit mode enabled' : 'View mode enabled');
      }
      // Ctrl+Shift+S: Toggle single editor mode
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        const checkbox = document.getElementById('single-editor-checkbox');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          this.singleEditorMode = checkbox.checked;
          this.toggleSingleEditorMode(this.singleEditorMode);
        }
      }
      // Escape: Close modals or focus input
      if (e.key === 'Escape' && !inSimpleEditor) {
        const openModal = document.querySelector('.modal.active');
        if (openModal) {
          this.closeAllModals();
        }
      }
      // Ctrl+Shift+P: Toggle simple/plain text mode
      if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        const checkbox = document.getElementById('simple-mode-checkbox');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          EditorManager.enableSimpleMode(checkbox.checked);
        }
      }
    });
    
    // Recipe chain controls
    document.getElementById('btn-run-all')?.addEventListener('click', () => this.runAll());
    document.getElementById('btn-step')?.addEventListener('click', () => this.runStep());
    document.getElementById('btn-reset')?.addEventListener('click', () => this.reset());
    document.getElementById('btn-open-eval')?.addEventListener('click', () => this.toggleEvalPanel());
    
    // Eval Panel controls
    document.getElementById('btn-close-eval-panel')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeEvalPanel();
    });
    document.getElementById('btn-eval-run')?.addEventListener('click', () => this.runEvalPanel());
    document.getElementById('btn-eval-clear')?.addEventListener('click', () => this.clearEvalPanel());
    document.getElementById('btn-eval-wrap')?.addEventListener('click', () => this.toggleEvalWrap());
    this.setupEvalPanelResize();
    
    // Chain expand/collapse/enable/disable buttons
    document.getElementById('btn-expand-chain')?.addEventListener('click', () => RecipeManager.expandAllCards());
    document.getElementById('btn-collapse-chain')?.addEventListener('click', () => RecipeManager.collapseAllCards());
    document.getElementById('btn-enable-all-chain')?.addEventListener('click', () => RecipeManager.enableAll());
    document.getElementById('btn-disable-all-chain')?.addEventListener('click', () => RecipeManager.disableAll());
    
    // Summary tab refresh
    document.getElementById('btn-refresh-summary')?.addEventListener('click', () => this.refreshSummary());
    
    // Sidebar toggle
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('collapsed');
      setTimeout(() => EditorManager.layout(), 300);
    });
    
    // Tools panel toggle
    document.getElementById('btn-toggle-tools')?.addEventListener('click', () => {
      document.getElementById('tools-panel')?.classList.toggle('collapsed');
      setTimeout(() => EditorManager.layout(), 300);
    });
    
    // Tools tabs
    document.querySelectorAll('.tool-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchToolTab(tab.dataset.tab));
    });
    
    // Console toggle
    document.getElementById('console-header')?.addEventListener('click', () => {
      document.getElementById('console-container')?.classList.toggle('expanded');
    });
    
    document.getElementById('btn-toggle-console')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('console-container')?.classList.toggle('expanded');
    });
    
    document.getElementById('btn-clear-console')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearConsole();
    });
    
    // Console tabs
    document.querySelectorAll('.console-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchConsoleTab(tab.dataset.tab);
      });
    });
    
    // New Script button - opens script panel
    document.getElementById('btn-new-script')?.addEventListener('click', () => this.openScriptPanel());
    
    // Script Panel (right side, always visible when open)
    document.getElementById('btn-close-script-panel')?.addEventListener('click', () => this.closeScriptPanel());
    document.getElementById('btn-script-run')?.addEventListener('click', () => this.runScriptPanel());
    document.getElementById('btn-script-add')?.addEventListener('click', () => this.addScriptToChain());
    document.getElementById('btn-script-save')?.addEventListener('click', () => this.saveScriptPanelAsPlugin());
    document.getElementById('btn-script-new')?.addEventListener('click', () => this.newScriptPanel());
    document.getElementById('btn-script-wrap')?.addEventListener('click', () => this.toggleScriptWrap());
    this.setupScriptPanelResize();
    
    // Script panel name input - update tab name on change
    document.getElementById('script-panel-name')?.addEventListener('input', () => this.updateCurrentTabName());
    document.getElementById('script-panel-name')?.addEventListener('blur', () => this.updateCurrentTabName());
    
    // Save as Plugin modal (with folder selection and parameters)
    document.getElementById('btn-confirm-save-plugin')?.addEventListener('click', () => this.confirmSaveAsPlugin());
    document.getElementById('btn-add-plugin-param')?.addEventListener('click', () => this.addPluginParam());
    document.getElementById('plugin-params-list')?.addEventListener('click', (e) => {
      if (e.target.closest('.btn-remove-param')) {
        e.target.closest('.plugin-param-row')?.remove();
      }
    });
    
    // Plugin editor (for editing existing plugins)
    document.getElementById('btn-new-plugin')?.addEventListener('click', () => this.openPluginEditor());
    document.getElementById('btn-reload-plugins')?.addEventListener('click', () => this.reloadPlugins());
    document.getElementById('btn-save-plugin')?.addEventListener('click', () => this.savePlugin());
    document.getElementById('btn-delete-plugin')?.addEventListener('click', () => this.deletePlugin());
    document.getElementById('btn-save-draft')?.addEventListener('click', () => this.saveAsDraft());
    document.getElementById('btn-apply-to-chain')?.addEventListener('click', () => this.applyToChainItem());
    document.getElementById('btn-save-as-inline')?.addEventListener('click', () => this.saveAsInline());
    
    // Recipe config modal
    document.getElementById('btn-apply-config')?.addEventListener('click', () => RecipeManager.applyConfig());
    
    // Save project modal
    document.getElementById('btn-confirm-save')?.addEventListener('click', () => this.saveProject());
    document.getElementById('btn-cancel-save')?.addEventListener('click', () => this.closeModal('modal-save-project'));
    
    // Unsaved changes confirmation modal
    document.getElementById('btn-unsaved-save')?.addEventListener('click', () => this.handleUnsavedSave());
    document.getElementById('btn-unsaved-discard')?.addEventListener('click', () => this.handleUnsavedDiscard());
    document.getElementById('btn-unsaved-cancel')?.addEventListener('click', () => this.handleUnsavedCancel());
    
    // Settings modal
    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettings());
    
    // Project manager modal
    document.getElementById('btn-edit-project')?.addEventListener('click', () => this.openProjectManager());
    document.getElementById('btn-update-project')?.addEventListener('click', () => this.updateProject());
    document.getElementById('btn-delete-project')?.addEventListener('click', () => this.deleteProject());
    
    // Summary modal
    document.getElementById('btn-summary')?.addEventListener('click', () => this.showSummary());
    document.getElementById('btn-copy-summary')?.addEventListener('click', () => this.copySummary());
    
    // Modal close buttons (X buttons)
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.modal));
    });
    
    // Cancel buttons with data-modal attribute (both secondary and primary)
    document.querySelectorAll('.modal-footer .btn-secondary[data-modal]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.modal));
    });
    document.querySelectorAll('.modal-footer .btn-primary[data-modal]').forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(btn.dataset.modal));
    });
    
    // Modal overlay click to close
    document.getElementById('modal-overlay')?.addEventListener('click', () => this.closeAllModals());
    
    // Auto-run toggle
    document.getElementById('auto-run-checkbox')?.addEventListener('change', (e) => {
      this.autoRunEnabled = e.target.checked;
      this.log(this.autoRunEnabled ? 'Auto-run enabled' : 'Auto-run disabled', 'info');
      
      // If just enabled and there's code, run immediately
      if (this.autoRunEnabled && RecipeManager.chain.length > 0) {
        this.runAll();
      }
    });
    
    // Single editor mode toggle
    document.getElementById('single-editor-checkbox')?.addEventListener('change', (e) => {
      this.singleEditorMode = e.target.checked;
      this.toggleSingleEditorMode(this.singleEditorMode);
    });
    
    // Simple editor mode toggle (for very large files)
    document.getElementById('simple-mode-checkbox')?.addEventListener('change', (e) => {
      EditorManager.enableSimpleMode(e.target.checked);
    });
    
    // Simple mode event from EditorManager
    window.addEventListener('simple-mode', (e) => {
      if (e.detail.enabled) {
        this.log('Simple editor mode - using plain textarea for instant editing of large files', 'warn');
      } else {
        this.log('Monaco editor restored', 'info');
      }
    });
    
    // Input change - auto parse AST and optionally auto-run (with optimized debouncing)
    window.addEventListener('input-changed', (e) => {
      const code = e.detail.code || '';
      
      // Calculate appropriate debounce delay based on code size
      const getDelay = (size) => {
        if (size > 500000) return 2000;
        if (size > 100000) return 1000;
        if (size > 50000) return 600;
        return 300;
      };
      
      // Skip AST parsing for very large files
      if (code.length > 500000) {
        // Don't auto-parse for huge files, user can manually refresh
      } else if (ASTViewer.liveSync) {
        // Update AST if live sync is enabled (with smart debounce)
        this.debounce('ast-update', () => {
          ASTViewer.updateFromCode(code);
        }, getDelay(code.length));
      }
      
      // Auto-run transforms if enabled (with smart debounce)
      if (this.autoRunEnabled && RecipeManager.chain.length > 0) {
        this.debounce('auto-run', () => {
          this.runAll();
        }, getDelay(code.length));
      }
    });
    
    // Chain changed - just update UI, don't auto-run (that's handled by chain-item-added)
    window.addEventListener('chain-changed', (e) => {
      this.onChainChanged(e.detail.chain);
    });
    
    // New item added to chain - run only that item using current output
    window.addEventListener('chain-item-added', (e) => {
      if (this.autoRunEnabled && e.detail.item) {
        clearTimeout(this.autoRunTimeout);
        this.autoRunTimeout = setTimeout(() => {
          this.runNewChainItem(e.detail.item, e.detail.index);
        }, 300);
      }
    });
    
    // Monaco editor actions
    window.addEventListener('run-transforms', () => this.runAll());
    window.addEventListener('run-step', () => this.runStep());
    window.addEventListener('apply-output', () => this.useOutputAsInput());
  },
  
  /**
   * Setup resize handlers
   */
  setupResizeHandlers() {
    // Editor panels resize
    const editorResizeHandle = document.getElementById('editor-resize-handle');
    const inputPanel = document.getElementById('input-panel');
    const outputPanel = document.getElementById('output-panel');
    
    if (editorResizeHandle && inputPanel && outputPanel) {
      let isResizing = false;
      let startX, startWidth;
      
      editorResizeHandle.addEventListener('mousedown', (e) => {
        // Only handle left mouse button
        if (e.button !== 0) return;
        
        isResizing = true;
        startX = e.clientX;
        startWidth = inputPanel.offsetWidth;
        
        // Add a resize overlay to prevent editor interference
        const overlay = document.createElement('div');
        overlay.id = 'resize-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;';
        document.body.appendChild(overlay);
        
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        const newWidth = startWidth + diff;
        const containerWidth = inputPanel.parentElement.offsetWidth;
        
        // Min/max constraints
        const minWidth = 200;
        const maxWidth = containerWidth - 200;
        
        if (newWidth >= minWidth && newWidth <= maxWidth) {
          inputPanel.style.flex = `0 0 ${newWidth}px`;
          outputPanel.style.flex = '1';
          EditorManager.layout();
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          // Remove overlay
          document.getElementById('resize-overlay')?.remove();
        }
      });
    }
    
    // Tools panel resize
    const toolsResizeHandle = document.getElementById('tools-resize-handle');
    const toolsPanel = document.getElementById('tools-panel');
    
    if (toolsResizeHandle && toolsPanel) {
      let isResizingTools = false;
      let toolsStartX, toolsStartWidth;
      
      toolsResizeHandle.addEventListener('mousedown', (e) => {
        if (toolsPanel.classList.contains('collapsed')) return;
        if (e.button !== 0) return;
        
        isResizingTools = true;
        toolsStartX = e.clientX;
        toolsStartWidth = toolsPanel.offsetWidth;
        
        // Add overlay to prevent editor interference
        const overlay = document.createElement('div');
        overlay.id = 'resize-overlay-tools';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;';
        document.body.appendChild(overlay);
        
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizingTools) return;
        
        // Dragging left increases width, dragging right decreases
        const diff = toolsStartX - e.clientX;
        const newWidth = toolsStartWidth + diff;
        
        // Min/max constraints
        const minWidth = 200;
        const maxWidth = 600;
        
        if (newWidth >= minWidth && newWidth <= maxWidth) {
          toolsPanel.style.width = `${newWidth}px`;
          EditorManager.layout();
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizingTools) {
          isResizingTools = false;
          document.getElementById('resize-overlay-tools')?.remove();
        }
      });
    }
    
    // Left panel resize (overall width)
    const leftPanelResize = document.getElementById('left-panel-resize');
    const leftPanel = document.getElementById('left-panel');
    
    if (leftPanelResize && leftPanel) {
      let isResizingLeft = false;
      let leftStartX, leftStartWidth;
      
      leftPanelResize.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        
        isResizingLeft = true;
        leftStartX = e.clientX;
        leftStartWidth = leftPanel.offsetWidth;
        leftPanelResize.classList.add('dragging');
        
        const overlay = document.createElement('div');
        overlay.id = 'resize-overlay-left';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;';
        document.body.appendChild(overlay);
        
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizingLeft) return;
        
        const diff = e.clientX - leftStartX;
        const newWidth = leftStartWidth + diff;
        
        if (newWidth >= 200 && newWidth <= 1000) {
          leftPanel.style.width = `${newWidth}px`;
          EditorManager.layout();
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizingLeft) {
          isResizingLeft = false;
          leftPanelResize.classList.remove('dragging');
          document.getElementById('resize-overlay-left')?.remove();
        }
      });
    }
    
    // Sidebar/Chain split resize
    const sidebarChainResize = document.getElementById('sidebar-chain-resize');
    const sidebar = document.getElementById('sidebar');
    const chainContainer = document.getElementById('recipe-chain-container');
    
    if (sidebarChainResize && sidebar && chainContainer) {
      let isResizingSplit = false;
      let splitStartY, sidebarStartHeight;
      
      sidebarChainResize.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        
        isResizingSplit = true;
        splitStartY = e.clientY;
        sidebarStartHeight = sidebar.offsetHeight;
        sidebarChainResize.classList.add('dragging');
        
        const overlay = document.createElement('div');
        overlay.id = 'resize-overlay-split';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:row-resize;';
        document.body.appendChild(overlay);
        
        e.preventDefault();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizingSplit) return;
        
        const diff = e.clientY - splitStartY;
        const newHeight = sidebarStartHeight + diff;
        const parentHeight = sidebar.parentElement.offsetHeight;
        
        // Height constraints
        const minSidebar = 100;
        const minChain = 150;
        const maxChain = parentHeight * 0.5; // Chain can be max 50% of total height
        const chainHeight = parentHeight - newHeight - 8;
        
        if (newHeight >= minSidebar && chainHeight >= minChain && chainHeight <= maxChain) {
          sidebar.style.flex = `0 0 ${newHeight}px`;
          chainContainer.style.flex = '1';
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizingSplit) {
          isResizingSplit = false;
          sidebarChainResize.classList.remove('dragging');
          document.getElementById('resize-overlay-split')?.remove();
        }
      });
    }
  },
  
  /**
   * Setup keyboard shortcuts
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Block default browser shortcuts that interfere with workflow
      const scriptPanel = document.getElementById('script-panel');
      const scriptPanelOpen = scriptPanel?.classList.contains('open');
      
      // Block ALL Ctrl/Cmd shortcuts except our explicit ones
      // This prevents browser defaults like Ctrl+W, Ctrl+Q, Ctrl+N, Ctrl+P, Ctrl+T, Ctrl+R, etc.
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        
        // List of keys we handle ourselves (allow these through our handlers below)
        const handledKeys = ['enter', 's', 'e', 'f', 't', 'z', 'y', 'a', 'c', 'v', 'x'];
        
        // If it's NOT a key we handle, block it
        if (!handledKeys.includes(key)) {
          e.preventDefault();
          return;
        }
      }
      
      // Allow Ctrl+T for new tab in script panel
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (scriptPanelOpen) {
          this.createScriptTab();
        }
        return;
      }
      
      // Ctrl/Cmd + Enter - Run all
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        // If eval panel is open and focused, run eval
        const evalPanel = document.getElementById('eval-panel');
        if (evalPanel?.classList.contains('open') && EditorManager.evalPanelEditor?.hasTextFocus()) {
          this.runEvalPanel();
          return;
        }
        // If script panel is open and focused, run the script
        const scriptPanel = document.getElementById('script-panel');
        if (scriptPanel?.classList.contains('open') && EditorManager.scriptPanelEditor?.hasTextFocus()) {
          this.runScriptPanel();
        } else {
          this.runAll();
        }
      }
      
      // Ctrl/Cmd + Shift + Enter - Run step
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        this.runStep();
      }
      
      // Ctrl/Cmd + E - Toggle script panel
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'e') {
        e.preventDefault();
        this.toggleScriptPanel();
      }
      
      // Ctrl/Cmd + Shift + E - Toggle eval panel
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        this.toggleEvalPanel();
      }
      
      // Ctrl/Cmd + S - Save project
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.openSaveModal();
      }
      
      // Escape - Close modals or panels
      if (e.key === 'Escape') {
        const evalPanel = document.getElementById('eval-panel');
        const scriptPanel = document.getElementById('script-panel');
        if (evalPanel?.classList.contains('open')) {
          this.closeEvalPanel();
        } else if (scriptPanel?.classList.contains('open')) {
          this.closeScriptPanel();
        } else {
          this.closeAllModals();
        }
      }
      
      // Ctrl/Cmd + Shift + F - Format
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        this.formatInput();
      }
    });
  },
  
  /**
   * Switch tool tab
   */
  switchToolTab(tabName) {
    document.querySelectorAll('.tool-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tool-pane').forEach(p => p.classList.remove('active'));
    
    document.querySelector(`.tool-tab[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`tool-${tabName}`)?.classList.add('active');
    
    // Refresh data when switching tabs
    if (tabName === 'ast') {
      // Refresh based on current AST source (input or output)
      if (ASTViewer.currentSource === 'output') {
        const outputCode = EditorManager.getOutput();
        if (outputCode && outputCode.trim()) {
          ASTViewer.updateOutputAST(outputCode);
        }
      } else {
        ASTViewer.updateFromCode(EditorManager.getInput());
      }
    } else if (tabName === 'scope') {
      ScopeAnalyzer.analyze(EditorManager.getInput());
    } else if (tabName === 'summary') {
      this.refreshSummary();
    }
  },
  
  /**
   * Refresh the summary panel
   */
  refreshSummary() {
    const container = document.getElementById('tool-summary-content');
    if (!container) return;
    
    const summaryData = RecipeManager.getSummaryData();
    const lastRun = RecipeManager.lastResults || {};
    const results = lastRun.results || [];
    
    if (summaryData.length === 0) {
      container.innerHTML = '<div class="summary-empty">No recipes in chain</div>';
      return;
    }
    
    // Build summary HTML
    let html = '<div class="summary-list">';
    
    summaryData.forEach((item, i) => {
      // Use chain item's status first (for stepping), fallback to lastResults (for run all)
      const result = results.find(r => r.index === i) || results[i];
      let statusIcon = '';
      let statusClass = item.status || 'pending';
      let statsHtml = '';
      
      // Helper to format stat key names nicely
      const formatStatKey = (key) => {
        // Handle common prefixes/suffixes
        const formatted = key
          .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase to spaces
          .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2') // Handle consecutive caps
          .replace(/Removed$/, '') // Remove "Removed" suffix
          .replace(/Folded$/, '') // Remove "Folded" suffix
          .replace(/Inlined$/, '') // Remove "Inlined" suffix
          .replace(/^total/i, '') // Remove "total" prefix
          .trim();
        return formatted.charAt(0).toUpperCase() + formatted.slice(1);
      };
      
      // Determine status from chain item status or result
      if (item.status === 'success' || (result && result.success && !result.skipped)) {
        statusClass = 'success';
        statusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`;
        
        // Format stats from chain item or result
        const stats = item.stats || (result && result.stats) || {};
        const statItems = [];
        for (const [key, value] of Object.entries(stats)) {
          // Skip "total" and "passes" stats, focus on meaningful ones
          if (typeof value === 'number' && value > 0 && !key.toLowerCase().includes('total') && key !== 'passes') {
            statItems.push(`${formatStatKey(key)}: ${value}`);
          }
        }
        // Show total if no specific stats, or show first 3 meaningful stats
        if (statItems.length === 0 && stats.totalRemoved > 0) {
          statItems.push(`Removed: ${stats.totalRemoved}`);
        } else if (statItems.length === 0 && stats.totalFolded > 0) {
          statItems.push(`Folded: ${stats.totalFolded}`);
        }
        if (statItems.length > 3) {
          statsHtml = `<span class="summary-item-stats" title="${statItems.join(', ')}">${statItems.slice(0, 3).join(' | ')}...</span>`;
        } else if (statItems.length > 0) {
          statsHtml = `<span class="summary-item-stats">${statItems.join(' | ')}</span>`;
        }
      } else if (item.status === 'error' || (result && !result.success && !result.skipped)) {
        statusClass = 'error';
        statusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
      } else if (item.status === 'active') {
        statusClass = 'active';
        statusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>`;
      } else if (result && result.skipped) {
        statusClass = 'skipped';
        statusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
        </svg>`;
      } else {
        statusClass = 'pending';
        statusIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
        </svg>`;
      }
      
      // Iterations control for transforms that support it
      const iterations = item.config?.iterations || 3;
      const iterationsHtml = item.hasIterations ? `
        <span class="summary-item-iterations" title="Iterations">
          <button class="summary-iter-btn" data-action="decrease" data-index="${i}">−</button>
          <span class="summary-iter-value">${iterations}</span>
          <button class="summary-iter-btn" data-action="increase" data-index="${i}">+</button>
        </span>
      ` : '';
      
      // Enabled status indicator (visual only, matches chain)
      const enabledIndicator = `<span class="summary-item-enabled" title="${item.enabled ? 'Enabled' : 'Disabled'}">${item.enabled ? '✓' : '○'}</span>`;
      
      html += `
        <div class="summary-item ${statusClass} ${!item.enabled ? 'disabled' : ''}" data-chain-index="${i}">
          <span class="summary-item-status">${statusIcon}</span>
          <span class="summary-item-index">${item.index}</span>
          <span class="summary-item-name" title="Click to scroll to recipe">${item.name}</span>
          <span class="summary-item-type">${item.type}</span>
          ${statsHtml}
          ${iterationsHtml}
          ${enabledIndicator}
        </div>
      `;
    });
    
    html += '</div>';
    
    // Add total stats if available (from run all)
    if (results.length > 0) {
      const successCount = results.filter(r => r.success && !r.skipped).length;
      const errorCount = results.filter(r => !r.success && !r.skipped).length;
      const skippedCount = results.filter(r => r.skipped).length;
      const duration = lastRun.duration || 0;
      
      html += `
        <div class="summary-footer">
          <span class="summary-total">
            ${successCount} passed, ${errorCount} failed, ${skippedCount} skipped
          </span>
          <span class="summary-duration">${duration}ms</span>
        </div>
      `;
    }
    
    container.innerHTML = html;
    
    // Add click handlers to summary item names (scroll to chain)
    container.querySelectorAll('.summary-item-name').forEach(name => {
      name.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = name.closest('.summary-item');
        const index = parseInt(item.dataset.chainIndex);
        this.scrollToChainItem(index);
      });
    });
    
    // Add click handlers to iteration buttons
    container.querySelectorAll('.summary-iter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        const action = btn.dataset.action;
        const currentIterations = RecipeManager.getIterations(index);
        const newIterations = action === 'increase' ? currentIterations + 1 : currentIterations - 1;
        RecipeManager.setIterations(index, newIterations);
        this.refreshSummary();
      });
    });
  },
  
  /**
   * Scroll to and highlight a chain item
   */
  scrollToChainItem(index) {
    const chainContainer = document.getElementById('recipe-chain');
    const card = chainContainer?.querySelector(`.recipe-card[data-index="${index}"]`);
    
    if (card) {
      // Expand the card if collapsed
      card.classList.remove('collapsed');
      
      // Remove highlight from all cards
      chainContainer.querySelectorAll('.recipe-card').forEach(c => c.classList.remove('highlighted'));
      
      // Add highlight to target card
      card.classList.add('highlighted');
      
      // Scroll into view
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // Remove highlight after animation
      setTimeout(() => {
        card.classList.remove('highlighted');
      }, 2000);
    }
  },
  
  /**
   * Switch console tab
   */
  switchConsoleTab(tabName) {
    document.querySelectorAll('.console-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.console-pane').forEach(p => p.classList.remove('active'));
    
    document.querySelector(`.console-tab[data-tab="${tabName}"]`)?.classList.add('active');
    document.getElementById(`console-${tabName}`)?.classList.add('active');
  },
  
  /**
   * Evaluate code and show the result (runs in browser)
   * Useful for testing JSFuck expressions like [][[]] or other executable code
   */
  // ==================== Eval Panel ====================
  
  /**
   * Toggle eval panel open/closed
   */
  toggleEvalPanel() {
    const panel = document.getElementById('eval-panel');
    if (panel?.classList.contains('open')) {
      this.closeEvalPanel();
    } else {
      this.openEvalPanel();
    }
  },
  
  /**
   * Open eval panel
   */
  openEvalPanel() {
    const panel = document.getElementById('eval-panel');
    const resizeHandle = document.getElementById('eval-panel-resize');
    if (!panel) return;
    
    panel.classList.add('open');
    resizeHandle?.classList.add('visible');
    
    // Create editor if not exists
    setTimeout(() => {
      if (!EditorManager.evalPanelEditor) {
        EditorManager.createEvalPanelEditor();
      }
      EditorManager.evalPanelEditor?.layout();
      EditorManager.evalPanelEditor?.focus();
    }, 100);
    
    this.log('Eval panel opened (Ctrl+Shift+E to close)', 'info');
  },
  
  /**
   * Close eval panel
   */
  closeEvalPanel() {
    const panel = document.getElementById('eval-panel');
    const resizeHandle = document.getElementById('eval-panel-resize');
    if (panel) {
      panel.classList.remove('open');
    }
    if (resizeHandle) {
      resizeHandle.classList.remove('visible');
    }
    
    // Re-layout main editors after panel closes
    setTimeout(() => {
      EditorManager.layout();
    }, 50);
  },
  
  // Session flag to track if user dismissed eval warning (resets on refresh)
  evalWarningDismissed: false,
  
  /**
   * Run code from the eval panel
   */
  async runEvalPanel() {
    const code = EditorManager.getEvalPanelCode();
    
    if (!code || !code.trim()) {
      this.log('No code to evaluate', 'warn');
      return;
    }
    
    // Show warning if not dismissed this session
    if (!this.evalWarningDismissed) {
      const warningResult = await this.showEvalWarning();
      if (warningResult === 'cancel') {
        this.log('Evaluation cancelled', 'info');
        return;
      }
      if (warningResult === 'dont-show') {
        this.evalWarningDismissed = true;
      }
    }
    
    this.log('Evaluating code...', 'info');
    
    // Capture console output
    const logs = [];
    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info
    };
    
    // Override console methods to capture output
    console.log = (...args) => {
      logs.push({ type: 'log', message: args.map(a => this.formatEvalValue(a)).join(' ') });
      originalConsole.log.apply(console, args);
    };
    console.warn = (...args) => {
      logs.push({ type: 'warn', message: args.map(a => this.formatEvalValue(a)).join(' ') });
      originalConsole.warn.apply(console, args);
    };
    console.error = (...args) => {
      logs.push({ type: 'error', message: args.map(a => this.formatEvalValue(a)).join(' ') });
      originalConsole.error.apply(console, args);
    };
    console.info = (...args) => {
      logs.push({ type: 'info', message: args.map(a => this.formatEvalValue(a)).join(' ') });
      originalConsole.info.apply(console, args);
    };
    
    let result, resultType, error;
    
    try {
      // Use indirect eval to run in global scope
      const indirectEval = eval;
      result = indirectEval(code);
      resultType = typeof result;
      if (result === null) resultType = 'null';
      if (Array.isArray(result)) resultType = 'array';
    } catch (e) {
      error = e;
    } finally {
      // Restore original console
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
    }
    
    // Build output
    let output = '';
    
    // Add console logs if any
    if (logs.length > 0) {
      output += '// Console Output:\n';
      logs.forEach(log => {
        const prefix = log.type === 'log' ? '' : `[${log.type.toUpperCase()}] `;
        output += `// ${prefix}${log.message}\n`;
      });
      output += '\n';
    }
    
    if (error) {
      this.log(`Evaluation error: ${error.message}`, 'error');
      output += `// Error: ${error.message}`;
    } else {
      // Format the result
      const resultStr = this.formatEvalValue(result);
      output += `// Result (${resultType}):\n${resultStr}`;
      this.log(`Evaluation complete. Result type: ${resultType}`, 'success');
    }
    
    // Update the output area in eval panel
    const outputEl = document.getElementById('eval-output-content');
    if (outputEl) {
      outputEl.textContent = output;
    }
  },
  
  /**
   * Clear the eval panel
   */
  clearEvalPanel() {
    EditorManager.evalPanelEditor?.setValue('');
    const outputEl = document.getElementById('eval-output-content');
    if (outputEl) {
      outputEl.textContent = '// Result will appear here';
    }
  },
  
  /**
   * Show eval warning dialog
   * Returns: 'continue' | 'dont-show' | 'cancel'
   */
  showEvalWarning() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'eval-warning-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-secondary, #1e1e1e);
      border: 2px solid #ff9800;
      border-radius: 8px;
      padding: 24px;
      max-width: 450px;
      color: var(--text-primary, #fff);
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    `;
    
    dialog.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <span style="font-size: 32px;">⚠️</span>
        <h3 style="margin: 0; color: #ff9800; font-size: 18px;">Security Warning</h3>
      </div>
      <p style="margin: 0 0 12px; line-height: 1.5; color: #ccc;">
        You are about to <strong style="color: #ff9800;">execute JavaScript code</strong> using eval().
      </p>
      <p style="margin: 0 0 16px; line-height: 1.5; color: #ccc;">
        This code will run with <strong>full access</strong> to your browser session, cookies, and can make network requests.
      </p>
      <div style="background: rgba(255, 152, 0, 0.1); border-left: 3px solid #ff9800; padding: 12px; margin-bottom: 20px; border-radius: 4px;">
        <strong style="color: #ff9800;">Never evaluate untrusted code!</strong>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button id="eval-warn-continue" style="
          padding: 10px 16px;
          background: #ff9800;
          border: none;
          border-radius: 4px;
          color: #000;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
        ">Continue</button>
        <button id="eval-warn-dont-show" style="
          padding: 10px 16px;
          background: transparent;
          border: 1px solid #666;
          border-radius: 4px;
          color: #ccc;
          cursor: pointer;
          font-size: 14px;
        ">Continue & Don't Show Again (this session)</button>
        <button id="eval-warn-cancel" style="
          padding: 10px 16px;
          background: transparent;
          border: 1px solid #666;
          border-radius: 4px;
          color: #ccc;
          cursor: pointer;
          font-size: 14px;
        ">Cancel</button>
      </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // Return a promise-like synchronous result using a blocking approach
    // We'll use a simple flag pattern since we need synchronous result
    let result = null;
    
    const cleanup = () => {
      overlay.remove();
    };
    
    // Use a synchronous approach with event loop trick
    return new Promise((resolve) => {
      dialog.querySelector('#eval-warn-continue').onclick = () => {
        cleanup();
        resolve('continue');
      };
      dialog.querySelector('#eval-warn-dont-show').onclick = () => {
        cleanup();
        resolve('dont-show');
      };
      dialog.querySelector('#eval-warn-cancel').onclick = () => {
        cleanup();
        resolve('cancel');
      };
      overlay.onclick = (e) => {
        if (e.target === overlay) {
          cleanup();
          resolve('cancel');
        }
      };
    });
  },
  
  /**
   * Toggle word wrap in eval panel
   */
  toggleEvalWrap() {
    const btn = document.getElementById('btn-eval-wrap');
    const isWrapped = btn?.classList.toggle('active');
    EditorManager.evalPanelEditor?.updateOptions({ wordWrap: isWrapped ? 'on' : 'off' });
  },
  
  /**
   * Setup eval panel resize
   */
  setupEvalPanelResize() {
    const resizeHandle = document.getElementById('eval-panel-resize');
    const panel = document.getElementById('eval-panel');
    
    if (!resizeHandle || !panel) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    resizeHandle.addEventListener('mousedown', (e) => {
      if (!panel.classList.contains('open')) return;
      
      isResizing = true;
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      resizeHandle.classList.add('resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      
      const deltaX = startX - e.clientX;
      const newWidth = Math.min(Math.max(startWidth + deltaX, 200), 800);
      panel.style.width = newWidth + 'px';
    });
    
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        EditorManager.evalPanelEditor?.layout();
      }
    });
    
    // Double-click to toggle between min and comfortable width
    resizeHandle.addEventListener('dblclick', () => {
      if (!panel.classList.contains('open')) return;
      const currentWidth = panel.offsetWidth;
      if (currentWidth > 250) {
        panel.style.width = '200px';
      } else {
        panel.style.width = '400px';
      }
      EditorManager.evalPanelEditor?.layout();
    });
  },
  
  /**
   * Format a value for display in eval output
   */
  formatEvalValue(val) {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'string') return val;
    if (typeof val === 'function') return val.toString();
    if (typeof val === 'symbol') return val.toString();
    try {
      return JSON.stringify(val, null, 2);
    } catch (e) {
      return String(val);
    }
  },
  
  /**
   * Cancel running transform
   */
  cancelTransform() {
    if (this.isRunning) {
      this.isCancelling = true;
      API.cancel();
      this.log('Cancelling operation...', 'warn');
    }
  },
  
  /**
   * Run all transforms
   */
  async runAll() {
    console.log('[runAll] Called, isRunning:', this.isRunning, 'chain length:', RecipeManager.chain.length);
    
    // Prevent recursive runs
    if (this.isRunning) {
      console.log('[runAll] Blocked - already running');
      return;
    }
    
    const code = EditorManager.getInput();
    if (!code.trim()) {
      if (!this.autoRunEnabled) this.log('No input code', 'warn');
      console.log('[runAll] Blocked - no input code');
      return;
    }
    
    console.log('[runAll] Starting with', RecipeManager.chain.length, 'recipes');
    
    // If no recipes, just parse and regenerate (normalize the code)
    if (RecipeManager.chain.length === 0) {
      this.isRunning = true;
      try {
        const result = await API.format(code);
        if (result.success) {
          EditorManager.setOutput(result.code);
          RecipeManager.formattedInputCode = result.code; // Store formatted version
          ASTViewer.updateOutputAST(result.code);
          ScopeAnalyzer.updateOutputScope(result.code);
          this.log('Parsed and regenerated code (no recipes)', 'success');
        } else {
          this.log(`Parse error: ${result.error}`, 'error');
        }
      } catch (error) {
        if (error.message !== 'Operation cancelled') {
          this.log(`Error: ${error.message}`, 'error');
        }
      } finally {
        this.isRunning = false;
      }
      return;
    }
    
    this.isRunning = true;
    this.isCancelling = false;
    this.showProgress('Running transforms...');
    this.log('Running all transforms...', 'info');
    const startTime = Date.now();
    
    try {
      // First, format the input through AST for consistent diffing
      let formattedCode = code;
      try {
        const formatResult = await API.format(code);
        if (formatResult.success) {
          formattedCode = formatResult.code;
          RecipeManager.formattedInputCode = formattedCode;
        }
      } catch (e) {
        // If formatting fails, use original code
        RecipeManager.formattedInputCode = code;
      }
      
      // Check if cancelled
      if (this.isCancelling) {
        this.log('Operation cancelled', 'warn');
        return;
      }
      
      const result = await RecipeManager.runAll(formattedCode);
      const duration = Date.now() - startTime;
      
      // Check if cancelled
      if (this.isCancelling) {
        this.log('Operation cancelled', 'warn');
        return;
      }
      
      // Store results for summary feature (use actual byte sizes)
      // Use original code size for inputSize, not formatted code
      RecipeManager.lastResults = {
        results: result.results || [],
        success: result.success,
        duration: duration,
        inputSize: this.getByteSize(code),
        outputSize: result.code ? this.getByteSize(result.code) : this.getByteSize(formattedCode),
        error: result.error || null
      };
      
      // Update summary panel if visible
      if (document.getElementById('tool-summary')?.classList.contains('active')) {
        this.refreshSummary();
      }
      
      if (result.success) {
        EditorManager.pushHistory(); // Save state before applying
        
        if (this.singleEditorMode) {
          // In single editor mode, apply directly to input
          EditorManager.setInput(result.code);
          EditorManager.clearOutput();
          RecipeManager.resetChain();
          this.log(`Completed ${result.results.length} transforms in ${duration}ms (applied to input)`, 'success');
        } else {
          EditorManager.setOutput(result.code);
          
          // Update output AST and Scope for diff mode comparison
          ASTViewer.updateOutputAST(result.code);
          ScopeAnalyzer.updateOutputScope(result.code);
          
          this.log(`Completed ${result.results.length} transforms in ${duration}ms`, 'success');
        }
        
        // Log individual stats
        result.results.forEach((r, i) => {
          if (r.success && r.stats) {
            const stats = Object.entries(r.stats)
              .filter(([k, v]) => typeof v === 'number')
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ');
            if (stats) {
              this.logTiming(`${r.transform}: ${stats}`, r.duration);
            }
          }
        });
      } else {
        EditorManager.setOutput(result.code || code);
        
        // Get the name of the failed transform
        const failedTransform = result.failedAt !== undefined && result.results 
          ? result.results[result.failedAt]?.transform || `step ${result.failedAt}`
          : 'unknown step';
        
        this.log(`Failed at "${failedTransform}": ${result.error}`, 'error');
        
        // Show a more detailed error in console for debugging
        console.error('Transform chain error:', {
          failedAt: result.failedAt,
          transform: failedTransform,
          error: result.error,
          results: result.results
        });
      }
    } catch (error) {
      if (error.message !== 'Operation cancelled') {
        this.log(`Error: ${error.message}`, 'error');
      }
    } finally {
      this.isRunning = false;
      this.isCancelling = false;
      this.hideProgress();
    }
  },
  
  /**
   * Run only a newly added chain item (continues from last output)
   * This is more efficient than re-running the entire chain
   */
  async runNewChainItem(item, index) {
    if (this.isRunning) return;
    
    // Use current output as input (continue from last run)
    // If no output yet, use input
    let code = EditorManager.getOutput();
    const isFirstRun = !code || !code.trim();
    if (isFirstRun) {
      code = EditorManager.getInput();
    }
    
    if (!code || !code.trim()) {
      this.log('No code to transform', 'warn');
      return;
    }
    
    const inputSize = code.length;
    this.isRunning = true;
    this.log(`Running: ${item.name}...`, 'info');
    
    try {
      const result = await RecipeManager.runSingleItem(code, item, index);
      
      if (result.busy) {
        this.log('Transform is busy', 'info');
        return;
      }
      
      if (result.skipped) {
        this.log(`${item.name} skipped (disabled)`, 'info');
        return;
      }
      
      if (result.success) {
        EditorManager.pushHistory();
        EditorManager.setOutput(result.code);
        ASTViewer.updateOutputAST(result.code);
        ScopeAnalyzer.updateOutputScope(result.code);
        
        // Update lastResults for summary
        // If first run, initialize; otherwise append to existing results
        if (isFirstRun || !RecipeManager.lastResults.results) {
          RecipeManager.lastResults = {
            results: [{
              index: index,
              transform: item.id,
              name: item.name,
              success: true,
              duration: result.duration,
              codeSize: this.getByteSize(result.code)
            }],
            success: true,
            duration: result.duration,
            inputSize: this.getByteSize(EditorManager.getInput()), // Original input size
            outputSize: this.getByteSize(result.code),
            error: null
          };
        } else {
          // Append new result
          RecipeManager.lastResults.results.push({
            index: index,
            transform: item.id,
            name: item.name,
            success: true,
            duration: result.duration,
            codeSize: this.getByteSize(result.code)
          });
          // Update total duration and output size
          RecipeManager.lastResults.duration += result.duration;
          RecipeManager.lastResults.outputSize = this.getByteSize(result.code);
        }
        
        this.log(`${item.name} completed in ${result.duration}ms`, 'success');
      } else {
        this.log(`${item.name} failed: ${result.error}`, 'error');
      }
    } catch (error) {
      this.log(`Error: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
    }
  },
  
  /**
   * Run next step
   */
  async runStep() {
    // Use step code if available, otherwise use input
    const code = this.stepCode || EditorManager.getInput();
    
    if (!code.trim()) {
      this.log('No input code', 'warn');
      return;
    }
    
    // If no recipes, just parse and regenerate (same as runAll)
    if (RecipeManager.chain.length === 0) {
      try {
        const result = await API.format(code);
        if (result.success) {
          EditorManager.setOutput(result.code);
          ASTViewer.updateOutputAST(result.code);
          ScopeAnalyzer.updateOutputScope(result.code);
          this.log('Parsed and regenerated code (no recipes)', 'success');
        } else {
          this.log(`Parse error: ${result.error}`, 'error');
        }
      } catch (error) {
        this.log(`Error: ${error.message}`, 'error');
      }
      return;
    }
    
    try {
      const result = await RecipeManager.runStep(code);
      
      if (!result) {
        this.log('Step returned no result', 'warn');
        return;
      }
      
      if (result.busy) {
        this.log('A step is already running', 'info');
        return;
      }
      
      if (result.noRecipes) {
        this.log('No recipes in chain', 'info');
        return;
      }
      
      // Check for pure completion (no more steps to run)
      if (result.complete && !result.success) {
        this.log('All steps completed', 'success');
        this.stepCode = null;
        return;
      }
      
      if (result.skipped) {
        this.log('Step skipped (disabled)', 'info');
        this.stepCode = result.code;
        return;
      }
      
      if (result.success) {
        EditorManager.pushHistory(); // Save state before applying
        EditorManager.setOutput(result.code);
        this.stepCode = result.code;
        
        // Update output AST and Scope for diff mode comparison
        ASTViewer.updateOutputAST(result.code);
        ScopeAnalyzer.updateOutputScope(result.code);
        
        const stats = result.stats ? 
          Object.entries(result.stats)
            .filter(([k, v]) => typeof v === 'number')
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ') : '';
        
        const stepNum = RecipeManager.currentStep + 1;
        const totalSteps = RecipeManager.chain.length;
        
        // Update summary if visible
        if (document.getElementById('tool-summary')?.classList.contains('active')) {
          this.refreshSummary();
        }
        
        if (result.complete) {
          this.log(`Final step (${stepNum}/${totalSteps}) completed in ${result.duration}ms${stats ? ` (${stats})` : ''} - All done!`, 'success');
          this.stepCode = null;
        } else {
          this.log(`Step ${stepNum}/${totalSteps} completed in ${result.duration}ms${stats ? ` (${stats})` : ''}`, 'success');
        }
        this.logTiming(`Step ${stepNum}`, result.duration);
      } else {
        this.log(`Step failed: ${result.error}`, 'error');
        
        // Update summary if visible
        if (document.getElementById('tool-summary')?.classList.contains('active')) {
          this.refreshSummary();
        }
      }
    } catch (error) {
      this.log(`Error: ${error.message}`, 'error');
    }
  },
  
  /**
   * Reset transform state
   */
  reset() {
    RecipeManager.resetChain();
    RecipeManager.lastResults = {}; // Clear last results
    this.stepCode = null;
    EditorManager.clearOutput();
    
    // Refresh summary if visible
    if (document.getElementById('tool-summary')?.classList.contains('active')) {
      this.refreshSummary();
    }
    
    this.log('Reset complete', 'info');
  },
  
  /**
   * Format input code
   */
  async formatInput() {
    const code = EditorManager.getInput();
    if (!code.trim()) return;
    
    // Warn for large files
    const fileSize = new Blob([code]).size;
    if (fileSize > 500 * 1024) { // > 500KB
      this.log('Formatting large file - this may take a while...', 'warn');
    }
    
    try {
      const result = await API.format(code);
      if (result.success) {
        EditorManager.setInput(result.code);
        this.log('Code formatted', 'success');
      }
    } catch (error) {
      this.log(`Format error: ${error.message}`, 'error');
    }
  },
  
  /**
   * Paste from clipboard
   */
  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      EditorManager.setInput(text);
      this.log('Pasted from clipboard', 'info');
    } catch (error) {
      this.log('Failed to paste from clipboard', 'error');
    }
  },
  
  /**
   * Copy output to clipboard
   */
  async copyOutput() {
    const code = EditorManager.getOutput();
    if (!code) {
      this.log('No output to copy', 'warn');
      return;
    }
    
    try {
      await navigator.clipboard.writeText(code);
      this.log('Copied to clipboard', 'success');
    } catch (error) {
      this.log('Failed to copy to clipboard', 'error');
    }
  },
  
  /**
   * Use output as input
   */
  useOutputAsInput() {
    EditorManager.useOutputAsInput();
    this.stepCode = null;
    RecipeManager.resetChain();
    this.log('Output moved to input', 'info');
  },
  
  /**
   * Toggle single editor mode
   */
  toggleSingleEditorMode(enabled) {
    const outputPanel = document.getElementById('output-panel');
    const actionBar = document.getElementById('editor-action-bar');
    const inputPanel = document.getElementById('input-panel');
    const inputTitle = inputPanel?.querySelector('.editor-title');
    
    if (enabled) {
      // Hide output panel and action bar
      outputPanel?.classList.add('hidden');
      actionBar?.classList.add('hidden');
      
      // Update input title
      if (inputTitle) inputTitle.textContent = 'Workspace';
      
      // Make input panel take full width
      if (inputPanel) inputPanel.style.flex = '1';
      
      this.log('Single editor mode - transforms apply directly to workspace', 'info');
    } else {
      // Show output panel and action bar
      outputPanel?.classList.remove('hidden');
      actionBar?.classList.remove('hidden');
      
      // Restore input title
      if (inputTitle) inputTitle.textContent = 'Input';
      
      // Restore input panel width
      if (inputPanel) inputPanel.style.flex = '';
      
      this.log('Dual editor mode restored', 'info');
    }
    
    // Re-layout editors
    setTimeout(() => EditorManager.layout(), 100);
  },
  
  /**
   * Populate plugin folder dropdown with existing categories
   * @param {string} selectId - ID of the select element (default: 'save-plugin-folder')
   */
  populatePluginFolders(selectId = 'save-plugin-folder') {
    const select = document.getElementById(selectId);
    if (!select) return;
    
    // Clear existing options except first (default)
    select.innerHTML = '<option value="">Saved Scripts (default)</option>';
    
    // Add existing plugin categories
    for (const category of RecipeManager.pluginCategories) {
      if (category.folder) {
        const option = document.createElement('option');
        option.value = category.folder;
        option.textContent = category.name;
        select.appendChild(option);
      }
    }
  },
  
  /**
   * Confirm saving as plugin with folder selection
   */
  async confirmSaveAsPlugin() {
    const name = document.getElementById('save-plugin-name')?.value?.trim();
    const description = document.getElementById('save-plugin-description')?.value?.trim() || '';
    const existingFolder = document.getElementById('save-plugin-folder')?.value;
    const newFolder = document.getElementById('save-plugin-new-folder')?.value?.trim();
    const code = this.pendingPluginCode;
    const config = this.getPluginParams();
    
    if (!name) {
      this.log('Please enter a plugin name', 'warn');
      return;
    }
    
    if (!code) {
      this.log('No code to save', 'error');
      return;
    }
    
    // Determine folder: new folder takes precedence
    const folder = newFolder || existingFolder || null;
    
    // Check for existing plugin with same name
    const existingPlugin = RecipeManager.userPlugins.find(p => 
      p.name.toLowerCase() === name.toLowerCase()
    );
    
    if (existingPlugin) {
      const confirmOverwrite = confirm(`A plugin named "${existingPlugin.name}" already exists.\n\nDo you want to overwrite it?`);
      if (!confirmOverwrite) {
        return;
      }
      
      // Delete the existing plugin first
      try {
        await API.deletePlugin(existingPlugin.id);
      } catch (error) {
        this.log(`Failed to overwrite existing plugin: ${error.message}`, 'error');
        return;
      }
    }
    
    try {
      const result = await API.createPlugin({ 
        name, 
        description, 
        code,
        config, // Include config parameters
        folder // Pass folder to API
      });
      
      if (result.success) {
        await RecipeManager.loadUserPlugins();
        RecipeManager.renderLibrary();
        
        this.closeModal('modal-save-plugin');
        this.pendingPluginCode = null;
        this.log(`Saved plugin: ${name}${folder ? ` in ${folder}` : ''}`, 'success');
      }
    } catch (error) {
      this.log(`Failed to save plugin: ${error.message}`, 'error');
    }
  },
  
  // ==================== Script Panel (Right Side) ====================
  
  /**
   * Toggle script panel open/closed
   */
  toggleScriptPanel() {
    const panel = document.getElementById('script-panel');
    if (panel?.classList.contains('open')) {
      this.closeScriptPanel();
    } else {
      this.openScriptPanel();
    }
  },
  
  /**
   * Open script panel
   */
  openScriptPanel() {
    const panel = document.getElementById('script-panel');
    const resizeHandle = document.getElementById('script-panel-resize');
    if (!panel) return;
    
    panel.classList.add('open');
    resizeHandle?.classList.add('visible');
    
    // Create editor if not exists
    setTimeout(() => {
      if (!EditorManager.scriptPanelEditor) {
        EditorManager.createScriptPanelEditor('script-panel-editor');
        
        // Track modifications
        EditorManager.scriptPanelEditor.onDidChangeModelContent(() => {
          this.markTabModified();
        });
      }
      
      // Initialize tabs if empty
      this.initScriptTabs();
      
      EditorManager.scriptPanelEditor?.layout();
      EditorManager.scriptPanelEditor?.focus();
    }, 100);
    
    this.log('Script panel opened (Ctrl+E to close)', 'info');
  },
  
  /**
   * Close script panel
   */
  closeScriptPanel() {
    const panel = document.getElementById('script-panel');
    const resizeHandle = document.getElementById('script-panel-resize');
    if (panel) {
      panel.classList.remove('open');
    }
    if (resizeHandle) {
      resizeHandle.classList.remove('visible');
    }
    
    // Re-layout main editors after panel closes
    setTimeout(() => {
      EditorManager.inputEditor?.layout();
      EditorManager.outputEditor?.layout();
    }, 50);
  },
  
  /**
   * Run script from the script panel
   */
  async runScriptPanel() {
    const code = EditorManager.getScriptPanelCode();
    const tab = this.scriptTabs.find(t => t.id === this.activeTabId);
    const name = tab?.name || document.getElementById('script-panel-name')?.value?.trim() || 'Script Panel';
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    // Save code to current tab
    if (tab) {
      tab.code = code;
      tab.modified = false;
      this.renderScriptTabs();
    }
    
    // Get input code
    const inputCode = EditorManager.getInput();
    if (!inputCode.trim()) {
      this.log('No input code to transform', 'warn');
      return;
    }
    
    this.log(`Running: ${name}...`, 'info');
    
    try {
      // Run the transform directly without adding to chain
      // API expects transform object with type and code
      const transform = { type: 'script', code: code };
      const result = await API.runTransform(inputCode, transform, {});
      
      if (result.success) {
        EditorManager.setOutput(result.code);
        
        // Update AST viewer with new output
        ASTViewer.updateOutputAST(result.code);
        
        // Show stats if any
        const statsStr = result.stats && Object.keys(result.stats).length > 0 
          ? ` (${Object.entries(result.stats).map(([k,v]) => `${k}: ${v}`).join(', ')})`
          : '';
        this.log(`Completed: ${name}${statsStr}`, 'success');
        
        // Show logs if any
        if (result.logs && result.logs.length > 0) {
          result.logs.forEach(log => {
            this.log(`[${log.type}] ${log.args.join(' ')}`, log.type === 'error' ? 'error' : 'info');
          });
        }
      } else {
        this.log(`Failed: ${result.error}`, 'error');
      }
    } catch (error) {
      this.log(`Error: ${error.message}`, 'error');
    }
  },
  
  /**
   * Add script panel code to recipe chain
   */
  addScriptToChain() {
    const code = EditorManager.getScriptPanelCode();
    const tab = this.scriptTabs.find(t => t.id === this.activeTabId);
    const name = tab?.name || document.getElementById('script-panel-name')?.value?.trim() || 'Script Panel';
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    // Save code to current tab
    if (tab) {
      tab.code = code;
      tab.modified = false;
      this.renderScriptTabs();
    }
    
    // Auto-detect config hints from code
    const detectedParams = this.detectConfigParams(code);
    const configHints = {};
    detectedParams.forEach(param => {
      configHints[param.name] = {
        type: param.type,
        default: param.default,
        description: param.description || ''
      };
    });
    
    // Create a temporary inline script
    const tempScript = {
      id: `panel-${Date.now()}`,
      name: name,
      description: 'Script from side panel',
      code,
      type: 'inline',
      config: {},
      configHints: configHints,
      enabled: true,
      status: ''
    };
    
    // Add to chain
    RecipeManager.chain.push(tempScript);
    RecipeManager.renderChain();
    
    this.log(`Added to chain: ${name}`, 'success');
  },
  
  /**
   * Save script panel code as plugin
   */
  saveScriptPanelAsPlugin() {
    const code = EditorManager.getScriptPanelCode();
    const tab = this.scriptTabs.find(t => t.id === this.activeTabId);
    const name = tab?.name || document.getElementById('script-panel-name')?.value?.trim() || '';
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    // Store the code for when user confirms save
    this.pendingPluginCode = code;
    
    // Populate folder dropdown
    this.populatePluginFolders();
    
    // Pre-fill name if provided (use tab name, excluding generic "Script N" names)
    const displayName = name.startsWith('Script ') ? '' : name;
    document.getElementById('save-plugin-name').value = displayName;
    document.getElementById('save-plugin-description').value = '';
    document.getElementById('save-plugin-folder').value = '';
    document.getElementById('save-plugin-new-folder').value = '';
    
    // Clear and initialize parameters list
    this.initPluginParamsList(code);
    
    // Open save dialog
    this.openModal('modal-save-plugin');
  },
  
  /**
   * Clear script panel and start new
   */
  newScriptPanel() {
    this.createScriptTab();
  },
  
  /**
   * Toggle word wrap in script panel editor
   */
  toggleScriptWrap() {
    const isWrapped = EditorManager.toggleScriptPanelWordWrap();
    const btn = document.getElementById('btn-script-wrap');
    if (btn) {
      btn.classList.toggle('active', isWrapped);
      btn.title = isWrapped ? 'Word Wrap: On' : 'Word Wrap: Off';
    }
  },
  
  // ==================== Plugin Parameters ====================
  
  /**
   * Initialize plugin parameters list, auto-detecting from code
   */
  initPluginParamsList(code) {
    const container = document.getElementById('plugin-params-list');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Auto-detect config params from code
    const detectedParams = this.detectConfigParams(code);
    
    if (detectedParams.length > 0) {
      detectedParams.forEach(param => {
        this.addPluginParam(param.name, param.type, param.default, param.description);
      });
    }
  },
  
  /**
   * Detect config parameters from code by analyzing patterns
   */
  detectConfigParams(code) {
    const params = [];
    const seen = new Set();
    
    // First, try to parse CONFIG PARAMETERS comment block
    // Format: // - paramName: description - Type (default: value)
    const configMatch = code.match(/\/\/\s*CONFIG\s*PARAMETERS\s*:?\s*([\s\S]*?)(?=\n\s*\n|\nasync|\nconst|\nlet|\nvar|\nfunction|\n\/\/[^-]|$)/i);
    if (configMatch) {
      const configBlock = configMatch[1];
      const paramRegex = /\/\/\s*-\s*(\w+)\s*:\s*([^-\n]+?)(?:\s*-\s*(\w+))?(?:\s*\(default:\s*([^)]+)\))?\s*$/gm;
      let match;
      
      while ((match = paramRegex.exec(configBlock)) !== null) {
        const [, name, description, typeStr, defaultStr] = match;
        if (seen.has(name)) continue;
        seen.add(name);
        
        const typeMap = { 'string': 'string', 'str': 'string', 'number': 'number', 'num': 'number', 
                         'int': 'number', 'boolean': 'boolean', 'bool': 'boolean', 'array': 'array' };
        const type = typeMap[(typeStr || 'string').toLowerCase()] || 'string';
        const defValue = defaultStr?.trim() || '';
        
        params.push({ name, type, default: defValue, description: description.trim() });
      }
    }
    
    // Pattern: config.paramName || defaultValue
    const orPattern = /config\.(\w+)\s*\|\|\s*(['"`]([^'"`]*)['"`]|(\d+(?:\.\d+)?)|true|false|\[\]|\{\})/g;
    let match;
    
    while ((match = orPattern.exec(code)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      
      const defaultVal = match[2];
      let type = 'string';
      let defValue = '';
      
      if (defaultVal === 'true' || defaultVal === 'false') {
        type = 'boolean';
        defValue = defaultVal;
      } else if (defaultVal === '[]') {
        type = 'array';
        defValue = '[]';
      } else if (defaultVal === '{}') {
        type = 'object';
        defValue = '{}';
      } else if (/^\d+(\.\d+)?$/.test(defaultVal)) {
        type = 'number';
        defValue = defaultVal;
      } else if (match[3] !== undefined) {
        defValue = match[3];
      }
      
      params.push({ name, type, default: defValue, description: '' });
    }
    
    // Pattern: config.paramName ?? defaultValue
    const nullishPattern = /config\.(\w+)\s*\?\?\s*(['"`]([^'"`]*)['"`]|(\d+(?:\.\d+)?)|true|false|\[\]|\{\})/g;
    while ((match = nullishPattern.exec(code)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      
      const defaultVal = match[2];
      let type = 'string';
      let defValue = '';
      
      if (defaultVal === 'true' || defaultVal === 'false') {
        type = 'boolean';
        defValue = defaultVal;
      } else if (defaultVal === '[]') {
        type = 'array';
        defValue = '[]';
      } else if (defaultVal === '{}') {
        type = 'object';
        defValue = '{}';
      } else if (/^\d+(\.\d+)?$/.test(defaultVal)) {
        type = 'number';
        defValue = defaultVal;
      } else if (match[3] !== undefined) {
        defValue = match[3];
      }
      
      params.push({ name, type, default: defValue, description: '' });
    }
    
    // Pattern: config.paramName !== false (implies boolean, default true)
    const notFalsePattern = /config\.(\w+)\s*!==\s*false/g;
    while ((match = notFalsePattern.exec(code)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      params.push({ name, type: 'boolean', default: 'true', description: '' });
    }
    
    // Pattern: config.paramName === true (implies boolean, default false)
    const equalsTruePattern = /config\.(\w+)\s*===\s*true/g;
    while ((match = equalsTruePattern.exec(code)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);
      params.push({ name, type: 'boolean', default: 'false', description: '' });
    }
    
    return params;
  },
  
  /**
   * Add a parameter row to the plugin params list
   */
  addPluginParam(name = '', type = 'string', defaultVal = '', description = '') {
    const container = document.getElementById('plugin-params-list');
    if (!container) return;
    
    const row = document.createElement('div');
    row.className = 'plugin-param-row';
    row.innerHTML = `
      <input type="text" class="param-name" placeholder="paramName" value="${name}">
      <select class="param-type">
        <option value="string" ${type === 'string' ? 'selected' : ''}>String</option>
        <option value="number" ${type === 'number' ? 'selected' : ''}>Number</option>
        <option value="boolean" ${type === 'boolean' ? 'selected' : ''}>Boolean</option>
        <option value="array" ${type === 'array' ? 'selected' : ''}>Array</option>
      </select>
      <input type="text" class="param-default" placeholder="default" value="${defaultVal}">
      <input type="text" class="param-description" placeholder="description" value="${this.escapeHtml(description)}">
      <button type="button" class="btn-remove-param" title="Remove">✕</button>
    `;
    container.appendChild(row);
  },
  
  /**
   * Get all plugin parameters from the form
   */
  getPluginParams() {
    const container = document.getElementById('plugin-params-list');
    if (!container) return {};
    
    const config = {};
    const rows = container.querySelectorAll('.plugin-param-row');
    
    rows.forEach(row => {
      const name = row.querySelector('.param-name')?.value?.trim();
      const type = row.querySelector('.param-type')?.value || 'string';
      const defaultStr = row.querySelector('.param-default')?.value?.trim() || '';
      const description = row.querySelector('.param-description')?.value?.trim() || '';
      
      if (!name) return;
      
      // Parse default value based on type
      let defaultVal = defaultStr;
      if (type === 'number') {
        defaultVal = parseFloat(defaultStr) || 0;
      } else if (type === 'boolean') {
        defaultVal = defaultStr.toLowerCase() === 'true';
      } else if (type === 'array') {
        try {
          defaultVal = JSON.parse(defaultStr);
          if (!Array.isArray(defaultVal)) defaultVal = [];
        } catch {
          defaultVal = [];
        }
      }
      
      config[name] = {
        type,
        default: defaultVal,
        description
      };
    });
    
    return config;
  },
  
  // ==================== Script Panel Tabs ====================
  
  /**
   * Initialize script tabs with a default tab
   */
  initScriptTabs() {
    if (this.scriptTabs.length === 0) {
      this.createScriptTab('Untitled', EditorManager.getScriptPanelTemplate());
    }
    this.renderScriptTabs();
  },
  
  /**
   * Create a new script tab
   */
  createScriptTab(name = null, code = null) {
    this.tabCounter++;
    const id = `tab-${Date.now()}-${this.tabCounter}`;
    const tabName = name || `Script ${this.tabCounter}`;
    const tabCode = code || EditorManager.getScriptPanelTemplate();
    
    // Save current tab's code before switching
    if (this.activeTabId) {
      const currentTab = this.scriptTabs.find(t => t.id === this.activeTabId);
      if (currentTab && EditorManager.scriptPanelEditor) {
        currentTab.code = EditorManager.getScriptPanelCode();
      }
    }
    
    const tab = {
      id,
      name: tabName,
      code: tabCode,
      modified: false
    };
    
    this.scriptTabs.push(tab);
    this.activeTabId = id;
    this.renderScriptTabs();
    this.switchToTab(id);
    
    return tab;
  },
  
  /**
   * Switch to a specific tab
   */
  switchToTab(tabId) {
    // Save current tab's code
    if (this.activeTabId && this.activeTabId !== tabId) {
      const currentTab = this.scriptTabs.find(t => t.id === this.activeTabId);
      if (currentTab && EditorManager.scriptPanelEditor) {
        currentTab.code = EditorManager.getScriptPanelCode();
      }
    }
    
    const tab = this.scriptTabs.find(t => t.id === tabId);
    if (!tab) return;
    
    this.activeTabId = tabId;
    
    // Update editor content
    EditorManager.setScriptPanelCode(tab.code);
    
    // Update name input
    const nameInput = document.getElementById('script-panel-name');
    if (nameInput) {
      nameInput.value = tab.name === `Script ${this.tabCounter}` ? '' : tab.name;
    }
    
    this.renderScriptTabs();
  },
  
  /**
   * Close a tab
   */
  closeScriptTab(tabId) {
    const tabIndex = this.scriptTabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;
    
    const tab = this.scriptTabs[tabIndex];
    
    // Confirm if modified
    if (tab.modified) {
      if (!confirm(`Close "${tab.name}" without saving?`)) {
        return;
      }
    }
    
    // Remove the tab
    this.scriptTabs.splice(tabIndex, 1);
    
    // If this was the active tab, switch to another
    if (this.activeTabId === tabId) {
      if (this.scriptTabs.length > 0) {
        // Switch to nearest tab
        const newIndex = Math.min(tabIndex, this.scriptTabs.length - 1);
        this.switchToTab(this.scriptTabs[newIndex].id);
      } else {
        // Create a new default tab
        this.createScriptTab();
      }
    } else {
      this.renderScriptTabs();
    }
  },
  
  /**
   * Render script tabs
   */
  renderScriptTabs() {
    const container = document.getElementById('script-panel-tabs');
    if (!container) return;
    
    container.innerHTML = this.scriptTabs.map(tab => `
      <div class="script-tab ${tab.id === this.activeTabId ? 'active' : ''} ${tab.modified ? 'script-tab-modified' : ''}" 
           data-tab-id="${tab.id}">
        <span class="script-tab-name" title="${tab.name}">${tab.name}</span>
        <span class="script-tab-close" data-close-tab="${tab.id}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </span>
      </div>
    `).join('');
    
    // Add click handlers
    container.querySelectorAll('.script-tab').forEach(tabEl => {
      const tabId = tabEl.dataset.tabId;
      
      tabEl.addEventListener('click', (e) => {
        if (!e.target.closest('.script-tab-close')) {
          this.switchToTab(tabId);
        }
      });
    });
    
    container.querySelectorAll('.script-tab-close').forEach(closeBtn => {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeScriptTab(closeBtn.dataset.closeTab);
      });
    });
  },
  
  /**
   * Update current tab name from input
   */
  updateCurrentTabName() {
    const nameInput = document.getElementById('script-panel-name');
    const tab = this.scriptTabs.find(t => t.id === this.activeTabId);
    if (tab && nameInput) {
      const newName = nameInput.value.trim() || `Script ${this.tabCounter}`;
      if (tab.name !== newName) {
        tab.name = newName;
        this.renderScriptTabs();
      }
    }
  },
  
  /**
   * Mark current tab as modified
   */
  markTabModified() {
    const tab = this.scriptTabs.find(t => t.id === this.activeTabId);
    if (tab && !tab.modified) {
      tab.modified = true;
      this.renderScriptTabs();
    }
  },
  
  /**
   * Open code in a new tab
   */
  openInNewTab(code, name = 'Generated') {
    this.createScriptTab(name, code);
  },
  
  /**
   * Setup script panel resize handler
   */
  setupScriptPanelResize() {
    const resizeHandle = document.getElementById('script-panel-resize');
    const panel = document.getElementById('script-panel');
    
    if (!resizeHandle || !panel) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    resizeHandle.addEventListener('mousedown', (e) => {
      if (!panel.classList.contains('open')) return;
      
      isResizing = true;
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      resizeHandle.classList.add('resizing');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      
      const deltaX = startX - e.clientX;
      const newWidth = Math.min(Math.max(startWidth + deltaX, 200), 800);
      panel.style.width = newWidth + 'px';
    });
    
    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        resizeHandle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        EditorManager.scriptPanelEditor?.layout();
      }
    });
    
    // Double-click to toggle between min and comfortable width
    resizeHandle.addEventListener('dblclick', () => {
      if (!panel.classList.contains('open')) return;
      const currentWidth = panel.offsetWidth;
      if (currentWidth > 250) {
        panel.style.width = '200px';
      } else {
        panel.style.width = '400px';
      }
      EditorManager.scriptPanelEditor?.layout();
    });
  },
  
  /**
   * Save current plugin editor code as an inline script
   */
  async saveAsInline() {
    const name = document.getElementById('plugin-name')?.value || 'Custom Script';
    const description = document.getElementById('plugin-description')?.value || '';
    const code = EditorManager.getPluginCode();
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    // Check if we're editing an existing script
    const existingId = document.getElementById('plugin-edit-id')?.value;
    const isExistingScript = existingId && existingId.startsWith('script-');
    
    // Don't add suffix - just use the name as-is
    const scriptName = name;
    
    const script = {
      id: isExistingScript ? existingId : undefined,
      name: scriptName,
      description,
      code,
      type: 'script'
    };
    
    try {
      // Add or update in scripts library
      await RecipeManager.addInlineScript(script);
      
      // Update the chain item if we're editing a chain item
      const chainIndex = this.editingChainIndex;
      const childIndex = this.editingLoopChildIndex;
      
      if (chainIndex !== null && chainIndex !== undefined) {
        // Find the script to get updated ID
        const savedScript = RecipeManager.inlineScripts.find(s => s.name === scriptName);
        RecipeManager.updateChainItem(chainIndex, {
          name: scriptName,
          description,
          code,
          type: 'script',
          id: savedScript?.id || script.id
        }, childIndex);
      }
      
      this.closeModal('modal-plugin-editor');
      this.log(`Saved script: ${scriptName}`, 'success');
    } catch (error) {
      this.log(`Failed to save script: ${error.message}`, 'error');
    }
    this.editingChainIndex = null;
    this.editingLoopChildIndex = null;
  },
  
  /**
   * Open plugin editor modal
   * @param {Object|null} plugin - Plugin to edit, or null for new plugin
   */
  openPluginEditor(plugin = null) {
    this.openModal('modal-plugin-editor');
    this.editingChainIndex = null;
    this.editingLoopChildIndex = null;
    
    // Update title
    const title = document.getElementById('plugin-editor-title');
    if (title) {
      title.textContent = plugin ? 'Edit Script' : 'New Script';
    }
    
    // Store plugin ID for editing (supports inline scripts)
    const idInput = document.getElementById('plugin-edit-id');
    if (idInput) {
      idInput.value = plugin?.id || '';
    }
    
    // Fill in form (make sure they're editable)
    const nameInput = document.getElementById('plugin-name');
    const descInput = document.getElementById('plugin-description');
    nameInput.value = plugin?.name || '';
    nameInput.readOnly = false;
    descInput.value = plugin?.description || '';
    descInput.readOnly = false;
    
    // Show/hide folder selection (show for new plugins, hide when editing existing)
    const folderRow = document.getElementById('plugin-folder-row');
    if (folderRow) {
      folderRow.style.display = plugin ? 'none' : 'flex';
    }
    
    // Populate folder dropdown for new plugins
    if (!plugin) {
      this.populatePluginFolders('plugin-folder');
      document.getElementById('plugin-folder').value = '';
      document.getElementById('plugin-new-folder').value = '';
    }
    
    // Create editor if not exists
    setTimeout(() => {
      if (!EditorManager.pluginEditor) {
        EditorManager.createPluginEditor('plugin-editor-container');
      }
      EditorManager.setPluginCode(plugin?.code || EditorManager.getDefaultTransformCode());
      EditorManager.setPluginEditorReadOnly(false); // Ensure editor is editable
      EditorManager.pluginEditor?.layout();
    }, 100);
    
    // Show/hide delete button (for inline scripts too)
    const deleteBtn = document.getElementById('btn-delete-plugin');
    if (deleteBtn) {
      deleteBtn.style.display = plugin ? 'block' : 'none';
    }
    
    // Show save button, hide chain-specific buttons
    const savePluginBtn = document.getElementById('btn-save-plugin');
    const saveDraftBtn = document.getElementById('btn-save-draft');
    const applyChainBtn = document.getElementById('btn-apply-to-chain');
    const saveAsInlineBtn = document.getElementById('btn-save-as-inline');
    if (savePluginBtn) savePluginBtn.style.display = 'block';
    if (saveDraftBtn) saveDraftBtn.style.display = 'none';
    if (applyChainBtn) applyChainBtn.style.display = 'none';
    if (saveAsInlineBtn) saveAsInlineBtn.style.display = 'none';
  },
  
  /**
   * Open editor for a chain item (or loop child)
   */
  async openChainItemEditor(item, index, childIndex = null) {
    this.openModal('modal-plugin-editor');
    this.editingChainIndex = index;
    this.editingLoopChildIndex = childIndex;
    
    const isBuiltin = item.type === 'builtin';
    const isLoopChild = childIndex !== null;
    
    // Update title
    const title = document.getElementById('plugin-editor-title');
    if (title) {
      if (isLoopChild) {
        title.textContent = isBuiltin ? 
          `View Loop Item: ${item.name}` : 
          `Edit Loop Item: ${item.name}`;
      } else {
        title.textContent = isBuiltin ? 
          `View Built-in: ${item.name}` : 
          `Edit Chain Item: ${item.name}`;
      }
    }
    
    // Clear plugin ID (this is chain editing, not plugin editing)
    const idInput = document.getElementById('plugin-edit-id');
    if (idInput) {
      idInput.value = '';
    }
    
    // Fill in form - allow editing for save as inline
    document.getElementById('plugin-name').value = item.name || '';
    document.getElementById('plugin-description').value = item.description || '';
    document.getElementById('plugin-name').readOnly = false;
    document.getElementById('plugin-description').readOnly = false;
    
    // Create editor if not exists
    setTimeout(async () => {
      if (!EditorManager.pluginEditor) {
        EditorManager.createPluginEditor('plugin-editor-container');
      }
      
      // For built-ins, fetch actual source code
      if (isBuiltin) {
        try {
          const result = await API.getBuiltinSource(item.id);
          if (result.success) {
            EditorManager.setPluginCode(result.source);
          } else {
            EditorManager.setPluginCode(`// Failed to load source code for ${item.name}`);
          }
        } catch (error) {
          EditorManager.setPluginCode(`// Error loading source: ${error.message}`);
        }
      } else {
        // Use item.code, or exampleCode for reference, or default template
        const codeToShow = item.code || item.exampleCode || EditorManager.getDefaultTransformCode();
        EditorManager.setPluginCode(codeToShow);
      }
      
      // Make editor editable - allow modifications for save as inline
      EditorManager.setPluginEditorReadOnly(false);
      EditorManager.pluginEditor?.layout();
    }, 100);
    
    // Show/hide buttons based on type
    const deleteBtn = document.getElementById('btn-delete-plugin');
    const saveDraftBtn = document.getElementById('btn-save-draft');
    const applyChainBtn = document.getElementById('btn-apply-to-chain');
    const savePluginBtn = document.getElementById('btn-save-plugin');
    
    if (deleteBtn) deleteBtn.style.display = 'none';
    // For built-ins: show "Save as Inline" button, hide others
    // For non-built-ins: show all edit buttons
    if (saveDraftBtn) saveDraftBtn.style.display = isBuiltin ? 'none' : 'block';
    if (applyChainBtn) applyChainBtn.style.display = isBuiltin ? 'none' : 'block';
    if (savePluginBtn) savePluginBtn.style.display = isBuiltin ? 'none' : 'block';
    
    // Show "Save as Inline" button for built-ins
    const saveAsInlineBtn = document.getElementById('btn-save-as-inline');
    if (saveAsInlineBtn) saveAsInlineBtn.style.display = isBuiltin ? 'block' : 'none';
  },
  
  /**
   * View source code of a built-in transform (from library sidebar)
   */
  async viewBuiltinSource(transformId) {
    // Find the transform info from builtins
    const transform = RecipeManager.builtins.find(t => t.id === transformId);
    if (!transform) {
      this.log('Transform not found', 'error');
      return;
    }
    
    this.openModal('modal-plugin-editor');
    
    // Update title - indicate it's editable but won't modify the original
    const title = document.getElementById('plugin-editor-title');
    if (title) {
      title.textContent = `View Built-in: ${transform.name}`;
    }
    
    // Clear plugin ID
    const idInput = document.getElementById('plugin-edit-id');
    if (idInput) {
      idInput.value = '';
    }
    
    // Fill in form (editable - user can modify to save as inline)
    const nameInput = document.getElementById('plugin-name');
    const descInput = document.getElementById('plugin-description');
    nameInput.value = transform.name || '';
    nameInput.readOnly = false; // Allow editing name for save as inline
    descInput.value = transform.description || '';
    descInput.readOnly = false; // Allow editing description
    
    // Create editor and load source
    setTimeout(async () => {
      if (!EditorManager.pluginEditor) {
        EditorManager.createPluginEditor('plugin-editor-container');
      }
      
      try {
        const result = await API.getBuiltinSource(transformId);
        if (result.success) {
          EditorManager.setPluginCode(result.source);
        } else {
          EditorManager.setPluginCode(`// Failed to load source code for ${transform.name}`);
        }
      } catch (error) {
        EditorManager.setPluginCode(`// Error loading source: ${error.message}`);
      }
      
      // Make editor editable so user can modify and save as inline
      EditorManager.setPluginEditorReadOnly(false);
      EditorManager.pluginEditor?.layout();
    }, 100);
    
    // Show only "Save as Inline" button for built-ins
    const deleteBtn = document.getElementById('btn-delete-plugin');
    const saveDraftBtn = document.getElementById('btn-save-draft');
    const applyChainBtn = document.getElementById('btn-apply-to-chain');
    const savePluginBtn = document.getElementById('btn-save-plugin');
    const saveAsInlineBtn = document.getElementById('btn-save-as-inline');
    
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (saveDraftBtn) saveDraftBtn.style.display = 'none';
    if (applyChainBtn) applyChainBtn.style.display = 'none';
    if (savePluginBtn) savePluginBtn.style.display = 'none';
    if (saveAsInlineBtn) saveAsInlineBtn.style.display = 'block';
  },
  
  /**
   * View source code of a folder-based plugin (from library sidebar)
   */
  async viewPluginSource(pluginId) {
    // Find the plugin from userPlugins
    const plugin = RecipeManager.userPlugins.find(p => p.id === pluginId);
    if (!plugin) {
      this.log('Plugin not found', 'error');
      return;
    }
    
    this.openModal('modal-plugin-editor');
    
    // Update title - indicate it's read-only but can be saved as inline
    const title = document.getElementById('plugin-editor-title');
    if (title) {
      title.textContent = `View Plugin: ${plugin.name}`;
    }
    
    // Clear plugin ID (it's a folder-based plugin, not editable directly)
    const idInput = document.getElementById('plugin-edit-id');
    if (idInput) {
      idInput.value = '';
    }
    
    // Fill in form (editable - user can modify to save as inline)
    const nameInput = document.getElementById('plugin-name');
    const descInput = document.getElementById('plugin-description');
    nameInput.value = plugin.name || '';
    nameInput.readOnly = false; // Allow editing name for save as inline
    descInput.value = plugin.description || '';
    descInput.readOnly = false; // Allow editing description
    
    // Create editor and load source
    setTimeout(() => {
      if (!EditorManager.pluginEditor) {
        EditorManager.createPluginEditor('plugin-editor-container');
      }
      
      // Set the plugin code directly (already loaded)
      EditorManager.setPluginCode(plugin.code || '// No code available');
      
      // Make editor editable so user can modify and save as inline
      EditorManager.setPluginEditorReadOnly(false);
      EditorManager.pluginEditor?.layout();
    }, 100);
    
    // Show only "Save as Inline" button for folder plugins
    const deleteBtn = document.getElementById('btn-delete-plugin');
    const saveDraftBtn = document.getElementById('btn-save-draft');
    const applyChainBtn = document.getElementById('btn-apply-to-chain');
    const savePluginBtn = document.getElementById('btn-save-plugin');
    const saveAsInlineBtn = document.getElementById('btn-save-as-inline');
    
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (saveDraftBtn) saveDraftBtn.style.display = 'none';
    if (applyChainBtn) applyChainBtn.style.display = 'none';
    if (savePluginBtn) savePluginBtn.style.display = 'none';
    if (saveAsInlineBtn) saveAsInlineBtn.style.display = 'block';
  },

  /**
   * Apply edits to chain item (or loop child)
   */
  applyToChainItem() {
    const index = this.editingChainIndex;
    const childIndex = this.editingLoopChildIndex;
    
    if (index === undefined || index === null) return;
    
    const name = document.getElementById('plugin-name')?.value || 'Unnamed';
    const description = document.getElementById('plugin-description')?.value || '';
    const code = EditorManager.getPluginCode();
    
    RecipeManager.updateChainItem(index, { name, description, code }, childIndex);
    this.closeModal('modal-plugin-editor');
    this.log(`Updated ${childIndex !== null ? 'loop item' : 'chain item'}: ${name}`, 'success');
    this.editingChainIndex = null;
    this.editingLoopChildIndex = null;
  },
  
  /**
   * Save current editor content as draft (new plugin)
   */
  async saveAsDraft() {
    const name = document.getElementById('plugin-name')?.value || 'Draft Plugin';
    const description = document.getElementById('plugin-description')?.value || '';
    const code = EditorManager.getPluginCode();
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    try {
      const result = await API.createPlugin({ 
        name: `${name} (Draft)`, 
        description, 
        code 
      });
      
      if (result.success) {
        await this.reloadPlugins();
        this.log(`Saved draft: ${name}`, 'success');
      }
    } catch (error) {
      this.log(`Failed to save draft: ${error.message}`, 'error');
    }
  },
  
  /**
   * Save plugin as script (saved to server)
   */
  async savePlugin() {
    const existingId = document.getElementById('plugin-edit-id')?.value;
    const name = document.getElementById('plugin-name')?.value || 'Unnamed Script';
    const description = document.getElementById('plugin-description')?.value || '';
    const code = EditorManager.getPluginCode();
    
    // Get folder selection (only for new plugins)
    const existingFolder = document.getElementById('plugin-folder')?.value;
    const newFolder = document.getElementById('plugin-new-folder')?.value?.trim();
    const folder = newFolder || existingFolder || null;
    
    if (!code.trim()) {
      this.log('No transform code provided', 'warn');
      return;
    }
    
    // Check if editing existing script
    const isExistingScript = existingId && existingId.startsWith('script-');
    
    // If a folder is specified and this is a NEW plugin, save as folder plugin
    if (folder && !existingId) {
      try {
        const result = await API.createPlugin({ name, description, code, folder });
        if (result.success) {
          await RecipeManager.loadUserPlugins();
          RecipeManager.renderLibrary();
          this.closeModal('modal-plugin-editor');
          this.log(`Saved plugin: ${name} in ${folder}`, 'success');
        }
      } catch (error) {
        this.log(`Failed to save plugin: ${error.message}`, 'error');
      }
      return;
    }
    
    // Otherwise save as script to server
    const script = {
      id: isExistingScript ? existingId : undefined,
      name,
      description,
      code,
      type: 'script'
    };
    
    try {
      // Add or update script
      await RecipeManager.addInlineScript(script);
      
      this.closeModal('modal-plugin-editor');
      this.log(`Saved: ${name}`, 'success');
    } catch (error) {
      this.log(`Failed to save script: ${error.message}`, 'error');
    }
  },
  
  /**
   * Delete current plugin being edited
   */
  async deletePlugin() {
    const id = document.getElementById('plugin-edit-id')?.value;
    const name = document.getElementById('plugin-name')?.value || 'script';
    
    console.log('[Delete] ID:', id, 'Name:', name);
    
    if (!id) {
      this.log('No script to delete', 'warn');
      return;
    }
    
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) {
      return;
    }
    
    try {
      // Check if it's a server script
      if (id.startsWith('script-')) {
        console.log('[Delete] Deleting server script:', id);
        const result = await RecipeManager.deleteInlineScript(id);
        console.log('[Delete] Result:', result);
        if (result) {
          this.closeModal('modal-plugin-editor');
          this.log(`Deleted script: ${name}`, 'success');
        } else {
          this.log(`Failed to delete script: ${name}`, 'error');
        }
      } else if (id.startsWith('inline-')) {
        // Legacy inline script (localStorage)
        console.log('[Delete] Deleting legacy inline script:', id);
        await RecipeManager.deleteInlineScript(id);
        this.closeModal('modal-plugin-editor');
        this.log(`Deleted script: ${name}`, 'success');
      } else {
        // It's a server-side plugin
        console.log('[Delete] Deleting server-side plugin:', id);
        const result = await API.deletePlugin(id);
        if (result.success) {
          await this.reloadPlugins();
          this.closeModal('modal-plugin-editor');
          this.log(`Deleted plugin: ${name}`, 'success');
        } else {
          this.log(`Failed to delete plugin: ${result.error || 'Unknown error'}`, 'error');
        }
      }
    } catch (error) {
      console.error('[Delete] Error:', error);
      this.log(`Failed to delete: ${error.message}`, 'error');
    }
  },
  
  /**
   * Delete a plugin directly from the library (not from editor modal)
   */
  async deletePluginFromLibrary(id, name, type) {
    // Confirm deletion
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) {
      return;
    }
    
    try {
      if (type === 'inline' || id.startsWith('script-')) {
        // Delete inline/server script
        const result = await RecipeManager.deleteInlineScript(id);
        if (result) {
          this.log(`Deleted script: ${name}`, 'success');
        } else {
          this.log(`Failed to delete script: ${name}`, 'error');
        }
      } else if (type === 'plugin') {
        // Delete user plugin from server
        const result = await API.deletePlugin(id);
        if (result.success) {
          await this.reloadPlugins();
          this.log(`Deleted plugin: ${name}`, 'success');
        } else {
          this.log(`Failed to delete plugin: ${result.error || 'Unknown error'}`, 'error');
        }
      }
    } catch (error) {
      console.error('[Delete] Error:', error);
      this.log(`Failed to delete: ${error.message}`, 'error');
    }
  },
  
  /**
   * Reload all user plugins
   */
  async reloadPlugins() {
    try {
      await RecipeManager.loadUserPlugins();
      RecipeManager.renderLibrary();
      this.log('Plugins reloaded', 'success');
    } catch (error) {
      this.log(`Failed to reload plugins: ${error.message}`, 'error');
    }
  },
  
  /**
   * Edit a specific plugin by ID
   */
  async editPlugin(pluginId) {
    try {
      const result = await API.getPlugin(pluginId);
      if (result.success) {
        this.openPluginEditor(result.plugin);
      }
    } catch (error) {
      this.log(`Failed to load plugin: ${error.message}`, 'error');
    }
  },
  
  /**
   * Open modal
   */
  openModal(modalId) {
    document.getElementById('modal-overlay')?.classList.add('active');
    document.getElementById(modalId)?.classList.add('active');
  },
  
  /**
   * Close modal
   */
  closeModal(modalId) {
    document.getElementById(modalId)?.classList.remove('active');
    
    // Check if any modal is still open
    const anyOpen = document.querySelectorAll('.modal.active').length > 0;
    if (!anyOpen) {
      document.getElementById('modal-overlay')?.classList.remove('active');
    }
  },
  
  /**
   * Close all modals
   */
  closeAllModals() {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    document.getElementById('modal-overlay')?.classList.remove('active');
  },
  
  /**
   * Load projects list
   */
  async loadProjectsList() {
    try {
      const result = await API.getProjects();
      const select = document.getElementById('project-select');
      
      if (select && result.success) {
        select.innerHTML = '<option value="">New Project</option>';
        
        result.projects.forEach(p => {
          const option = document.createElement('option');
          option.value = p.id;
          option.textContent = p.name;
          select.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
    }
  },
  
  /**
   * New project - prompt to save first if there's unsaved work
   */
  newProject() {
    // Check for unsaved changes
    if (this.isProjectModified()) {
      this.showUnsavedChangesModal('newProject');
      return;
    }
    
    this._createNewProject();
  },
  
  /**
   * Show the unsaved changes confirmation modal
   * @param {string} action - The action to perform after: 'newProject', 'loadProject', etc.
   * @param {any} actionData - Optional data for the action (e.g., project ID to load)
   */
  showUnsavedChangesModal(action, actionData = null) {
    this._pendingAction = action;
    this._pendingActionData = actionData;
    this.openModal('modal-unsaved-changes');
  },
  
  /**
   * Handle unsaved changes modal - Save button
   */
  handleUnsavedSave() {
    this.closeModal('modal-unsaved-changes');
    this.openSaveModal();
    // After save, user can manually proceed with their intended action
  },
  
  /**
   * Handle unsaved changes modal - Discard button
   */
  handleUnsavedDiscard() {
    this.closeModal('modal-unsaved-changes');
    const action = this._pendingAction;
    const actionData = this._pendingActionData;
    this._pendingAction = null;
    this._pendingActionData = null;
    
    // Perform the pending action
    switch (action) {
      case 'newProject':
        this._createNewProject();
        break;
      case 'loadProject':
        this._loadProjectById(actionData);
        break;
      default:
        console.warn('Unknown pending action:', action);
    }
  },
  
  /**
   * Handle unsaved changes modal - Cancel button
   */
  handleUnsavedCancel() {
    this.closeModal('modal-unsaved-changes');
    this._pendingAction = null;
    this._pendingActionData = null;
    this.log('Action cancelled', 'info');
  },
  
  /**
   * Actually create the new project (called after confirmation)
   */
  _createNewProject() {
    this.currentProject = null;
    this.lastSavedState = null;
    EditorManager.clearInput();
    EditorManager.clearOutput();
    RecipeManager.clearChain();
    this.stepCode = null;
    
    // Reset to clean state
    this.markProjectSaved();
    
    document.getElementById('project-select').value = '';
    this.log('New project created', 'info');
  },
  
  /**
   * Force create new project without saving (for use after save completes)
   */
  forceNewProject() {
    this._createNewProject();
  },
  
  /**
   * Load project by ID (internal, called after confirmation)
   */
  async _loadProjectById(id) {
    await this.loadProject(id);
    // Update the dropdown to reflect the loaded project
    document.getElementById('project-select').value = id;
  },
  
  /**
   * Load project
   */
  async loadProject(id) {
    try {
      const result = await API.getProject(id);
      if (result.success) {
        this.currentProject = result.project;
        EditorManager.setInput(result.project.inputCode || '');
        EditorManager.setOutput(result.project.outputCode || '');
        
        if (result.project.recipe) {
          RecipeManager.loadChainData(result.project.recipe);
        } else {
          RecipeManager.clearChain();
        }
        
        this.stepCode = null;
        
        // Mark as saved state
        this.markProjectSaved();
        
        // Refresh summary if visible
        if (document.getElementById('tool-summary')?.classList.contains('active')) {
          this.refreshSummary();
        }
        
        this.log(`Loaded project: ${result.project.name}`, 'success');
      }
    } catch (error) {
      this.log(`Failed to load project: ${error.message}`, 'error');
    }
  },
  
  /**
   * Open save modal with enhanced project management
   */
  async openSaveModal() {
    const nameInput = document.getElementById('project-name');
    const descInput = document.getElementById('project-description');
    const saveModeUpdate = document.getElementById('save-mode-update');
    const saveModeNew = document.getElementById('save-mode-new');
    const overwriteGroup = document.getElementById('overwrite-project-group');
    const overwriteSelect = document.getElementById('overwrite-project-select');
    const updateDesc = document.getElementById('save-mode-update-desc');
    
    // Populate overwrite project dropdown
    try {
      const result = await API.getProjects();
      if (result.success) {
        overwriteSelect.innerHTML = '<option value="">-- Select a project --</option>';
        result.projects.forEach(p => {
          const option = document.createElement('option');
          option.value = p.id;
          option.textContent = p.name;
          overwriteSelect.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load projects for save modal:', error);
    }
    
    // Configure based on whether we have a current project
    if (this.currentProject) {
      // Update mode available - set as default
      saveModeUpdate.disabled = false;
      saveModeUpdate.checked = true;
      updateDesc.textContent = `Overwrite "${this.currentProject.name}"`;
      overwriteGroup.style.display = 'none';
      nameInput.value = this.currentProject.name;
      descInput.value = this.currentProject.description || '';
    } else {
      // No current project - disable update mode
      saveModeUpdate.disabled = true;
      saveModeNew.checked = true;
      updateDesc.textContent = 'No project loaded';
      overwriteGroup.style.display = 'none';
      nameInput.value = '';
      descInput.value = '';
    }
    
    // Update project contents summary
    this.updateSaveModalSummary();
    
    // Setup save mode change handlers
    this.setupSaveModeHandlers();
    
    this.openModal('modal-save-project');
  },
  
  /**
   * Setup event handlers for save mode radio buttons
   */
  setupSaveModeHandlers() {
    const saveModeUpdate = document.getElementById('save-mode-update');
    const saveModeNew = document.getElementById('save-mode-new');
    const overwriteGroup = document.getElementById('overwrite-project-group');
    const overwriteSelect = document.getElementById('overwrite-project-select');
    const nameInput = document.getElementById('project-name');
    const descInput = document.getElementById('project-description');
    
    const handleModeChange = () => {
      if (saveModeUpdate.checked) {
        // Update current project mode
        overwriteGroup.style.display = 'none';
        if (this.currentProject) {
          nameInput.value = this.currentProject.name;
          descInput.value = this.currentProject.description || '';
        }
      } else if (saveModeNew.checked) {
        // Save as new mode - check for overwrite option
        overwriteGroup.style.display = 'block';
        overwriteSelect.value = '';
        nameInput.value = '';
        descInput.value = '';
      }
    };
    
    // Remove old handlers and add new ones
    saveModeUpdate.onchange = handleModeChange;
    saveModeNew.onchange = handleModeChange;
    
    // Handle overwrite select change
    overwriteSelect.onchange = () => {
      const selectedId = overwriteSelect.value;
      if (selectedId) {
        // Find the selected project and populate fields
        const selectedOption = overwriteSelect.querySelector(`option[value="${selectedId}"]`);
        if (selectedOption) {
          nameInput.value = selectedOption.textContent;
        }
      } else {
        nameInput.value = '';
        descInput.value = '';
      }
    };
  },
  
  /**
   * Update the save modal project contents summary
   */
  updateSaveModalSummary() {
    const inputCode = EditorManager.getInput() || '';
    const outputCode = EditorManager.getOutput() || '';
    const recipe = RecipeManager.getChainData() || [];
    
    const inputLines = inputCode ? inputCode.split('\n').length : 0;
    const outputLines = outputCode ? outputCode.split('\n').length : 0;
    
    document.getElementById('summary-input-lines').textContent = `${inputLines} lines`;
    document.getElementById('summary-output-lines').textContent = `${outputLines} lines`;
    document.getElementById('summary-recipe-count').textContent = `${recipe.length} transform${recipe.length !== 1 ? 's' : ''}`;
  },
  
  /**
   * Save project with mode selection
   */
  async saveProject() {
    const name = document.getElementById('project-name')?.value?.trim();
    const description = document.getElementById('project-description')?.value?.trim();
    const saveModeUpdate = document.getElementById('save-mode-update');
    const overwriteSelect = document.getElementById('overwrite-project-select');
    
    if (!name) {
      this.log('Project name is required', 'warn');
      return;
    }
    
    const projectData = {
      name,
      description,
      inputCode: EditorManager.getInput(),
      outputCode: EditorManager.getOutput(),
      recipe: RecipeManager.getChainData()
    };
    
    try {
      let result;
      let targetProjectId = null;
      let isOverwrite = false;
      
      // Determine save mode
      if (saveModeUpdate.checked && !saveModeUpdate.disabled && this.currentProject) {
        // Update current project
        targetProjectId = this.currentProject.id;
        isOverwrite = true;
      } else if (overwriteSelect.value) {
        // Overwrite selected existing project
        targetProjectId = overwriteSelect.value;
        isOverwrite = true;
        
        // Confirm overwrite
        const selectedOption = overwriteSelect.querySelector(`option[value="${targetProjectId}"]`);
        const projectName = selectedOption?.textContent || 'this project';
        
        if (!confirm(`Are you sure you want to overwrite "${projectName}"?\n\nThis action cannot be undone.`)) {
          return;
        }
      }
      
      if (targetProjectId) {
        // Update existing project
        result = await API.updateProject(targetProjectId, projectData);
      } else {
        // Create new project
        result = await API.createProject(projectData);
      }
      
      if (result.success) {
        this.currentProject = result.project;
        this.markProjectSaved();
        await this.loadProjectsList();
        document.getElementById('project-select').value = result.project.id;
        this.closeModal('modal-save-project');
        this.log(`Project ${isOverwrite ? 'updated' : 'saved'}: ${name}`, 'success');
      }
    } catch (error) {
      this.log(`Failed to save project: ${error.message}`, 'error');
    }
  },
  
  /**
   * Import project
   */
  async importProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const project = JSON.parse(text);
        
        const result = await API.importProject(project);
        if (result.success) {
          await this.loadProjectsList();
          await this.loadProject(result.project.id);
          
          // Apply imported settings if present
          if (project.settings) {
            this.applySettings(project.settings);
          }
          
          // Apply chain options if present (but don't auto-enable auto-run)
          if (project.chainOptions) {
            // Skip auto-run setting when importing - let user enable manually
            // This prevents accidental expensive re-runs on large code
            // if (project.chainOptions.auto) {
            //   document.getElementById('auto-run-checkbox').checked = true;
            //   this.autoRunEnabled = true;
            // }
            if (project.chainOptions.single) {
              document.getElementById('single-editor-checkbox').checked = true;
              this.singleEditorMode = true;
              this.toggleSingleEditorMode(true);
            }
            if (project.chainOptions.simple) {
              document.getElementById('simple-mode-checkbox').checked = true;
              EditorManager.enableSimpleMode(true);
            }
          }
          
          this.log(`Imported project: ${result.project.name}`, 'success');
        }
      } catch (error) {
        this.log(`Import failed: ${error.message}`, 'error');
      }
    };
    
    input.click();
  },
  
  /**
   * Export project
   */
  async exportProject() {
    if (!this.currentProject) {
      // Export current state as new project
      const project = {
        name: 'Exported Project',
        inputCode: EditorManager.getInput(),
        recipe: RecipeManager.getChainData(),
        settings: this.getSettings(),
        chainOptions: {
          auto: this.autoRunEnabled,
          single: this.singleEditorMode,
          simple: document.getElementById('simple-mode-checkbox')?.checked || false
        }
      };
      
      this.downloadJson(project, 'deob-project.json');
      this.log('Project exported', 'success');
      return;
    }
    
    try {
      const result = await API.exportProject(this.currentProject.id);
      if (result.success) {
        // Add current settings and chain options to export
        result.project.settings = this.getSettings();
        result.project.chainOptions = {
          auto: this.autoRunEnabled,
          single: this.singleEditorMode,
          simple: document.getElementById('simple-mode-checkbox')?.checked || false
        };
        this.downloadJson(result.project, `${this.currentProject.name}.json`);
        this.log('Project exported', 'success');
      }
    } catch (error) {
      this.log(`Export failed: ${error.message}`, 'error');
    }
  },
  
  /**
   * Download JSON file
   */
  downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  
  /**
   * Get current settings
   */
  getSettings() {
    return {
      defaults: {
        auto: document.getElementById('setting-default-auto')?.checked || false,
        single: document.getElementById('setting-default-single')?.checked || false,
        simple: document.getElementById('setting-default-simple')?.checked || false
      },
      ast: {
        showComments: document.getElementById('setting-ast-comments')?.checked || false,
        showLoc: document.getElementById('setting-ast-loc')?.checked || false,
        showExtra: document.getElementById('setting-ast-extra')?.checked || false,
        showTokens: document.getElementById('setting-ast-tokens')?.checked || false
      }
    };
  },
  
  /**
   * Load settings from localStorage
   */
  loadSettings() {
    const saved = localStorage.getItem('workbench-settings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return null;
      }
    }
    return null;
  },
  
  /**
   * Apply settings to UI
   */
  applySettings(settings) {
    if (!settings) return;
    
    // Apply defaults
    if (settings.defaults) {
      if (settings.defaults.auto) {
        document.getElementById('auto-run-checkbox').checked = true;
        this.autoRunEnabled = true;
      }
      if (settings.defaults.single) {
        document.getElementById('single-editor-checkbox').checked = true;
        this.singleEditorMode = true;
        this.toggleSingleEditorMode(true);
      }
      if (settings.defaults.simple) {
        document.getElementById('simple-mode-checkbox').checked = true;
        EditorManager.enableSimpleMode(true);
      }
    }
    
    // Apply AST viewer settings
    if (settings.ast && typeof ASTViewer !== 'undefined') {
      this.updateASTViewerSettings(settings.ast);
    }
    
    // Apply editor settings
    if (settings.editor && typeof ASTViewer !== 'undefined') {
      // Will be applied when sync toggles
    }
  },
  
  /**
   * Update AST viewer skip props based on settings
   */
  updateASTViewerSettings(astSettings) {
    const baseSkipProps = ['type'];
    
    if (!astSettings.showComments) {
      baseSkipProps.push('comments', 'leadingComments', 'trailingComments', 'innerComments');
    }
    if (!astSettings.showLoc) {
      baseSkipProps.push('loc', 'start', 'end', 'range');
    }
    if (!astSettings.showExtra) {
      baseSkipProps.push('extra');
    }
    if (!astSettings.showTokens) {
      baseSkipProps.push('tokens', 'errors', 'directives');
    }
    
    ASTViewer.skipProps = new Set(baseSkipProps);
    
    // Re-render if AST exists
    if (ASTViewer.ast) {
      ASTViewer.render();
    }
  },
  
  /**
   * Open settings modal
   */
  openSettings() {
    const settings = this.loadSettings() || {
      defaults: { auto: true, single: false, simple: false },
      ast: { showComments: true, showLoc: false, showExtra: true, showTokens: true }
    };
    
    // Populate form
    document.getElementById('setting-default-auto').checked = settings.defaults?.auto ?? true;
    document.getElementById('setting-default-single').checked = settings.defaults?.single || false;
    document.getElementById('setting-default-simple').checked = settings.defaults?.simple || false;
    document.getElementById('setting-ast-comments').checked = settings.ast?.showComments ?? true;
    document.getElementById('setting-ast-loc').checked = settings.ast?.showLoc || false;
    document.getElementById('setting-ast-extra').checked = settings.ast?.showExtra ?? true;
    document.getElementById('setting-ast-tokens').checked = settings.ast?.showTokens ?? true;
    
    this.openModal('modal-settings');
  },
  
  /**
   * Save settings
   */
  saveSettings() {
    const settings = this.getSettings();
    localStorage.setItem('workbench-settings', JSON.stringify(settings));
    
    // Apply AST settings immediately
    this.updateASTViewerSettings(settings.ast);
    
    this.closeModal('modal-settings');
    this.log('Settings saved', 'success');
  },
  
  /**
   * Open project manager modal
   */
  openProjectManager() {
    if (!this.currentProject) {
      this.log('No project selected', 'warn');
      return;
    }
    
    document.getElementById('edit-project-name').value = this.currentProject.name || '';
    document.getElementById('edit-project-description').value = this.currentProject.description || '';
    
    // Show meta info
    const metaContainer = document.getElementById('project-meta');
    if (metaContainer && this.currentProject) {
      metaContainer.innerHTML = `
        <div class="project-meta-item">
          <span class="project-meta-label">Created</span>
          <span class="project-meta-value">${new Date(this.currentProject.createdAt || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="project-meta-item">
          <span class="project-meta-label">Updated</span>
          <span class="project-meta-value">${new Date(this.currentProject.updatedAt || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="project-meta-item">
          <span class="project-meta-label">Recipe Steps</span>
          <span class="project-meta-value">${RecipeManager.chain.length}</span>
        </div>
        <div class="project-meta-item">
          <span class="project-meta-label">Input Size</span>
          <span class="project-meta-value">${this.formatBytes(this.getByteSize(EditorManager.getInput()))}</span>
        </div>
      `;
    }
    
    this.openModal('modal-project-manager');
  },
  
  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },
  
  /**
   * Get actual byte size of a string (handles UTF-8 properly)
   */
  getByteSize(str) {
    if (!str) return 0;
    return new Blob([str]).size;
  },
  
  /**
   * Update project
   */
  async updateProject() {
    if (!this.currentProject?.id) {
      this.log('No project to update', 'warn');
      return;
    }
    
    const name = document.getElementById('edit-project-name')?.value?.trim();
    const description = document.getElementById('edit-project-description')?.value?.trim();
    
    if (!name) {
      this.log('Project name is required', 'warn');
      return;
    }
    
    try {
      const projectData = {
        name,
        description,
        inputCode: EditorManager.getInput(),
        outputCode: EditorManager.getOutput(),
        recipe: RecipeManager.chain,
        settings: this.getSettings(),
        updatedAt: new Date().toISOString()
      };
      
      const result = await API.updateProject(this.currentProject.id, projectData);
      if (result.success) {
        this.currentProject.name = name;
        this.currentProject.description = description;
        await this.loadProjectsList();
        this.closeModal('modal-project-manager');
        this.log(`Project "${name}" updated`, 'success');
      }
    } catch (error) {
      this.log(`Failed to update project: ${error.message}`, 'error');
    }
  },
  
  /**
   * Delete current project with name confirmation
   */
  async deleteProject() {
    if (!this.currentProject?.id) {
      this.log('No project to delete', 'warn');
      return;
    }
    
    const name = this.currentProject.name;
    
    // Prompt user to type the project name to confirm deletion
    const confirmation = prompt(
      `WARNING !!!!!!!! This action CANNOT be undone!\n\nTo delete "${name}", type the project name below:`
    );
    
    // Check if user cancelled or didn't type anything
    if (confirmation === null) {
      return; // User cancelled
    }
    
    // Verify the typed name matches exactly
    if (confirmation.trim() !== name) {
      this.log('Project name does not match. Deletion cancelled.', 'warn');
      return;
    }
    
    try {
      const result = await API.deleteProject(this.currentProject.id);
      if (result.success) {
        this.currentProject = null;
        this.lastSavedState = null;
        document.getElementById('project-select').value = '';
        await this.loadProjectsList();
        this.closeModal('modal-project-manager');
        this.updateProjectIndicator();
        this.log(`Project "${name}" deleted`, 'success');
      }
    } catch (error) {
      this.log(`Failed to delete project: ${error.message}`, 'error');
    }
  },
  
  /**
   * Show deobfuscation summary
   */
  showSummary() {
    const lastRun = RecipeManager.lastResults || {};
    const results = lastRun.results || [];
    const chain = RecipeManager.chain;
    
    if (results.length === 0) {
      this.log('No results to summarize. Run the chain first.', 'warn');
      return;
    }
    
    const inputSize = lastRun.inputSize || 0;
    const outputSize = lastRun.outputSize || 0;
    
    // Calculate totals
    let totalDuration = lastRun.duration || 0;
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    results.forEach(r => {
      if (r.skipped) skippedCount++;
      else if (r.success) {
        successCount++;
      } else {
        errorCount++;
      }
    });
    
    // Build summary HTML
    let html = `
      <div class="summary-header">
        <h4>Deobfuscation Results</h4>
        <div class="summary-stats">
          <div class="summary-stat">
            <div class="summary-stat-value">${successCount}</div>
            <div class="summary-stat-label">Transforms</div>
          </div>
          <div class="summary-stat">
            <div class="summary-stat-value">${totalDuration}ms</div>
            <div class="summary-stat-label">Total Time</div>
          </div>
        </div>
      </div>
      
      <div class="summary-transforms">
        <h5 style="margin-bottom: 8px; color: var(--text-secondary);">Transform Results</h5>
    `;
    
    results.forEach((result, i) => {
      const item = chain[result.index] || chain[i];
      const name = item?.name || `Step ${i + 1}`;
      
      let statusClass = 'success';
      let statsHtml = '';
      
      if (result.skipped) {
        statusClass = 'skipped';
        statsHtml = '<span>Skipped</span>';
      } else if (!result.success) {
        statusClass = 'error';
        statsHtml = `<span style="color: var(--accent-error)">${result.error || 'Error'}</span>`;
      } else {
        const stats = result.stats || {};
        const statItems = [];
        
        // Common stat names
        if (stats.folded) statItems.push(`<span class="summary-transform-stat highlight">${stats.folded} folded</span>`);
        if (stats.removed) statItems.push(`<span class="summary-transform-stat highlight">${stats.removed} removed</span>`);
        if (stats.inlined) statItems.push(`<span class="summary-transform-stat highlight">${stats.inlined} inlined</span>`);
        if (stats.decoded) statItems.push(`<span class="summary-transform-stat highlight">${stats.decoded} decoded</span>`);
        if (stats.converted) statItems.push(`<span class="summary-transform-stat highlight">${stats.converted} converted</span>`);
        if (stats.renamed) statItems.push(`<span class="summary-transform-stat highlight">${stats.renamed} renamed</span>`);
        if (stats.normalized) statItems.push(`<span class="summary-transform-stat highlight">${stats.normalized} normalized</span>`);
        if (stats.unwrapped) statItems.push(`<span class="summary-transform-stat highlight">${stats.unwrapped} unwrapped</span>`);
        if (stats.simplified) statItems.push(`<span class="summary-transform-stat highlight">${stats.simplified} simplified</span>`);
        
        // Generic stats handling
        for (const [key, value] of Object.entries(stats)) {
          if (typeof value === 'number' && !['folded', 'removed', 'inlined', 'decoded', 'converted', 'renamed', 'normalized', 'unwrapped', 'simplified'].includes(key)) {
            statItems.push(`<span class="summary-transform-stat">${value} ${key}</span>`);
          }
        }
        
        if (statItems.length === 0) {
          statItems.push(`<span class="summary-transform-stat">${result.duration || 0}ms</span>`);
        } else {
          statItems.push(`<span class="summary-transform-stat">${result.duration || 0}ms</span>`);
        }
        
        statsHtml = statItems.join('');
      }
      
      html += `
        <div class="summary-transform ${statusClass}" data-chart-index="${i + 1}">
          <span class="summary-transform-name">${name}</span>
          <div class="summary-transform-stats">${statsHtml}</div>
        </div>
      `;
    });
    
    html += `</div>`;
    
    // Code size comparison
    const sizeDiff = outputSize - inputSize;
    const sizePercent = inputSize > 0 ? Math.round((sizeDiff / inputSize) * 100) : 0;
    
    html += `
      <div class="summary-code-diff">
        <h5>Code Size</h5>
        <div class="summary-code-diff-stats">
          <div class="diff-stat">
            <span>Input:</span>
            <strong>${this.formatBytes(inputSize)}</strong>
          </div>
          <div class="diff-stat">
            <span>Output:</span>
            <strong>${this.formatBytes(outputSize)}</strong>
          </div>
          <div class="diff-stat ${sizeDiff < 0 ? 'negative' : 'positive'}">
            <span>Change:</span>
            <strong>${sizeDiff >= 0 ? '+' : ''}${this.formatBytes(Math.abs(sizeDiff))} (${sizePercent >= 0 ? '+' : ''}${sizePercent}%)</strong>
          </div>
        </div>
      </div>
      
      <div class="summary-chart-container">
        <h5>Code Size Progression</h5>
        <div class="chart-wrapper">
          <canvas id="size-progression-chart"></canvas>
        </div>
      </div>
    `;
    
    document.getElementById('summary-content').innerHTML = html;
    
    this.openModal('modal-summary');
    
    // Render the chart after DOM is updated
    setTimeout(() => {
      this.renderSizeChart(inputSize, results);
      this.setupChartInteraction();
    }, 50);
  },
  
  /**
   * Setup hover interaction between transform list and chart
   */
  setupChartInteraction() {
    const transformItems = document.querySelectorAll('.summary-transform[data-chart-index]');
    
    transformItems.forEach(item => {
      const chartIndex = parseInt(item.dataset.chartIndex, 10);
      
      item.addEventListener('mouseenter', () => {
        if (this.sizeChart) {
          // Highlight the data point on the chart
          this.sizeChart.setActiveElements([{
            datasetIndex: 0,
            index: chartIndex
          }]);
          this.sizeChart.tooltip.setActiveElements([{
            datasetIndex: 0,
            index: chartIndex
          }], { x: 0, y: 0 });
          this.sizeChart.update('none');
        }
      });
      
      item.addEventListener('mouseleave', () => {
        if (this.sizeChart) {
          this.sizeChart.setActiveElements([]);
          this.sizeChart.tooltip.setActiveElements([], { x: 0, y: 0 });
          this.sizeChart.update('none');
        }
      });
      
      // Click to scroll to chart and highlight point
      item.addEventListener('click', () => {
        const chartContainer = document.querySelector('.summary-chart-container');
        if (chartContainer) {
          chartContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Flash the chart point
          if (this.sizeChart) {
            this.sizeChart.setActiveElements([{
              datasetIndex: 0,
              index: chartIndex
            }]);
            this.sizeChart.tooltip.setActiveElements([{
              datasetIndex: 0,
              index: chartIndex
            }], { x: 0, y: 0 });
            this.sizeChart.update();
            
            // Pulse animation on the chart container
            chartContainer.classList.add('chart-pulse');
            setTimeout(() => chartContainer.classList.remove('chart-pulse'), 600);
          }
        }
      });
    });
  },
  
  /**
   * Render the code size progression chart
   */
  renderSizeChart(inputSize, results) {
    const canvas = document.getElementById('size-progression-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    
    // Build data points - start with input size
    const labels = ['Input'];
    const sizes = [inputSize];
    const colors = [];
    
    results.forEach((result, i) => {
      const name = result.name || `Step ${i + 1}`;
      // Truncate long names
      labels.push(name.length > 15 ? name.substring(0, 12) + '...' : name);
      sizes.push(result.codeSize || sizes[sizes.length - 1]);
    });
    
    // Calculate color for each segment based on size change
    const gradientColors = sizes.map((size, i) => {
      if (i === 0) return 'rgba(99, 102, 241, 1)'; // Primary color for input
      const prevSize = sizes[i - 1];
      if (size < prevSize) return 'rgba(16, 185, 129, 1)'; // Green for reduction
      if (size > prevSize) return 'rgba(239, 68, 68, 1)'; // Red for increase
      return 'rgba(99, 102, 241, 1)'; // Primary for no change
    });
    
    // Get CSS variables
    const style = getComputedStyle(document.documentElement);
    const textColor = style.getPropertyValue('--text-secondary').trim() || '#9ca3af';
    const gridColor = 'rgba(255, 255, 255, 0.05)';
    const accentPrimary = style.getPropertyValue('--accent-primary').trim() || '#6366f1';
    
    // Destroy existing chart if any
    if (this.sizeChart) {
      this.sizeChart.destroy();
    }
    
    // Create gradient
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
    gradient.addColorStop(1, 'rgba(99, 102, 241, 0.02)');
    
    this.sizeChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Code Size (bytes)',
          data: sizes,
          fill: true,
          backgroundColor: gradient,
          borderColor: accentPrimary,
          borderWidth: 2,
          tension: 0.3,
          pointBackgroundColor: gradientColors,
          pointBorderColor: gradientColors,
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointHoverBackgroundColor: '#fff',
          pointHoverBorderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index'
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            enabled: true,
            external: (context) => {
              // Highlight corresponding transform item (no scroll on hover - only on click)
              const transformItems = document.querySelectorAll('.summary-transform[data-chart-index]');
              transformItems.forEach(el => el.classList.remove('chart-highlight'));
              
              if (context.tooltip.dataPoints && context.tooltip.dataPoints.length > 0) {
                const index = context.tooltip.dataPoints[0].dataIndex;
                if (index > 0) { // Skip input point (index 0)
                  const item = document.querySelector(`.summary-transform[data-chart-index="${index}"]`);
                  if (item) {
                    item.classList.add('chart-highlight');
                    // Don't auto-scroll on hover - user requested click-only scrolling
                  }
                }
              }
            },
            backgroundColor: 'rgba(17, 24, 39, 0.95)',
            titleColor: '#fff',
            bodyColor: '#d1d5db',
            borderColor: 'rgba(99, 102, 241, 0.5)',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 12,
            displayColors: false,
            titleFont: {
              family: "'Space Grotesk', sans-serif",
              size: 13,
              weight: '600'
            },
            bodyFont: {
              family: "'JetBrains Mono', monospace",
              size: 12
            },
            callbacks: {
              label: (context) => {
                const size = context.raw;
                const formatted = this.formatBytes(size);
                if (context.dataIndex > 0) {
                  const prevSize = sizes[context.dataIndex - 1];
                  const diff = size - prevSize;
                  const pct = prevSize > 0 ? Math.round((diff / prevSize) * 100) : 0;
                  const sign = diff >= 0 ? '+' : '';
                  return `${formatted} (${sign}${this.formatBytes(Math.abs(diff))}, ${sign}${pct}%)`;
                }
                return formatted;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: gridColor,
              drawBorder: false
            },
            ticks: {
              color: textColor,
              font: {
                family: "'Space Grotesk', sans-serif",
                size: 10
              },
              maxRotation: 45,
              minRotation: 0
            }
          },
          y: {
            beginAtZero: false,
            grid: {
              color: gridColor,
              drawBorder: false
            },
            ticks: {
              color: textColor,
              font: {
                family: "'JetBrains Mono', monospace",
                size: 10
              },
              callback: (value) => this.formatBytes(value)
            }
          }
        },
        animation: {
          duration: 800,
          easing: 'easeOutQuart'
        },
        onClick: (event, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            if (index > 0) { // Skip input point (index 0)
              const item = document.querySelector(`.summary-transform[data-chart-index="${index}"]`);
              if (item) {
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                // Flash the transform item
                item.classList.add('chart-highlight', 'transform-pulse');
                setTimeout(() => {
                  item.classList.remove('chart-highlight', 'transform-pulse');
                }, 800);
              }
            }
          }
        }
      }
    });
  },
  
  /**
   * Copy summary as text
   */
  copySummary() {
    const lastRun = RecipeManager.lastResults || {};
    const results = lastRun.results || [];
    const chain = RecipeManager.chain;
    
    let text = '=== Deobfuscation Summary ===\n\n';
    
    results.forEach((result, i) => {
      const item = chain[result.index] || chain[i];
      const name = item?.name || `Step ${i + 1}`;
      
      if (result.skipped) {
        text += `[SKIP] ${name}\n`;
      } else if (!result.success) {
        text += `[FAIL] ${name}: ${result.error}\n`;
      } else {
        const stats = result.stats || {};
        const statStr = Object.entries(stats)
          .filter(([k, v]) => typeof v === 'number')
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
        text += `[OK] ${name}: ${statStr || 'completed'} (${result.duration}ms)\n`;
      }
    });
    
    const inputSize = lastRun.inputSize || 0;
    const outputSize = lastRun.outputSize || 0;
    text += `\nCode: ${this.formatBytes(inputSize)} → ${this.formatBytes(outputSize)}\n`;
    
    navigator.clipboard.writeText(text)
      .then(() => this.log('Summary copied to clipboard', 'success'))
      .catch(() => this.log('Failed to copy summary', 'error'));
  },
  
  /**
   * Handle chain changed event
   */
  onChainChanged(chain) {
    // Auto-save to current project if exists
    // (Optional: implement auto-save)
  },
  
  /**
   * Set sample code for demo
   */
  setSampleCode() {
    const sampleCode = `// Sample obfuscated code
var _0x1234 = ["H" +3+"ll" + 0, " W"+0+"rld", "log"];console[_0x1234[2]](_0x1234[0] + _0x1234[1]);var x = 0x10 + 0x20;var y = "\x48\x65\x6c\x6c\x6f";var z=!0;var w=void 0;if(!1){console.log("Dead code");}(function(){var unused = 42;return true;})();
`;
    
    EditorManager.setInput(sampleCode);
  },
  
  /**
   * Show progress indicator
   */
  showProgress(message) {
    const runBtn = document.getElementById('btn-run-all');
    if (runBtn) {
      runBtn.classList.add('btn-running');
      runBtn.disabled = true;
    }
    this.log(message, 'info');
  },
  
  /**
   * Hide progress indicator
   */
  hideProgress() {
    const runBtn = document.getElementById('btn-run-all');
    if (runBtn) {
      runBtn.classList.remove('btn-running');
      runBtn.disabled = false;
    }
  },
  
  /**
   * Log message to console
   */
  log(message, type = 'log') {
    const container = document.getElementById('console-logs');
    if (!container) return;
    
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `console-entry ${type}`;
    entry.innerHTML = `<span class="console-timestamp">[${time}]</span> ${this.escapeHtml(message)}`;
    
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    
    // Also log errors to error pane
    if (type === 'error') {
      const errorContainer = document.getElementById('console-errors');
      if (errorContainer) {
        errorContainer.appendChild(entry.cloneNode(true));
      }
    }
  },
  
  /**
   * Log timing info
   */
  logTiming(label, duration) {
    const container = document.getElementById('console-timing');
    if (!container) return;
    
    const entry = document.createElement('div');
    entry.className = 'console-entry';
    entry.innerHTML = `<span class="console-timestamp">${label}</span> ${duration}ms`;
    
    container.appendChild(entry);
  },
  
  /**
   * Clear console
   */
  clearConsole() {
    document.getElementById('console-logs').innerHTML = '';
    document.getElementById('console-errors').innerHTML = '';
    document.getElementById('console-timing').innerHTML = '';
  },
  
  /**
   * Escape HTML
   */
  escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

// Export
window.App = App;
