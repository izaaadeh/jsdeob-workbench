/**
 * Recipe Manager - Handles recipe library and chain
 */

const RecipeManager = {
  builtins: [],
  userPlugins: [],
  pluginCategories: [], // Dynamic categories from folder structure
  inlineScripts: [],
  chain: [],
  currentStep: -1,
  isRunning: false,
  draggedItem: null,
  lastResults: [], // Store results from last run for summary
  
  // Store intermediate code after each transformation for step-by-step diffing
  intermediateSteps: [], // Array of { index, name, code, codeSize }
  formattedInputCode: '', // Initial code after AST formatting (for consistent diffs)
  
  // Special items for control flow
  controlFlowItems: [
    { id: 'loop', name: 'Loop', type: 'loop', description: 'Repeat recipes multiple times', icon: 'repeat' }
  ],
  
  /**
   * Get actual byte size of a string (handles UTF-8 properly)
   */
  getByteSize(str) {
    if (!str) return 0;
    return new Blob([str]).size;
  },
  
  /**
   * Parse CONFIG PARAMETERS comments from plugin code
   * Format:
   *   // CONFIG PARAMETERS:
   *   // - paramName: description - Type (default: value)
   *   // - anotherParam: another description - Number
   *   // - boolParam: some bool - Boolean (default: true)
   * 
   * @param {string} code - The plugin source code
   * @returns {Object} - Config hints object { paramName: { description, type, default } }
   */
  parseConfigComments(code) {
    const hints = {};
    if (!code) return hints;
    
    // Match the CONFIG PARAMETERS block
    const configMatch = code.match(/\/\/\s*CONFIG\s*PARAMETERS\s*:?\s*([\s\S]*?)(?=\n\s*\n|\nconst|\nlet|\nvar|\nfunction|\n\/\/[^-]|$)/i);
    if (!configMatch) return hints;
    
    const configBlock = configMatch[1];
    
    // Match each parameter line: // - paramName: description - Type (default: value)
    const paramRegex = /\/\/\s*-\s*(\w+)\s*:\s*([^-\n]+?)(?:\s*-\s*(\w+))?(?:\s*\(default:\s*([^)]+)\))?\s*$/gm;
    let match;
    
    while ((match = paramRegex.exec(configBlock)) !== null) {
      const [, paramName, description, typeStr, defaultStr] = match;
      const type = (typeStr || 'string').toLowerCase();
      
      // Map common type names
      const typeMap = {
        'string': 'string',
        'str': 'string',
        'number': 'number',
        'num': 'number',
        'int': 'number',
        'integer': 'number',
        'float': 'number',
        'boolean': 'boolean',
        'bool': 'boolean',
        'array': 'array',
        'list': 'array',
        'object': 'object',
        'obj': 'object'
      };
      
      const mappedType = typeMap[type] || 'string';
      
      hints[paramName] = {
        description: description.trim(),
        type: mappedType
      };
      
      // Parse default value if provided
      if (defaultStr !== undefined) {
        const trimmedDefault = defaultStr.trim();
        let parsedDefault;
        
        switch (mappedType) {
          case 'boolean':
            parsedDefault = trimmedDefault.toLowerCase() === 'true';
            break;
          case 'number':
            parsedDefault = parseFloat(trimmedDefault);
            if (isNaN(parsedDefault)) parsedDefault = 0;
            break;
          case 'array':
            try {
              parsedDefault = JSON.parse(trimmedDefault);
              if (!Array.isArray(parsedDefault)) parsedDefault = [];
            } catch { parsedDefault = []; }
            break;
          case 'object':
            try {
              parsedDefault = JSON.parse(trimmedDefault);
              if (typeof parsedDefault !== 'object' || Array.isArray(parsedDefault)) parsedDefault = {};
            } catch { parsedDefault = {}; }
            break;
          default:
            // String - remove quotes if present
            parsedDefault = trimmedDefault.replace(/^["']|["']$/g, '');
        }
        
        hints[paramName].default = parsedDefault;
      }
    }
    
    return hints;
  },
  
  /**
   * Initialize recipe manager
   */
  async init() {
    await this.loadBuiltins();
    await this.loadUserPlugins();
    await this.loadScripts(); // Load from server
    await this.loadInlineScripts(); // Migrate any legacy localStorage scripts
    this.renderLibrary();
    this.renderChain();
    this.setupDragAndDrop();
    this.setupEventListeners();
  },
  
  /**
   * Load built-in transforms
   */
  async loadBuiltins() {
    try {
      const result = await API.getBuiltins();
      this.builtins = result.transforms || [];
    } catch (error) {
      console.error('Failed to load built-in transforms:', error);
      this.builtins = [];
    }
  },
  
  /**
   * Load user plugins
   */
  async loadUserPlugins() {
    try {
      const result = await API.getPlugins();
      this.userPlugins = result.plugins || [];
      this.pluginCategories = result.categories || [];
    } catch (error) {
      console.error('Failed to load user plugins:', error);
      this.userPlugins = [];
      this.pluginCategories = [];
    }
  },

  /**
   * Load inline scripts from localStorage (legacy migration)
   */
  async loadInlineScripts() {
    // Legacy: migrate any localStorage scripts to server
    await this.migrateLocalStorageScripts();
  },

  /**
   * Migrate localStorage scripts to server (one-time)
   */
  async migrateLocalStorageScripts() {
    try {
      const saved = localStorage.getItem('jsdeob-inline-scripts');
      if (saved) {
        const scripts = JSON.parse(saved);
        for (const script of scripts) {
          // Check if already exists on server
          const existing = this.inlineScripts.find(s => s.name === script.name);
          if (!existing) {
            await API.createScript({
              name: script.name,
              description: script.description || '',
              code: script.code,
              config: script.config || {}
            });
          }
        }
        // Clear localStorage after migration
        localStorage.removeItem('jsdeob-inline-scripts');
        // Reload from server
        await this.loadScripts();
        this.renderLibrary();
      }
    } catch (error) {
      console.error('Failed to migrate localStorage scripts:', error);
    }
  },

  /**
   * Load scripts from server
   */
  async loadScripts() {
    try {
      const result = await API.getScripts();
      this.inlineScripts = result.scripts || [];
    } catch (error) {
      console.error('Failed to load scripts:', error);
      this.inlineScripts = [];
    }
  },
  
  /**
   * Render the recipe library sidebar
   */
  renderLibrary() {
    // Render built-ins
    const builtinContainer = document.getElementById('builtin-recipes');
    builtinContainer.innerHTML = this.builtins.map(t => this.createLibraryItem(t, 'builtin')).join('');
    
    // Render dynamic plugin categories
    this.renderDynamicCategories();
    
    // Render saved scripts (not temporary quick scripts)
    const inlineContainer = document.getElementById('inline-recipes');
    if (this.inlineScripts.length === 0) {
      inlineContainer.innerHTML = '<div class="recipe-empty">No saved scripts</div>';
    } else {
      inlineContainer.innerHTML = this.inlineScripts.map(s => this.createLibraryItem(s, 'inline')).join('');
    }
    
    // Render control flow items
    const controlContainer = document.getElementById('control-recipes');
    if (controlContainer) {
      controlContainer.innerHTML = this.controlFlowItems.map(c => this.createLibraryItem(c, 'control')).join('');
    }
  },
  
  /**
   * Render dynamic plugin categories based on folder structure
   */
  renderDynamicCategories() {
    const container = document.getElementById('dynamic-plugin-categories');
    if (!container) return;
    
    // Clear existing
    container.innerHTML = '';
    
    // Group plugins by category
    const pluginsByCategory = {};
    for (const plugin of this.userPlugins) {
      const cat = plugin.category || plugin.folder || 'uncategorized';
      if (!pluginsByCategory[cat]) {
        pluginsByCategory[cat] = [];
      }
      pluginsByCategory[cat].push(plugin);
    }
    
    // Create section for each category (use categories array for ordering)
    for (const category of this.pluginCategories) {
      const plugins = pluginsByCategory[category.id] || [];
      if (plugins.length === 0) continue;
      
      const groupHtml = `
        <div class="recipe-group" data-group="${category.id}">
          <div class="recipe-group-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>${category.name}</span>
            <span class="recipe-group-count">(${plugins.length})</span>
          </div>
          <div class="recipe-group-items" id="category-${category.id}-recipes">
            ${plugins.map(p => this.createLibraryItem(p, 'plugin')).join('')}
          </div>
        </div>
      `;
      container.innerHTML += groupHtml;
    }
    
    // Re-setup collapsible headers for new categories
    this.setupCategoryCollapsibles();
  },
  
  /**
   * Setup collapsible behavior for dynamically created categories
   */
  setupCategoryCollapsibles() {
    const container = document.getElementById('dynamic-plugin-categories');
    if (!container) return;
    
    const headers = container.querySelectorAll('.recipe-group-header');
    headers.forEach(header => {
      // Remove any existing listener
      const newHeader = header.cloneNode(true);
      header.parentNode.replaceChild(newHeader, header);
      
      newHeader.addEventListener('click', (e) => {
        // Don't collapse if clicking a button
        if (e.target.closest('button')) return;
        
        const group = newHeader.closest('.recipe-group');
        group.classList.toggle('collapsed');
      });
    });
  },
  
  /**
   * Create a library item HTML
   */
  createLibraryItem(item, type) {
    const categoryBadge = item.category && type !== 'plugin' ? 
      `<span class="recipe-item-category">${item.category}</span>` : '';
    
    // Add view button for built-ins (read-only view of source)
    const viewButton = type === 'builtin' ? `
      <button class="recipe-item-view btn btn-icon btn-tiny" 
              data-id="${item.id}" 
              data-type="${type}"
              title="View Source Code">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
    ` : '';
    
    // Add view button for folder-based plugins (read-only since they're files)
    const pluginViewButton = type === 'plugin' ? `
      <button class="recipe-item-view btn btn-icon btn-tiny" 
              data-id="${item.id}" 
              data-type="${type}"
              title="View Plugin Code">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>
    ` : '';
    
    // Add edit button for user plugins, inline scripts, and server scripts
    const editButton = (type === 'user' || type === 'inline' || type === 'script') ? `
      <button class="recipe-item-edit btn btn-icon btn-tiny" 
              data-id="${item.id}" 
              data-type="${type}"
              title="Edit Script">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </button>
    ` : '';
    
    // Add delete button for deletable types (user plugins, inline scripts, server scripts)
    const deleteButton = (type === 'user' || type === 'inline' || type === 'script' || type === 'plugin') ? `
      <button class="recipe-item-delete btn btn-icon btn-tiny" 
              data-id="${item.id}" 
              data-type="${type}"
              data-name="${item.name}"
              title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    ` : '';
    
    // Choose icon based on type
    let icon;
    if (type === 'control' && item.icon === 'repeat') {
      icon = `<svg class="recipe-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="17 1 21 5 17 9"></polyline>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
        <polyline points="7 23 3 19 7 15"></polyline>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
      </svg>`;
    } else {
      icon = `<svg class="recipe-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
      </svg>`;
    }
    
    return `
      <div class="recipe-item ${type === 'control' ? 'recipe-item-control' : ''}" 
           data-id="${item.id}" 
           data-type="${type}"
           draggable="true"
           title="${item.description || item.name}">
        ${icon}
        <span class="recipe-item-name">${item.name}</span>
        ${categoryBadge}
        ${viewButton}
        ${pluginViewButton}
        ${editButton}
        ${deleteButton}
      </div>
    `;
  },
  
  /**
   * Render the recipe chain
   */
  renderChain() {
    const container = document.getElementById('recipe-chain');
    
    if (this.chain.length === 0) {
      container.innerHTML = `
        <div class="recipe-drop-zone" data-index="0">
          <span class="recipe-chain-empty">Drag recipes here to build your pipeline</span>
        </div>
      `;
    } else {
      let html = '<div class="recipe-drop-zone" data-index="0"></div>';
      
      this.chain.forEach((item, index) => {
        if (item.type === 'loop') {
          html += this.createLoopCard(item, index);
        } else {
          html += this.createChainCard(item, index);
        }
        html += `
          <div class="recipe-arrow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </div>
          <div class="recipe-drop-zone" data-index="${index + 1}"></div>
        `;
      });
      
      container.innerHTML = html;
    }
    
    this.updateStepProgress();
    this.setupChainEventListeners();
  },
  
  /**
   * Create a loop container card HTML
   */
  createLoopCard(item, index) {
    const statusClass = item.status || '';
    const enabledChecked = item.enabled !== false ? 'checked' : '';
    const iterations = item.iterations || 3;
    const children = item.children || [];
    const currentIter = item.currentIteration || 0;
    const progressText = item.status === 'active' ? ` (${currentIter}/${iterations})` : '';
    
    // Render children inside loop
    let childrenHtml = '';
    children.forEach((child, childIndex) => {
      childrenHtml += `
        <div class="loop-drop-zone" data-loop-index="${index}" data-child-index="${childIndex}"></div>
        ${this.createLoopChildCard(child, index, childIndex)}
      `;
    });
    childrenHtml += `
      <div class="loop-drop-zone loop-drop-zone-empty" data-loop-index="${index}" data-child-index="${children.length}">
        <span class="loop-drop-hint">Drop recipes here</span>
      </div>
    `;
    
    return `
      <div class="recipe-card recipe-loop ${statusClass} ${item.enabled === false ? 'disabled' : ''}" 
           data-index="${index}"
           data-type="loop"
           draggable="true">
        <div class="recipe-card-header loop-header">
          <svg class="recipe-card-drag" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"></circle>
            <circle cx="15" cy="5" r="1.5"></circle>
            <circle cx="9" cy="12" r="1.5"></circle>
            <circle cx="15" cy="12" r="1.5"></circle>
            <circle cx="9" cy="19" r="1.5"></circle>
            <circle cx="15" cy="19" r="1.5"></circle>
          </svg>
          <svg class="loop-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="17 1 21 5 17 9"></polyline>
            <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
            <polyline points="7 23 3 19 7 15"></polyline>
            <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
          </svg>
          <span class="recipe-card-name">Loop<span class="loop-progress">${progressText}</span></span>
          <div class="loop-iterations">
            <button class="btn btn-icon btn-tiny loop-iter-btn" data-action="loop-iter-dec" data-index="${index}" title="Decrease iterations">−</button>
            <span class="loop-iter-times">×</span><input type="number" class="loop-iter-input" value="${iterations}" min="1" max="10000" data-index="${index}" title="Enter iterations (1-10000)">
            <button class="btn btn-icon btn-tiny loop-iter-btn" data-action="loop-iter-inc" data-index="${index}" title="Increase iterations">+</button>
          </div>
          <label class="recipe-card-enable" title="${item.enabled !== false ? 'Disable' : 'Enable'}">
            <input type="checkbox" ${enabledChecked} data-index="${index}">
          </label>
        </div>
        <div class="loop-children">
          ${childrenHtml}
        </div>
        <div class="recipe-card-footer">
          <button class="btn btn-icon btn-tiny" data-action="remove" data-index="${index}" title="Remove Loop">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    `;
  },
  
  /**
   * Create a card for a recipe inside a loop
   */
  createLoopChildCard(item, loopIndex, childIndex) {
    const statusClass = item.status || '';
    const enabledChecked = item.enabled !== false ? 'checked' : '';
    const iterations = item.iterations || 1;
    const currentIter = item.currentIteration || 0;
    const progressText = item.status === 'active' && iterations > 1 ? ` (${currentIter}/${iterations})` : '';
    
    return `
      <div class="recipe-card loop-child ${statusClass} ${item.enabled === false ? 'disabled' : ''}" 
           data-loop-index="${loopIndex}"
           data-child-index="${childIndex}"
           draggable="true">
        <div class="recipe-card-header">
          <svg class="recipe-card-drag" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"></circle>
            <circle cx="15" cy="5" r="1.5"></circle>
            <circle cx="9" cy="12" r="1.5"></circle>
            <circle cx="15" cy="12" r="1.5"></circle>
          </svg>
          <span class="recipe-card-name">${item.name}<span class="loop-child-progress">${progressText}</span></span>
          <div class="loop-child-iterations">
            <button class="btn btn-icon btn-tiny loop-child-iter-btn" data-action="child-iter-dec" data-loop-index="${loopIndex}" data-child-index="${childIndex}" title="Decrease">−</button>
            <span class="loop-iter-times">×</span><input type="number" class="loop-child-iter-input" value="${iterations}" min="1" max="10000" data-loop-index="${loopIndex}" data-child-index="${childIndex}" title="Enter iterations (1-10000)">
            <button class="btn btn-icon btn-tiny loop-child-iter-btn" data-action="child-iter-inc" data-loop-index="${loopIndex}" data-child-index="${childIndex}" title="Increase">+</button>
          </div>
          <label class="recipe-card-enable loop-child-enable">
            <input type="checkbox" ${enabledChecked} data-loop-index="${loopIndex}" data-child-index="${childIndex}">
          </label>
          <button class="btn btn-icon btn-tiny loop-child-remove" data-action="remove-child" data-loop-index="${loopIndex}" data-child-index="${childIndex}" title="Remove from loop">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    `;
  },
  
  /**
   * Create a chain card HTML
   */
  createChainCard(item, index) {
    const statusClass = item.status || '';
    const enabledChecked = item.enabled !== false ? 'checked' : '';
    const iterations = item.iterations || 1;
    const showIterations = iterations > 1;
    const currentIter = item.currentIteration || 0;
    const progressText = item.status === 'active' && iterations > 1 ? ` (${currentIter}/${iterations})` : '';
    const statsHtml = item.stats ? 
      `<div class="recipe-card-stats">${this.formatStats(item.stats)}</div>` : '';
    
    // Check if this is a temporary/quick script (type 'inline' with temp- id)
    const isQuickScript = item.type === 'inline' && item.id?.startsWith('temp-');
    const quickBadge = isQuickScript ? '<span class="quick-badge" title="Quick Script - Not saved">⚡</span>' : '';
    
    // Build tooltip with description and stats
    const description = item.description || '';
    const statsText = item.stats ? Object.entries(item.stats)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') : '';
    const tooltip = [description, statsText].filter(Boolean).join(' | ') || item.name;
    
    // Check if config panel should be expanded
    const configExpanded = item.configExpanded || false;
    const hasConfig = item.config && Object.keys(item.config).length > 0;
    const configBadge = hasConfig ? `<span class="config-badge" title="Has configuration">${Object.keys(item.config).length}</span>` : '';
    
    // Build inline config panel HTML
    const configPanelHtml = this.buildInlineConfigPanel(item, index);
    
    // Add "Save" button for quick scripts
    const saveQuickBtn = isQuickScript ? `
          <button class="btn btn-icon btn-tiny btn-save-quick" data-action="save-quick" data-index="${index}" title="Save as Plugin">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
          </button>` : '';

    return `
      <div class="recipe-card ${statusClass} ${item.enabled === false ? 'disabled' : ''} ${configExpanded ? 'config-expanded' : ''} ${isQuickScript ? 'quick-script' : ''}" 
           data-index="${index}"
           data-tooltip="${this.escapeHtml(tooltip)}"
           draggable="true">
        <div class="recipe-card-header">
          <svg class="recipe-card-drag" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"></circle>
            <circle cx="15" cy="5" r="1.5"></circle>
            <circle cx="9" cy="12" r="1.5"></circle>
            <circle cx="15" cy="12" r="1.5"></circle>
            <circle cx="9" cy="19" r="1.5"></circle>
            <circle cx="15" cy="19" r="1.5"></circle>
          </svg>
          <span class="recipe-card-index">${index + 1}</span>
          <span class="recipe-card-name">${quickBadge}${item.name}<span class="recipe-progress">${progressText}</span></span>
          <div class="recipe-card-iterations ${showIterations ? '' : 'single'}">
            <button class="btn btn-icon btn-tiny recipe-iter-btn" data-action="iter-dec" data-index="${index}" title="Decrease">−</button>
            <span class="recipe-iter-display">×</span><input type="text" class="recipe-iter-input" value="${iterations}" data-index="${index}" title="Iterations">
            <button class="btn btn-icon btn-tiny recipe-iter-btn" data-action="iter-inc" data-index="${index}" title="Increase">+</button>
          </div>
          <label class="recipe-card-enable" title="${item.enabled !== false ? 'Disable' : 'Enable'}">
            <input type="checkbox" ${enabledChecked} data-index="${index}">
          </label>
        </div>
        <div class="recipe-card-body">
          ${statsHtml}
        </div>
        <div class="recipe-card-footer">
          <button class="btn btn-icon btn-tiny" data-action="rename" data-index="${index}" title="Rename">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
            </svg>
          </button>
          <button class="btn btn-icon btn-tiny" data-action="edit" data-index="${index}" title="Edit Code">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button class="btn btn-icon btn-tiny ${configExpanded ? 'active' : ''}" data-action="toggle-config" data-index="${index}" title="Configure Parameters">
            ${configBadge}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>${saveQuickBtn}
          <button class="btn btn-icon btn-tiny" data-action="duplicate" data-index="${index}" title="Duplicate">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
          <button class="btn btn-icon btn-tiny" data-action="remove" data-index="${index}" title="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        ${configPanelHtml}
      </div>
    `;
  },
  
  /**
   * Build inline config panel HTML (CyberChef-style)
   */
  buildInlineConfigPanel(item, index) {
    const config = item.config || {};
    const configExpanded = item.configExpanded || false;
    
    // Get expected parameters from configHints (set during plugin load)
    const configHints = item.configHints || {};
    
    // Build existing config entries
    let entriesHtml = '';
    const configKeys = Object.keys(config);
    const hintKeys = Object.keys(configHints);
    
    // Show all current config entries
    for (const [key, value] of Object.entries(config)) {
      // Skip configHints metadata entries (they have description/type/default)
      if (value && typeof value === 'object' && value.description) continue;
      entriesHtml += this.buildConfigEntry(index, key, value, configHints[key]);
    }
    
    // Show hint for expected parameters that aren't set yet
    const missingParams = hintKeys.filter(k => !configKeys.includes(k));
    let hintsHtml = '';
    if (missingParams.length > 0) {
      hintsHtml = `<div class="config-hints">
        <div class="config-hints-label">Expected parameters:</div>
        ${missingParams.map(param => {
          const hint = configHints[param];
          return `<button class="config-hint-btn" data-action="add-hint-param" data-index="${index}" data-param="${param}" data-type="${hint.type || 'string'}" title="${this.escapeHtml(hint.description || '')}">
            + ${param} <span class="hint-type">(${hint.type || 'string'})</span>
          </button>`;
        }).join('')}
      </div>`;
    }
    
    // Build message for empty config
    let emptyMsg = '';
    if (!entriesHtml && !hintsHtml) {
      emptyMsg = '<div class="config-empty">Click + to add parameters</div>';
    } else if (!entriesHtml && hintsHtml) {
      emptyMsg = '<div class="config-empty">Click a parameter below to add it:</div>';
    }
    
    return `
      <div class="recipe-config-panel ${configExpanded ? 'expanded' : ''}" data-index="${index}">
        <div class="config-panel-header">
          <span class="config-panel-title">Parameters</span>
          <button class="btn btn-icon btn-tiny" data-action="add-config-param" data-index="${index}" title="Add Custom Parameter">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
        <div class="config-entries" data-index="${index}">
          ${emptyMsg}${entriesHtml}
        </div>
        ${hintsHtml}
      </div>
    `;
  },
  
  /**
   * Build a single config entry row
   */
  buildConfigEntry(index, key, value, hint) {
    const item = this.chain[index];
    // Priority: 1) User's stored type, 2) Hint type, 3) Auto-detect
    let valueType;
    if (item && item.configTypes && item.configTypes[key]) {
      valueType = item.configTypes[key];
    } else if (hint && hint.type) {
      valueType = hint.type;
    } else {
      valueType = this.detectValueType(value);
    }
    let displayValue = value;
    
    // Format value for display
    if (valueType === 'array' || valueType === 'object') {
      displayValue = JSON.stringify(value, null, 0);
    } else if (valueType === 'string') {
      displayValue = value;
    }
    
    const hintDesc = hint ? ` title="${this.escapeHtml(hint.description || '')}"` : '';
    
    return `
      <div class="config-entry" data-index="${index}" data-key="${this.escapeHtml(key)}">
        <input type="text" class="config-key" value="${this.escapeHtml(key)}" placeholder="key" data-index="${index}" data-old-key="${this.escapeHtml(key)}">
        <select class="config-type" data-index="${index}" data-key="${this.escapeHtml(key)}">
          <option value="string" ${valueType === 'string' ? 'selected' : ''}>String</option>
          <option value="number" ${valueType === 'number' ? 'selected' : ''}>Number</option>
          <option value="boolean" ${valueType === 'boolean' ? 'selected' : ''}>Boolean</option>
          <option value="array" ${valueType === 'array' ? 'selected' : ''}>Array</option>
          <option value="object" ${valueType === 'object' ? 'selected' : ''}>Object</option>
        </select>
        ${valueType === 'boolean' 
          ? `<select class="config-value config-value-bool" data-index="${index}" data-key="${this.escapeHtml(key)}">
              <option value="true" ${value === true ? 'selected' : ''}>true</option>
              <option value="false" ${value === false ? 'selected' : ''}>false</option>
             </select>`
          : `<textarea class="config-value" data-index="${index}" data-key="${this.escapeHtml(key)}" placeholder="value" rows="1">${this.escapeHtml(String(displayValue))}</textarea>`
        }
        <button class="btn btn-icon btn-tiny config-remove" data-action="remove-config-param" data-index="${index}" data-key="${this.escapeHtml(key)}" title="Remove">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
  },
  
  /**
   * Detect the type of a config value
   */
  detectValueType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'string';
    if (typeof value === 'object') return 'object';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    return 'string';
  },
  
  /**
   * Toggle config panel for a recipe card
   */
  toggleConfigPanel(index) {
    const item = this.chain[index];
    if (!item) return;
    
    item.configExpanded = !item.configExpanded;
    this.renderChain();
  },
  
  /**
   * Add a new config parameter
   */
  addConfigParam(index) {
    const item = this.chain[index];
    if (!item) return;
    
    if (!item.config) item.config = {};
    
    // Generate unique key
    let keyNum = 1;
    let newKey = 'param1';
    while (item.config.hasOwnProperty(newKey)) {
      keyNum++;
      newKey = `param${keyNum}`;
    }
    
    item.config[newKey] = '';
    item.configExpanded = true;
    this.renderChain();
    
    // Focus the new key input
    setTimeout(() => {
      const panel = document.querySelector(`.recipe-config-panel[data-index="${index}"]`);
      if (panel) {
        const lastEntry = panel.querySelector('.config-entry:last-child .config-key');
        if (lastEntry) lastEntry.focus();
      }
    }, 50);
  },
  
  /**
   * Add a config parameter from hint (expected parameter)
   */
  addHintParam(index, paramName, type) {
    const item = this.chain[index];
    if (!item) return;
    
    if (!item.config) item.config = {};
    
    // Get default value based on type
    let defaultValue;
    switch (type) {
      case 'array': defaultValue = []; break;
      case 'object': defaultValue = {}; break;
      case 'number': defaultValue = 0; break;
      case 'boolean': defaultValue = false; break;
      default: defaultValue = '';
    }
    
    // Check if there's a hint with a default value
    if (item.configHints && item.configHints[paramName] && item.configHints[paramName].default !== undefined) {
      defaultValue = item.configHints[paramName].default;
    }
    
    item.config[paramName] = defaultValue;
    
    // Store the hint's type - this is authoritative from the plugin
    if (!item.configTypes) item.configTypes = {};
    item.configTypes[paramName] = type;
    
    console.log(`Added param ${paramName} with type ${type} from hint`);
    
    item.configExpanded = true;
    this.renderChain();
    this.dispatchChainChanged();
    
    // Focus the new value input
    setTimeout(() => {
      const panel = document.querySelector(`.recipe-config-panel[data-index="${index}"]`);
      if (panel) {
        const entry = panel.querySelector(`.config-entry[data-key="${paramName}"] .config-value`);
        if (entry) entry.focus();
      }
    }, 50);
  },
  
  /**
   * Remove a config parameter
   */
  removeConfigParam(index, key) {
    const item = this.chain[index];
    if (!item || !item.config) return;
    
    delete item.config[key];
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Update a config parameter value
   */
  updateConfigParam(index, key, value, type) {
    const item = this.chain[index];
    if (!item) return;
    
    if (!item.config) item.config = {};
    
    // Convert value based on type
    let parsedValue = value;
    console.log(`Updating config[${key}] with type=${type}, raw value:`, value);
    
    try {
      switch (type) {
        case 'number':
          parsedValue = parseFloat(value) || 0;
          break;
        case 'boolean':
          parsedValue = value === 'true' || value === true;
          break;
        case 'array':
        case 'object':
          // If it's already parsed, keep it
          if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
            parsedValue = value;
          } else if (typeof value === 'string' && value.trim()) {
            try {
              // Try JSON first
              parsedValue = JSON.parse(value);
            } catch (jsonErr) {
              // Fall back to evaluating as JS (for single quotes, special chars)
              // Using Function constructor is safer than eval
              try {
                parsedValue = new Function('return ' + value.trim())();
              } catch (evalErr) {
                console.error('Could not parse as JSON or JS:', jsonErr.message);
                parsedValue = value; // Keep as string
              }
            }
          } else {
            parsedValue = type === 'array' ? [] : {};
          }
          break;
        default:
          parsedValue = String(value);
      }
      console.log(`Parsed value (${type}):`, parsedValue, 'isArray:', Array.isArray(parsedValue));
    } catch (e) {
      console.error(`Failed to parse config value as ${type}:`, e.message);
      console.error('Raw value was:', value);
      // Keep as string if parse fails - but warn user
      parsedValue = value;
    }
    
    item.config[key] = parsedValue;
    
    // ALWAYS store the user's chosen type - their choice overrules detection
    if (!item.configTypes) item.configTypes = {};
    item.configTypes[key] = type;
    
    console.log(`Stored type for ${key}: ${type}`);
    
    this.dispatchChainChanged();
  },
  
  /**
   * Rename a config parameter key
   */
  renameConfigKey(index, oldKey, newKey) {
    const item = this.chain[index];
    if (!item || !item.config) return;
    
    if (oldKey === newKey) return;
    if (!newKey || newKey.trim() === '') return;
    
    const value = item.config[oldKey];
    delete item.config[oldKey];
    item.config[newKey] = value;
    
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Format stats for display
   */
  formatStats(stats) {
    if (!stats) return '';
    const parts = [];
    for (const [key, value] of Object.entries(stats)) {
      if (typeof value === 'number') {
        parts.push(`${key}: ${value}`);
      }
    }
    return parts.join(' | ');
  },
  
  /**
   * Escape HTML for safe attribute insertion
   */
  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },
  
  /**
   * Update step progress display
   */
  updateStepProgress() {
    const current = document.querySelector('.step-current');
    const total = document.querySelector('.step-total');
    
    if (current && total) {
      current.textContent = Math.max(0, this.currentStep + 1);
      total.textContent = this.chain.length;
    }
  },
  
  /**
   * Setup drag and drop for library items
   */
  setupDragAndDrop() {
    // Double-click to add recipe to chain
    document.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.recipe-item');
      if (item) {
        const id = item.dataset.id;
        const type = item.dataset.type;
        this.addToChain(id, type);
      }
    });
    
    // Library item drag
    document.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.recipe-item');
      if (item) {
        this.draggedItem = {
          id: item.dataset.id,
          type: item.dataset.type,
          source: 'library'
        };
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'copy';
        return;
      }
      
      // Loop child card drag
      const loopChild = e.target.closest('.loop-child');
      if (loopChild) {
        this.draggedItem = {
          loopIndex: parseInt(loopChild.dataset.loopIndex),
          childIndex: parseInt(loopChild.dataset.childIndex),
          source: 'loop-child'
        };
        loopChild.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        return;
      }
      
      // Chain card drag (but not loop children)
      const card = e.target.closest('.recipe-card');
      if (card && !card.classList.contains('loop-child')) {
        this.draggedItem = {
          index: parseInt(card.dataset.index),
          source: 'chain'
        };
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    
    document.addEventListener('dragend', (e) => {
      const item = e.target.closest('.recipe-item, .recipe-card');
      if (item) {
        item.classList.remove('dragging');
      }
      this.draggedItem = null;
      
      // Remove all drag-over states
      document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
      });
    });
    
    // Drop zones
    document.addEventListener('dragover', (e) => {
      const dropZone = e.target.closest('.recipe-drop-zone, .loop-drop-zone, .recipe-chain');
      if (dropZone && this.draggedItem) {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      }
    });
    
    document.addEventListener('dragleave', (e) => {
      const dropZone = e.target.closest('.recipe-drop-zone, .loop-drop-zone, .recipe-chain');
      if (dropZone) {
        dropZone.classList.remove('drag-over');
      }
    });
    
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const loopDropZone = e.target.closest('.loop-drop-zone');
      const dropZone = e.target.closest('.recipe-drop-zone, .recipe-chain');
      
      if (loopDropZone && this.draggedItem) {
        loopDropZone.classList.remove('drag-over');
        this.handleLoopDrop(loopDropZone);
      } else if (dropZone && this.draggedItem) {
        dropZone.classList.remove('drag-over');
        this.handleDrop(dropZone);
      }
    });
  },
  
  /**
   * Handle drop into a loop container
   */
  handleLoopDrop(dropZone) {
    const loopIndex = parseInt(dropZone.dataset.loopIndex);
    const childIndex = parseInt(dropZone.dataset.childIndex);
    const loop = this.chain[loopIndex];
    
    if (!loop || loop.type !== 'loop') return;
    if (!loop.children) loop.children = [];
    
    if (this.draggedItem.source === 'library') {
      // Don't allow adding loops inside loops
      if (this.draggedItem.type === 'control' && this.draggedItem.id === 'loop') {
        App.log('Cannot nest loops', 'warn');
        return;
      }
      
      // Add new item from library into loop
      const item = this.findLibraryItem(this.draggedItem.id, this.draggedItem.type);
      if (item) {
        const childItem = {
          id: item.id,
          type: this.draggedItem.type,
          name: item.name,
          code: item.code,
          description: item.description || '',
          config: { ...item.config },
          enabled: true,
          iterations: 1,
          status: ''
        };
        loop.children.splice(childIndex, 0, childItem);
      }
    } else if (this.draggedItem.source === 'loop-child') {
      // Reorder within same loop or move between loops
      const fromLoopIndex = this.draggedItem.loopIndex;
      const fromChildIndex = this.draggedItem.childIndex;
      
      if (fromLoopIndex === loopIndex) {
        // Reorder within same loop
        if (fromChildIndex !== childIndex && fromChildIndex !== childIndex - 1) {
          const [item] = loop.children.splice(fromChildIndex, 1);
          const newIndex = fromChildIndex < childIndex ? childIndex - 1 : childIndex;
          loop.children.splice(newIndex, 0, item);
        }
      } else {
        // Move from one loop to another
        const fromLoop = this.chain[fromLoopIndex];
        if (fromLoop && fromLoop.children) {
          const [item] = fromLoop.children.splice(fromChildIndex, 1);
          loop.children.splice(childIndex, 0, item);
        }
      }
    } else if (this.draggedItem.source === 'chain') {
      // Moving a chain item into a loop
      const fromIndex = this.draggedItem.index;
      const item = this.chain[fromIndex];
      
      // Don't allow moving loops into loops
      if (item.type === 'loop') {
        App.log('Cannot nest loops', 'warn');
        return;
      }
      
      // Remove from chain and add to loop
      const [removed] = this.chain.splice(fromIndex, 1);
      removed.iterations = removed.iterations || 1;
      loop.children.splice(childIndex, 0, removed);
    }
    
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Handle drop event
   */
  handleDrop(dropZone) {
    const targetIndex = dropZone.dataset.index !== undefined ? 
      parseInt(dropZone.dataset.index) : this.chain.length;
    
    let newItemFromLibrary = null; // Track if we're adding a new item from library
    
    if (this.draggedItem.source === 'library') {
      // Handle control items (loop)
      if (this.draggedItem.type === 'control') {
        if (this.draggedItem.id === 'loop') {
          const loopItem = {
            id: 'loop',
            type: 'loop',
            name: 'Loop',
            iterations: 3,
            enabled: true,
            children: [],
            status: ''
          };
          this.chain.splice(targetIndex, 0, loopItem);
          // Note: Loops don't auto-run, so we don't set newItemFromLibrary
        }
      } else {
        // Add new item from library
        const item = this.findLibraryItem(this.draggedItem.id, this.draggedItem.type);
        if (item) {
          // Separate configHints from actual config values
          const configHints = {};
          const actualConfig = {};
          
          if (item.config) {
            for (const [key, value] of Object.entries(item.config)) {
              if (value && typeof value === 'object' && (value.description !== undefined || value.type !== undefined)) {
                configHints[key] = value;
              } else {
                actualConfig[key] = value;
              }
            }
          }
          
          // Parse CONFIG PARAMETERS comments from code (for inline scripts/plugins)
          if (item.code && Object.keys(configHints).length === 0) {
            const parsedHints = this.parseConfigComments(item.code);
            Object.assign(configHints, parsedHints);
          }
          
          // Auto-expand config panel if there are expected parameters
          const hasExpectedParams = Object.keys(configHints).length > 0;
          
          const chainItem = {
            id: item.id,
            type: this.draggedItem.type,
            name: item.name,
            code: item.code,
            description: item.description || '',
            config: actualConfig,
            configHints: configHints,
            configExpanded: hasExpectedParams, // Auto-expand if hints exist
            enabled: true,
            iterations: 1,
            status: ''
          };
          this.chain.splice(targetIndex, 0, chainItem);
          newItemFromLibrary = chainItem; // Track for auto-run
        }
      }
    } else if (this.draggedItem.source === 'chain') {
      // Reorder within chain
      const fromIndex = this.draggedItem.index;
      if (fromIndex !== targetIndex && fromIndex !== targetIndex - 1) {
        const [item] = this.chain.splice(fromIndex, 1);
        const newIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
        this.chain.splice(newIndex, 0, item);
      }
    } else if (this.draggedItem.source === 'loop-child') {
      // Moving a loop child out to the main chain
      const fromLoopIndex = this.draggedItem.loopIndex;
      const fromChildIndex = this.draggedItem.childIndex;
      const fromLoop = this.chain[fromLoopIndex];
      
      if (fromLoop && fromLoop.children) {
        const [item] = fromLoop.children.splice(fromChildIndex, 1);
        // Adjust targetIndex if the loop being modified is before the target
        let adjustedIndex = targetIndex;
        if (fromLoopIndex < targetIndex) {
          // If removing from a loop before the target, no adjustment needed
        }
        this.chain.splice(adjustedIndex, 0, item);
      }
    }
    
    this.renderChain();
    
    // If a new item was added from library, dispatch item-added for auto-run
    if (newItemFromLibrary) {
      this.dispatchItemAdded(newItemFromLibrary, targetIndex);
    } else {
      this.dispatchChainChanged();
    }
  },
  
  /**
   * Add item to chain from library (called by double-click)
   */
  addToChain(id, type) {
    // Handle control items specially
    if (type === 'control') {
      if (id === 'loop') {
        const loopItem = {
          id: 'loop',
          type: 'loop',
          name: 'Loop',
          iterations: 3,
          enabled: true,
          children: [],
          status: ''
        };
        this.chain.push(loopItem);
        this.renderChain();
        this.dispatchChainChanged();
      }
      return;
    }
    
    const item = this.findLibraryItem(id, type);
    if (item) {
      // Separate configHints from actual config values
      // configHints have structure like { paramName: { description, type, default } }
      const configHints = {};
      const actualConfig = {};
      
      console.log('Adding to chain:', item.name, 'config:', item.config);
      
      if (item.config) {
        for (const [key, value] of Object.entries(item.config)) {
          if (value && typeof value === 'object' && (value.description !== undefined || value.type !== undefined)) {
            // This is a hint, not an actual value
            configHints[key] = value;
            console.log('  Found hint:', key, value);
          } else {
            // This is an actual config value
            actualConfig[key] = value;
          }
        }
      }
      
      // Parse CONFIG PARAMETERS comments from code (for inline scripts/plugins)
      if (item.code && Object.keys(configHints).length === 0) {
        const parsedHints = this.parseConfigComments(item.code);
        Object.assign(configHints, parsedHints);
        console.log('  Parsed from comments:', parsedHints);
      }
      
      console.log('Extracted configHints:', configHints);
      
      // Auto-expand config panel if there are expected parameters
      const hasExpectedParams = Object.keys(configHints).length > 0;
      
      const chainItem = {
        id: item.id,
        type: type,
        name: item.name,
        code: item.code,
        exampleCode: item.exampleCode, // For built-in transforms
        description: item.description || '',
        config: actualConfig,
        configHints: configHints,
        configExpanded: hasExpectedParams, // Auto-expand if hints exist
        enabled: true,
        iterations: 1,
        status: ''
      };
      const newIndex = this.chain.length;
      this.chain.push(chainItem);
      this.renderChain();
      // Dispatch special event for item added (so we can run just the new one)
      this.dispatchItemAdded(chainItem, newIndex);
    }
  },
  
  /**
   * Dispatch event when item is added to chain
   */
  dispatchItemAdded(item, index) {
    window.dispatchEvent(new CustomEvent('chain-item-added', {
      detail: { item, index, chain: this.getChainData() }
    }));
    // Also dispatch general chain-changed for other listeners
    this.dispatchChainChanged();
  },
  
  /**
   * Find item in library
   */
  findLibraryItem(id, type) {
    if (type === 'builtin') {
      return this.builtins.find(t => t.id === id);
    } else if (type === 'user' || type === 'example' || type === 'plugin') {
      return this.userPlugins.find(p => p.id === id);
    } else if (type === 'inline' || type === 'script') {
      return this.inlineScripts.find(s => s.id === id);
    } else if (type === 'control') {
      return this.controlFlowItems.find(c => c.id === id);
    }
    return null;
  },
  
  /**
   * Setup event listeners for chain cards
   */
  setupChainEventListeners() {
    // Toggle enabled (checkbox in header) - for regular cards
    document.querySelectorAll('.recipe-card:not(.recipe-loop):not(.loop-child) .recipe-card-enable input').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.chain[index].enabled = e.target.checked;
        this.renderChain();
        this.dispatchChainChanged();
      });
    });
    
    // Regular card iteration buttons
    document.querySelectorAll('.recipe-iter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        const index = parseInt(btn.dataset.index);
        const item = this.chain[index];
        if (!item || item.type === 'loop') return;
        
        if (action === 'iter-inc') {
          item.iterations = (item.iterations || 1) + 1;
        } else if (action === 'iter-dec') {
          item.iterations = Math.max(1, (item.iterations || 1) - 1);
        }
        this.renderChain();
        this.dispatchChainChanged();
      });
    });
    
    // Regular card iteration input fields
    document.querySelectorAll('.recipe-iter-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const index = parseInt(input.dataset.index);
        const item = this.chain[index];
        if (!item || item.type === 'loop') return;
        
        const value = parseInt(input.value) || 1;
        item.iterations = Math.max(1, Math.min(10000, value));
        this.renderChain();
        this.dispatchChainChanged();
      });
      
      // Prevent drag when clicking input
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
    });
    
    // Loop enable checkbox
    document.querySelectorAll('.recipe-loop > .recipe-card-header .recipe-card-enable input').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.chain[index].enabled = e.target.checked;
        this.renderChain();
        this.dispatchChainChanged();
      });
    });
    
    // Loop child enable checkbox
    document.querySelectorAll('.loop-child .loop-child-enable input').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const loopIndex = parseInt(e.target.dataset.loopIndex);
        const childIndex = parseInt(e.target.dataset.childIndex);
        const loop = this.chain[loopIndex];
        if (loop && loop.children && loop.children[childIndex]) {
          loop.children[childIndex].enabled = e.target.checked;
          this.renderChain();
          this.dispatchChainChanged();
        }
      });
    });
    
    // Loop iteration buttons
    document.querySelectorAll('.loop-iter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        const index = parseInt(btn.dataset.index);
        const loop = this.chain[index];
        if (!loop) return;
        
        if (action === 'loop-iter-inc') {
          loop.iterations = (loop.iterations || 1) + 1;
        } else if (action === 'loop-iter-dec') {
          loop.iterations = Math.max(1, (loop.iterations || 1) - 1);
        }
        this.renderChain();
        this.dispatchChainChanged();
      });
    });
    
    // Loop iteration input fields
    document.querySelectorAll('.loop-iter-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const index = parseInt(input.dataset.index);
        const loop = this.chain[index];
        if (!loop) return;
        
        const value = parseInt(input.value) || 1;
        loop.iterations = Math.max(1, Math.min(10000, value));
        this.renderChain();
        this.dispatchChainChanged();
      });
      
      // Prevent drag when clicking input
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
    });
    
    // Loop child iteration buttons
    document.querySelectorAll('.loop-child-iter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        const loopIndex = parseInt(btn.dataset.loopIndex);
        const childIndex = parseInt(btn.dataset.childIndex);
        const loop = this.chain[loopIndex];
        if (!loop || !loop.children || !loop.children[childIndex]) return;
        
        const child = loop.children[childIndex];
        if (action === 'child-iter-inc') {
          child.iterations = (child.iterations || 1) + 1;
        } else if (action === 'child-iter-dec') {
          child.iterations = Math.max(1, (child.iterations || 1) - 1);
        }
        this.renderChain();
        this.dispatchChainChanged();
      });
    });
    
    // Loop child iteration input fields
    document.querySelectorAll('.loop-child-iter-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const loopIndex = parseInt(input.dataset.loopIndex);
        const childIndex = parseInt(input.dataset.childIndex);
        const loop = this.chain[loopIndex];
        if (!loop || !loop.children || !loop.children[childIndex]) return;
        
        const value = parseInt(input.value) || 1;
        loop.children[childIndex].iterations = Math.max(1, Math.min(10000, value));
        this.renderChain();
        this.dispatchChainChanged();
      });
      
      // Prevent drag when clicking input
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
    });
    
    // Loop child remove button
    document.querySelectorAll('.loop-child-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const loopIndex = parseInt(btn.dataset.loopIndex);
        const childIndex = parseInt(btn.dataset.childIndex);
        const loop = this.chain[loopIndex];
        if (loop && loop.children) {
          loop.children.splice(childIndex, 1);
          this.renderChain();
          this.dispatchChainChanged();
        }
      });
    });
    
    // Double-click loop child to edit
    document.querySelectorAll('.loop-child').forEach(card => {
      card.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, input')) return;
        const loopIndex = parseInt(card.dataset.loopIndex);
        const childIndex = parseInt(card.dataset.childIndex);
        this.editLoopChild(loopIndex, childIndex);
      });
    });
    
    // Card actions
    document.querySelectorAll('.recipe-card-footer button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        const index = parseInt(btn.dataset.index);
        
        switch (action) {
          case 'rename':
            this.renameCard(index);
            break;
          case 'edit':
            this.editChainItem(index);
            break;
          case 'toggle-config':
            this.toggleConfigPanel(index);
            break;
          case 'config':
            this.openConfigModal(index);
            break;
          case 'duplicate':
            this.duplicateCard(index);
            break;
          case 'remove':
            this.removeCard(index);
            break;
          case 'save-quick':
            this.saveQuickScriptAsPlugin(index);
            break;
        }
      });
    });
    
    // Config panel: Add parameter button
    document.querySelectorAll('[data-action="add-config-param"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        this.addConfigParam(index);
      });
    });
    
    // Config panel: Add hint parameter button (from suggestions)
    document.querySelectorAll('[data-action="add-hint-param"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        const param = btn.dataset.param;
        const type = btn.dataset.type || 'string';
        this.addHintParam(index, param, type);
      });
    });
    
    // Config panel: Remove parameter button
    document.querySelectorAll('[data-action="remove-config-param"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        const key = btn.dataset.key;
        this.removeConfigParam(index, key);
      });
    });
    
    // Config panel: Key input changes
    document.querySelectorAll('.config-key').forEach(input => {
      input.addEventListener('change', (e) => {
        const index = parseInt(input.dataset.index);
        const oldKey = input.dataset.oldKey;
        const newKey = input.value.trim();
        this.renameConfigKey(index, oldKey, newKey);
      });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
    });
    
    // Config panel: Value input changes
    document.querySelectorAll('.config-value').forEach(input => {
      input.addEventListener('change', (e) => {
        const index = parseInt(input.dataset.index);
        const key = input.dataset.key;
        const typeSelect = input.closest('.config-entry').querySelector('.config-type');
        const type = typeSelect ? typeSelect.value : 'string';
        this.updateConfigParam(index, key, input.value, type);
      });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
      
      // Auto-expand textarea for long values
      if (input.tagName === 'TEXTAREA') {
        input.addEventListener('input', (e) => {
          input.style.height = 'auto';
          input.style.height = Math.min(200, input.scrollHeight) + 'px';
        });
        // Initial resize
        input.style.height = 'auto';
        input.style.height = Math.min(200, input.scrollHeight) + 'px';
      }
    });
    
    // Config panel: Type select changes
    document.querySelectorAll('.config-type').forEach(select => {
      select.addEventListener('change', (e) => {
        const index = parseInt(select.dataset.index);
        const key = select.dataset.key;
        const type = select.value;
        const entry = select.closest('.config-entry');
        const valueInput = entry.querySelector('.config-value');
        
        // Re-parse current value with new type
        if (valueInput) {
          this.updateConfigParam(index, key, valueInput.value, type);
        }
        
        // Re-render to update the input type (e.g., boolean select)
        this.renderChain();
      });
      select.addEventListener('mousedown', (e) => e.stopPropagation());
      select.addEventListener('click', (e) => e.stopPropagation());
    });
  },
  
  /**
   * Setup general event listeners
   */
  setupEventListeners() {
    // Group toggle
    document.querySelectorAll('.recipe-group-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const group = header.closest('.recipe-group');
        group.classList.toggle('collapsed');
      });
    });
    
    // Search
    document.getElementById('recipe-search').addEventListener('input', (e) => {
      this.filterLibrary(e.target.value);
    });
    
    // View built-in source code buttons (using delegation)
    document.getElementById('builtin-recipes')?.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.recipe-item-view');
      if (viewBtn) {
        e.stopPropagation();
        const transformId = viewBtn.dataset.id;
        if (transformId && window.App) {
          App.viewBuiltinSource(transformId);
        }
      }
    });
    
    // View plugin source code buttons in dynamic categories (using delegation)
    document.getElementById('dynamic-plugin-categories')?.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.recipe-item-view');
      if (viewBtn) {
        e.stopPropagation();
        const pluginId = viewBtn.dataset.id;
        if (pluginId && window.App) {
          App.viewPluginSource(pluginId);
        }
      }
    });
    
    // Edit plugin buttons (using delegation)
    document.getElementById('user-recipes')?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.recipe-item-edit');
      if (editBtn) {
        e.stopPropagation();
        const pluginId = editBtn.dataset.id;
        if (pluginId && window.App) {
          App.editPlugin(pluginId);
        }
      }
    });
    
    // Edit inline script buttons (using delegation)
    document.getElementById('inline-recipes')?.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.recipe-item-edit');
      if (editBtn) {
        e.stopPropagation();
        const scriptId = editBtn.dataset.id;
        if (scriptId && window.App) {
          // Find the inline script and open editor
          const script = this.inlineScripts.find(s => s.id === scriptId);
          if (script) {
            App.openPluginEditor(script);
          }
        }
      }
      
      // Handle delete button for inline scripts
      const deleteBtn = e.target.closest('.recipe-item-delete');
      if (deleteBtn) {
        e.stopPropagation();
        const scriptId = deleteBtn.dataset.id;
        const scriptName = deleteBtn.dataset.name || 'this script';
        if (scriptId && window.App) {
          App.deletePluginFromLibrary(scriptId, scriptName, 'inline');
        }
      }
    });
    
    // Delete plugin buttons in dynamic categories (user plugins)
    document.getElementById('dynamic-plugin-categories')?.addEventListener('click', (e) => {
      const deleteBtn = e.target.closest('.recipe-item-delete');
      if (deleteBtn) {
        e.stopPropagation();
        const pluginId = deleteBtn.dataset.id;
        const pluginName = deleteBtn.dataset.name || 'this plugin';
        if (pluginId && window.App) {
          App.deletePluginFromLibrary(pluginId, pluginName, 'plugin');
        }
      }
    });
  },
  
  /**
   * Filter library items
   */
  filterLibrary(query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.recipe-item').forEach(item => {
      const name = item.querySelector('.recipe-item-name').textContent.toLowerCase();
      const matches = name.includes(q);
      item.style.display = matches ? '' : 'none';
    });
  },
  
  /**
   * Open config modal for a recipe
   */
  openConfigModal(index) {
    const item = this.chain[index];
    if (!item) return;
    
    // Find the original item to get config schema
    const original = this.findLibraryItem(item.id, item.type);
    const configSchema = original?.config || {};
    
    const body = document.getElementById('recipe-config-body');
    body.innerHTML = this.buildConfigForm(configSchema, item.config || {});
    body.dataset.index = index;
    
    App.openModal('modal-recipe-config');
  },
  
  /**
   * Build config form HTML
   */
  buildConfigForm(schema, values) {
    if (Object.keys(schema).length === 0) {
      return '<p class="text-muted">No configuration options available.</p>';
    }
    
    let html = '';
    for (const [key, def] of Object.entries(schema)) {
      const value = values[key] !== undefined ? values[key] : def.default;
      html += `<div class="form-group">`;
      html += `<label for="config-${key}">${key}</label>`;
      
      if (def.type === 'number') {
        html += `<input type="number" id="config-${key}" name="${key}" value="${value}"
                  ${def.min !== undefined ? `min="${def.min}"` : ''}
                  ${def.max !== undefined ? `max="${def.max}"` : ''}>`;
      } else if (def.type === 'select') {
        html += `<select id="config-${key}" name="${key}">`;
        for (const opt of def.options) {
          html += `<option value="${opt}" ${opt === value ? 'selected' : ''}>${opt}</option>`;
        }
        html += `</select>`;
      } else if (def.type === 'boolean') {
        html += `<input type="checkbox" id="config-${key}" name="${key}" ${value ? 'checked' : ''}>`;
      } else {
        html += `<input type="text" id="config-${key}" name="${key}" value="${value || ''}">`;
      }
      
      if (def.description) {
        html += `<div class="form-hint">${def.description}</div>`;
      }
      html += `</div>`;
    }
    
    return html;
  },
  
  /**
   * Apply config from modal
   */
  applyConfig() {
    const body = document.getElementById('recipe-config-body');
    const index = parseInt(body.dataset.index);
    const item = this.chain[index];
    if (!item) return;
    
    const form = body.querySelectorAll('input, select');
    const config = {};
    
    form.forEach(input => {
      if (input.type === 'checkbox') {
        config[input.name] = input.checked;
      } else if (input.type === 'number') {
        config[input.name] = parseFloat(input.value);
      } else {
        config[input.name] = input.value;
      }
    });
    
    item.config = config;
    App.closeModal('modal-recipe-config');
    this.dispatchChainChanged();
  },
  
  /**
   * Edit a chain item's code
   */
  editChainItem(index) {
    const item = this.chain[index];
    if (!item) return;
    
    // Store the chain index being edited
    this.editingChainIndex = index;
    this.editingLoopChildIndex = null;
    
    // Open plugin editor with the chain item's data
    App.openChainItemEditor(item, index);
  },
  
  /**
   * Edit a loop child's code
   */
  editLoopChild(loopIndex, childIndex) {
    const loop = this.chain[loopIndex];
    if (!loop || !loop.children || !loop.children[childIndex]) return;
    
    const child = loop.children[childIndex];
    
    // Store both indices for updating
    this.editingChainIndex = loopIndex;
    this.editingLoopChildIndex = childIndex;
    
    // Open plugin editor with the child item's data
    App.openChainItemEditor(child, loopIndex, childIndex);
  },
  
  /**
   * Update chain item after editing
   */
  updateChainItem(index, updates, childIndex = null) {
    let item;
    
    if (childIndex !== null) {
      // Updating a loop child
      const loop = this.chain[index];
      if (!loop || !loop.children || !loop.children[childIndex]) return;
      item = loop.children[childIndex];
    } else {
      // Updating a regular chain item
      item = this.chain[index];
    }
    
    if (!item) return;
    
    Object.assign(item, updates);
    item.status = ''; // Reset status since code changed
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Rename a card
   */
  renameCard(index) {
    const item = this.chain[index];
    if (!item) return;
    
    const newName = prompt('Enter new name:', item.name);
    if (newName && newName.trim() && newName.trim() !== item.name) {
      item.name = newName.trim();
      this.renderChain();
    }
  },

  /**
   * Duplicate a card
   */
  duplicateCard(index) {
    const item = this.chain[index];
    if (!item) return;
    
    let duplicate;
    if (item.type === 'loop') {
      // Deep clone loop with children
      duplicate = {
        ...item,
        iterations: item.iterations,
        children: (item.children || []).map(child => ({
          ...child,
          config: { ...child.config },
          status: ''
        })),
        status: ''
      };
    } else {
      duplicate = { ...item, config: { ...item.config }, status: '' };
    }
    
    this.chain.splice(index + 1, 0, duplicate);
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Remove a card
   */
  removeCard(index) {
    this.chain.splice(index, 1);
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Save a quick script from the chain as a plugin (opens save dialog)
   */
  saveQuickScriptAsPlugin(index) {
    const item = this.chain[index];
    if (!item || !item.code) return;
    
    // Store the code and index for the save dialog
    if (window.App) {
      App.pendingPluginCode = item.code;
      App.pendingQuickScriptIndex = index;
      App.populatePluginFolders();
      
      // Pre-fill name if available
      document.getElementById('save-plugin-name').value = item.name !== 'Quick Script' ? item.name : '';
      document.getElementById('save-plugin-description').value = item.description || '';
      document.getElementById('save-plugin-folder').value = '';
      document.getElementById('save-plugin-new-folder').value = '';
      
      App.openModal('modal-save-plugin');
    }
  },
  
  /**
   * Add inline script to library (or update existing)
   */
  async addInlineScript(script) {
    try {
      // Check if script with same ID already exists (for updates)
      const existingById = script.id && script.id.startsWith('script-') 
        ? this.inlineScripts.find(s => s.id === script.id)
        : null;
      
      if (existingById) {
        // Update existing script on server
        const result = await API.updateScript(script.id, {
          name: script.name,
          description: script.description || '',
          code: script.code,
          config: script.config || {}
        });
        // Reload from server
        await this.loadScripts();
      } else {
        // Check if name exists
        const existingByName = this.inlineScripts.find(s => s.name === script.name);
        if (existingByName) {
          // Update existing script on server
          const result = await API.updateScript(existingByName.id, {
            name: script.name,
            description: script.description || '',
            code: script.code,
            config: script.config || {}
          });
          await this.loadScripts();
        } else {
          // Create new script on server
          const result = await API.createScript({
            name: script.name,
            description: script.description || '',
            code: script.code,
            config: script.config || {}
          });
          await this.loadScripts();
        }
      }
      this.renderLibrary();
    } catch (error) {
      console.error('Failed to save script:', error);
      throw error;
    }
  },

  /**
   * Update an inline script by ID
   */
  async updateInlineScript(id, updates) {
    try {
      await API.updateScript(id, updates);
      await this.loadScripts();
      this.renderLibrary();
      return true;
    } catch (error) {
      console.error('Failed to update script:', error);
      return false;
    }
  },

  /**
   * Delete an inline script by ID
   */
  async deleteInlineScript(id) {
    try {
      console.log('[RecipeManager] Deleting script:', id);
      const deleteResult = await API.deleteScript(id);
      console.log('[RecipeManager] Delete API result:', deleteResult);
      await this.loadScripts();
      console.log('[RecipeManager] Scripts after reload:', this.inlineScripts.length);
      this.renderLibrary();
      return true;
    } catch (error) {
      console.error('Failed to delete script:', error);
      return false;
    }
  },

  /**
   * Clear chain
   */
  clearChain() {
    this.chain = [];
    this.currentStep = -1;
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Reset chain state
   */
  resetChain() {
    this.currentStep = -1;
    this.lastResults = {}; // Clear results for summary
    this.chain.forEach(item => {
      item.status = '';
      item.stats = null;
      // Reset loop children too
      if (item.type === 'loop' && item.children) {
        item.children.forEach(child => {
          child.status = '';
          child.stats = null;
        });
      }
    });
    this.renderChain();
  },
  
  /**
   * Flatten chain with loops into a linear recipe array for execution
   */
  flattenChainForExecution() {
    const flatRecipe = [];
    
    for (const item of this.chain) {
      if (item.type === 'loop') {
        if (item.enabled === false || !item.children || item.children.length === 0) {
          continue;
        }
        
        const loopIterations = item.iterations || 1;
        
        // Repeat the loop's children for each loop iteration
        for (let loopIter = 0; loopIter < loopIterations; loopIter++) {
          for (const child of item.children) {
            if (child.enabled === false) continue;
            
            const childIterations = child.iterations || 1;
            
            // Repeat each child for its iterations
            for (let childIter = 0; childIter < childIterations; childIter++) {
              flatRecipe.push({
                id: child.id,
                type: child.type,
                code: child.code,
                config: child.config,
                enabled: true,
                // Track source for status updates
                _loopSource: true,
                _loopIndex: this.chain.indexOf(item),
                _childIndex: item.children.indexOf(child)
              });
            }
          }
        }
      } else {
        if (item.enabled === false) continue;
        
        const itemIterations = item.iterations || 1;
        
        // Repeat each item for its iterations
        for (let iter = 0; iter < itemIterations; iter++) {
          flatRecipe.push({
            id: item.id,
            type: item.type,
            code: item.code,
            config: item.config,
            enabled: true,
            _chainIndex: this.chain.indexOf(item)
          });
        }
      }
    }
    
    return flatRecipe;
  },
  
  /**
   * Run a single chain item (used when adding new item to chain)
   * @param {string} code - The input code
   * @param {Object} item - The chain item to run
   * @param {number} index - The index of the item in the chain
   * @returns {Object} Result with code, success, etc.
   */
  async runSingleItem(code, item, index) {
    if (this.isRunning) {
      return { busy: true };
    }
    
    if (!item || !item.enabled) {
      return { skipped: true, code };
    }
    
    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      // Mark as active
      item.status = 'active';
      this.renderChain();
      
      // Handle loops
      if (item.type === 'loop') {
        let currentCode = code;
        const loopIterations = item.iterations || 1;
        
        for (let loopIter = 0; loopIter < loopIterations; loopIter++) {
          for (const child of (item.children || [])) {
            if (child.enabled === false) continue;
            
            const childIterations = child.iterations || 1;
            for (let childIter = 0; childIter < childIterations; childIter++) {
              const result = await API.runTransform(currentCode, {
                id: child.id,
                type: child.type,
                code: child.code
              });
              
              if (result.success) {
                currentCode = result.code;
              }
            }
          }
        }
        
        item.status = 'success';
        this.renderChain();
        
        return {
          success: true,
          code: currentCode,
          duration: Date.now() - startTime
        };
      }
      
      // Regular item - run with iterations
      let currentCode = code;
      const iterations = item.iterations || 1;
      
      for (let iter = 0; iter < iterations; iter++) {
        const result = await API.runTransform(currentCode, {
          id: item.id,
          type: item.type,
          code: item.code,
          config: item.config
        });
        
        if (!result.success) {
          item.status = 'error';
          this.renderChain();
          return {
            success: false,
            code: currentCode,
            error: result.error,
            duration: Date.now() - startTime
          };
        }
        
        currentCode = result.code;
      }
      
      item.status = 'success';
      this.currentStep = index; // Update current step for step-through mode
      this.renderChain();
      
      return {
        success: true,
        code: currentCode,
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      item.status = 'error';
      this.renderChain();
      return {
        success: false,
        code: code,
        error: error.message,
        duration: Date.now() - startTime
      };
    } finally {
      this.isRunning = false;
    }
  },
  
  /**
   * Run all transforms with progress indication
   * Uses batch endpoint for speed when possible
   */
  async runAll(code) {
    console.log('[RecipeManager.runAll] Called, isRunning:', this.isRunning, 'chain.length:', this.chain.length);
    if (this.isRunning || this.chain.length === 0) {
      console.log('[RecipeManager.runAll] Early return - isRunning:', this.isRunning, 'chain empty:', this.chain.length === 0);
      return { success: false, error: 'No transforms to run', results: [] };
    }
    
    this.isRunning = true;
    this.resetChain();
    
    const results = [];
    const startTime = Date.now();
    
    // Clear and initialize intermediate steps storage
    this.intermediateSteps = [];
    
    // Check if we can use fast batch mode (no loops, no complex iterations)
    const canUseBatch = this.chain.every(item => 
      item.type !== 'loop' && (item.iterations || 1) === 1
    );
    
    if (canUseBatch) {
      return this._runAllBatch(code, startTime);
    }
    
    // Fall back to sequential mode for complex recipes
    try {
      let currentCode = code;
      
      for (let chainIndex = 0; chainIndex < this.chain.length; chainIndex++) {
        const item = this.chain[chainIndex];
        const itemStartTime = Date.now();
        
        if (item.enabled === false) {
          results.push({
            index: chainIndex,
            transform: item.id,
            name: item.name,
            skipped: true,
            success: true,
            codeSize: this.getByteSize(currentCode)
          });
          continue;
        }
        
        if (item.type === 'loop') {
          // Handle loop execution with progress
          const loopIterations = item.iterations || 1;
          item.status = 'active';
          
          for (let loopIter = 0; loopIter < loopIterations; loopIter++) {
            item.currentIteration = loopIter + 1;
            this.renderChain();
            
            for (const child of (item.children || [])) {
              if (child.enabled === false) continue;
              
              const childIterations = child.iterations || 1;
              child.status = 'active';
              
              for (let childIter = 0; childIter < childIterations; childIter++) {
                child.currentIteration = childIter + 1;
                this.renderChain();
                
                const result = await API.runTransform(currentCode, {
                  id: child.id,
                  type: child.type,
                  code: child.code
                }, child.config);
                
                // Display logs from this transform
                if (result.logs && result.logs.length > 0) {
                  result.logs.forEach(logEntry => {
                    const msg = `[${child.name}] ${logEntry.args.join(' ')}`;
                    if (typeof App !== 'undefined' && App.log) {
                      App.log(msg, logEntry.type);
                    }
                  });
                }
                
                if (result.success) {
                  currentCode = result.code;
                } else {
                  child.status = 'error';
                  item.status = 'error';
                  this.renderChain();
                  results.push({
                    index: chainIndex,
                    transform: item.id,
                    name: item.name,
                    success: false,
                    error: result.error,
                    duration: Date.now() - itemStartTime,
                    codeSize: this.getByteSize(currentCode)
                  });
                  return { success: false, error: result.error, code: currentCode, results };
                }
              }
              
              child.currentIteration = 0;
              child.status = 'success';
            }
          }
          
          item.currentIteration = 0;
          item.status = 'success';
          results.push({
            index: chainIndex,
            transform: item.id,
            name: item.name,
            success: true,
            stats: item.stats || {},
            duration: Date.now() - itemStartTime,
            codeSize: this.getByteSize(currentCode)
          });
          
          // Store intermediate step for diffing
          this.intermediateSteps.push({
            index: chainIndex,
            name: item.name,
            code: currentCode,
            codeSize: this.getByteSize(currentCode)
          });
          
        } else {
          // Handle regular item with iterations
          const iterations = item.iterations || 1;
          item.status = 'active';
          
          for (let iter = 0; iter < iterations; iter++) {
            item.currentIteration = iter + 1;
            this.renderChain();
            
            const result = await API.runTransform(currentCode, {
              id: item.id,
              type: item.type,
              code: item.code
            }, item.config);
            
            // Display logs from this transform
            if (result.logs && result.logs.length > 0) {
              result.logs.forEach(logEntry => {
                const msg = `[${item.name}] ${logEntry.args.join(' ')}`;
                if (typeof App !== 'undefined' && App.log) {
                  App.log(msg, logEntry.type);
                }
              });
            }
            
            if (result.success) {
              currentCode = result.code;
              item.stats = result.stats;
            } else {
              item.status = 'error';
              this.renderChain();
              results.push({
                index: chainIndex,
                transform: item.id,
                name: item.name,
                success: false,
                error: result.error,
                duration: Date.now() - itemStartTime,
                codeSize: this.getByteSize(currentCode)
              });
              return { success: false, error: result.error, code: currentCode, results };
            }
          }
          
          item.currentIteration = 0;
          item.status = 'success';
          results.push({
            index: chainIndex,
            transform: item.id,
            name: item.name,
            success: true,
            stats: item.stats || {},
            duration: Date.now() - itemStartTime,
            codeSize: this.getByteSize(currentCode)
          });
          
          // Store intermediate step for diffing
          this.intermediateSteps.push({
            index: chainIndex,
            name: item.name,
            code: currentCode,
            codeSize: this.getByteSize(currentCode)
          });
        }
        
        this.currentStep = chainIndex;
        this.renderChain();
      }
      
      console.log('[RecipeManager] Intermediate steps stored:', this.intermediateSteps.length, this.intermediateSteps.map(s => s.name));
      
      return { success: true, code: currentCode, results };
    } finally {
      this.isRunning = false;
    }
  },
  
  /**
   * Fast batch execution using /run-chain endpoint
   * Parses once, runs all transforms on AST, generates once
   */
  async _runAllBatch(code, startTime) {
    try {
      // Build recipe array for server
      const recipe = this.chain.map(item => ({
        id: item.id,
        type: item.type,
        code: item.code,
        config: item.config || {},
        enabled: item.enabled !== false
      }));
      
      console.log('[RecipeManager._runAllBatch] Recipe:', recipe);
      
      // Mark all as pending (not active - that's misleading since we don't have streaming progress)
      this.chain.forEach(item => item.status = 'pending');
      this.renderChain();
      
      // Single API call for all transforms
      console.log('[RecipeManager._runAllBatch] Calling API.runChain...');
      const result = await API.runChain(code, recipe, false);
      console.log('[RecipeManager._runAllBatch] API result:', result);
      
      // Process results
      const results = [];
      if (result.success) {
        result.results.forEach((r, i) => {
          const item = this.chain[i];
          if (r.skipped) {
            item.status = 'skipped';
          } else if (r.success) {
            item.status = 'success';
            item.stats = r.stats || {};
          } else {
            item.status = 'error';
          }
          
          // Display logs from this transform
          if (r.logs && r.logs.length > 0) {
            r.logs.forEach(logEntry => {
              const msg = `[${item.name}] ${logEntry.args.join(' ')}`;
              if (typeof App !== 'undefined' && App.log) {
                App.log(msg, logEntry.type);
              }
            });
          }
          
          results.push({
            index: i,
            transform: item.id,
            name: item.name,
            success: r.success !== false,
            skipped: r.skipped,
            stats: r.stats || {},
            duration: r.duration || 0,
            codeSize: r.codeSize || (r.code ? this.getByteSize(r.code) : 0)
          });
          
          // Store intermediate step (code might be '[AST]' for middle steps)
          if (r.code && r.code !== '[AST]') {
            this.intermediateSteps.push({
              index: i,
              name: item.name,
              code: r.code,
              codeSize: this.getByteSize(r.code)
            });
          }
        });
        
        // Store final code as last step
        if (result.finalCode) {
          const lastItem = this.chain[this.chain.length - 1];
          if (!this.intermediateSteps.find(s => s.index === this.chain.length - 1)) {
            this.intermediateSteps.push({
              index: this.chain.length - 1,
              name: lastItem?.name || 'Final',
              code: result.finalCode,
              codeSize: this.getByteSize(result.finalCode)
            });
          }
        }
        
        this.currentStep = this.chain.length - 1;
        this.renderChain();
        
        console.log('[RecipeManager] Batch mode complete:', this.intermediateSteps.length, 'steps');
        return { success: true, code: result.finalCode, results };
      } else {
        // Handle error
        const failedIndex = result.failedAt || 0;
        this.chain.forEach((item, i) => {
          item.status = i < failedIndex ? 'success' : (i === failedIndex ? 'error' : 'pending');
        });
        this.renderChain();
        
        return { 
          success: false, 
          error: result.error, 
          code: result.currentCode || code, 
          results: result.results || []
        };
      }
    } finally {
      this.isRunning = false;
    }
  },
  
  /**
   * Run next step
   */
  async runStep(code) {
    if (this.isRunning) {
      return { busy: true };
    }
    
    if (this.chain.length === 0) {
      return { noRecipes: true };
    }
    
    const nextStep = this.currentStep + 1;
    if (nextStep >= this.chain.length) {
      return { complete: true };
    }
    
    this.isRunning = true;
    const startTime = Date.now();
    
    // Initialize lastResults if this is the first step
    if (this.currentStep === -1 || !this.lastResults.results) {
      this.lastResults = {
        results: [],
        success: true,
        duration: 0,
        inputSize: this.getByteSize(code),
        outputSize: this.getByteSize(code),
        error: null
      };
    }
    
    try {
      const item = this.chain[nextStep];
      
      // Mark as active
      item.status = 'active';
      this.renderChain();
      
      if (!item.enabled) {
        item.status = '';
        this.currentStep = nextStep;
        this.renderChain();
        
        // Record skipped step
        this.lastResults.results.push({
          index: nextStep,
          transform: item.id,
          name: item.name,
          skipped: true,
          success: true,
          codeSize: this.getByteSize(code)
        });
        
        return { skipped: true, code };
      }
      
      // Handle loops in step mode - run entire loop
      if (item.type === 'loop') {
        let currentCode = code;
        const loopIterations = item.iterations || 1;
        
        for (let loopIter = 0; loopIter < loopIterations; loopIter++) {
          for (const child of (item.children || [])) {
            if (child.enabled === false) continue;
            
            const childIterations = child.iterations || 1;
            for (let childIter = 0; childIter < childIterations; childIter++) {
              const result = await API.runTransform(currentCode, {
                id: child.id,
                type: child.type,
                code: child.code
              }, child.config);
              
              if (result.success) {
                currentCode = result.code;
                child.status = 'success';
              } else {
                child.status = 'error';
                item.status = 'error';
                this.renderChain();
                
                // Record failed step
                const duration = Date.now() - startTime;
                this.lastResults.results.push({
                  index: nextStep,
                  transform: item.id,
                  name: item.name,
                  success: false,
                  error: result.error,
                  duration,
                  codeSize: this.getByteSize(currentCode)
                });
                this.lastResults.success = false;
                this.lastResults.error = result.error;
                this.lastResults.duration += duration;
                
                return { success: false, error: result.error, code: currentCode };
              }
            }
          }
        }
        
        item.status = 'success';
        this.currentStep = nextStep;
        this.renderChain();
        
        // Record loop step success
        const duration = Date.now() - startTime;
        this.lastResults.results.push({
          index: nextStep,
          transform: item.id,
          name: item.name,
          success: true,
          stats: item.stats || {},
          duration,
          codeSize: this.getByteSize(currentCode)
        });
        this.lastResults.duration += duration;
        this.lastResults.outputSize = this.getByteSize(currentCode);
        
        return {
          success: true,
          code: currentCode,
          duration,
          complete: nextStep === this.chain.length - 1
        };
      }
      
      // Handle regular items with iterations
      let currentCode = code;
      const iterations = item.iterations || 1;
      
      for (let iter = 0; iter < iterations; iter++) {
        const result = await API.runTransform(currentCode, {
          id: item.id,
          type: item.type,
          code: item.code
        }, item.config);
        
        if (result.success) {
          currentCode = result.code;
          item.stats = result.stats;
        } else {
          item.status = 'error';
          this.renderChain();
          
          // Record failed step
          const duration = Date.now() - startTime;
          this.lastResults.results.push({
            index: nextStep,
            transform: item.id,
            name: item.name,
            success: false,
            error: result.error,
            duration,
            codeSize: this.getByteSize(currentCode)
          });
          this.lastResults.success = false;
          this.lastResults.error = result.error;
          this.lastResults.duration += duration;
          
          return { success: false, error: result.error, code: currentCode, duration };
        }
      }
      
      item.status = 'success';
      this.currentStep = nextStep;
      this.renderChain();
      
      // Record step success
      const duration = Date.now() - startTime;
      this.lastResults.results.push({
        index: nextStep,
        transform: item.id,
        name: item.name,
        success: true,
        stats: item.stats || {},
        duration,
        codeSize: this.getByteSize(currentCode)
      });
      this.lastResults.duration += duration;
      this.lastResults.outputSize = this.getByteSize(currentCode);
      
      return { 
        success: true, 
        code: currentCode, 
        stats: item.stats,
        duration,
        complete: nextStep === this.chain.length - 1
      };
    } finally {
      this.isRunning = false;
    }
  },
  
  /**
   * Get chain as serializable object
   */
  getChainData() {
    return this.chain.map(item => {
      const baseData = {
        id: item.id,
        type: item.type,
        name: item.name,
        code: item.code,
        config: item.config,
        configHints: item.configHints || {},
        description: item.description || '',
        exampleCode: item.exampleCode || '',
        enabled: item.enabled,
        iterations: item.iterations || 1
      };
      
      // Include children for loops
      if (item.type === 'loop' && item.children) {
        baseData.children = item.children.map(child => ({
          id: child.id,
          type: child.type,
          name: child.name,
          code: child.code,
          config: child.config,
          configHints: child.configHints || {},
          description: child.description || '',
          exampleCode: child.exampleCode || '',
          enabled: child.enabled,
          iterations: child.iterations || 1
        }));
      }
      
      return baseData;
    });
  },
  
  /**
   * Load chain from data
   */
  loadChainData(data) {
    this.chain = data.map(item => {
      // Re-parse configHints from code if not present (for older exports)
      let configHints = item.configHints || {};
      if (item.code && Object.keys(configHints).length === 0) {
        configHints = this.parseConfigComments(item.code);
      }
      
      // Auto-expand config panel if there are hints
      const hasExpectedParams = Object.keys(configHints).length > 0;
      
      const loadedItem = {
        ...item,
        configHints: configHints,
        configExpanded: hasExpectedParams,
        iterations: item.iterations || 1,
        status: '',
        stats: null
      };
      
      // Load children for loops
      if (item.type === 'loop' && item.children) {
        loadedItem.children = item.children.map(child => {
          // Re-parse configHints for children too
          let childConfigHints = child.configHints || {};
          if (child.code && Object.keys(childConfigHints).length === 0) {
            childConfigHints = this.parseConfigComments(child.code);
          }
          const hasChildParams = Object.keys(childConfigHints).length > 0;
          
          return {
            ...child,
            configHints: childConfigHints,
            configExpanded: hasChildParams,
            iterations: child.iterations || 1,
            status: '',
            stats: null
          };
        });
      }
      
      return loadedItem;
    });
    this.currentStep = -1;
    this.lastResults = {}; // Clear stale results
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Expand all chain cards
   */
  expandAllCards() {
    document.querySelectorAll('.recipe-card').forEach(card => {
      card.classList.remove('collapsed');
    });
  },
  
  /**
   * Collapse all chain cards
   */
  collapseAllCards() {
    document.querySelectorAll('.recipe-card').forEach(card => {
      card.classList.add('collapsed');
    });
  },
  
  /**
   * Enable all chain items
   */
  enableAll() {
    this.chain.forEach(item => {
      item.enabled = true;
    });
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Disable all chain items
   */
  disableAll() {
    this.chain.forEach(item => {
      item.enabled = false;
    });
    this.renderChain();
    this.dispatchChainChanged();
  },
  
  /**
   * Get summary data for the summary panel
   */
  getSummaryData() {
    return this.chain.map((item, index) => ({
      index: index + 1,
      name: item.name,
      type: item.type,
      enabled: item.enabled !== false,
      status: item.status || 'pending',
      stats: item.stats || null,
      description: item.description || '',
      config: item.config || {},
      hasIterations: item.id === 'constant-folding' // Transforms that support iterations
    }));
  },
  
  /**
   * Toggle enabled state for a chain item
   */
  toggleEnabled(index) {
    if (index >= 0 && index < this.chain.length) {
      this.chain[index].enabled = !this.chain[index].enabled;
      this.renderChain();
      this.dispatchChainChanged();
    }
  },
  
  /**
   * Set iterations for a chain item
   */
  setIterations(index, iterations) {
    if (index >= 0 && index < this.chain.length) {
      if (!this.chain[index].config) {
        this.chain[index].config = {};
      }
      this.chain[index].config.iterations = Math.max(1, Math.min(10, iterations));
      this.dispatchChainChanged();
    }
  },
  
  /**
   * Get iterations for a chain item
   */
  getIterations(index) {
    if (index >= 0 && index < this.chain.length) {
      return this.chain[index].config?.iterations || 3;
    }
    return 3;
  },
  
  /**
   * Dispatch chain changed event
   */
  dispatchChainChanged() {
    window.dispatchEvent(new CustomEvent('chain-changed', {
      detail: { chain: this.getChainData() }
    }));
  }
};

// Export
window.RecipeManager = RecipeManager;
