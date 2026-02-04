/**
 * API Module - Handles all communication with the server
 * Includes Web Worker support for heavy operations and cancellation
 */

const API = {
  baseUrl: '/api',
  
  // Worker management
  _worker: null,
  _workerReady: false,
  _workerCallbacks: new Map(),
  _workerId: 0,
  
  // Cancellation
  _currentAbortController: null,
  
  /**
   * Initialize the Web Worker for heavy operations
   */
  initWorker() {
    if (this._worker) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
      try {
        this._worker = new Worker('/js/transformWorker.js');
        
        this._worker.onmessage = (e) => {
          const { id, type, payload } = e.data;
          
          if (type === 'ready') {
            this._workerReady = true;
            console.log('[API] Worker ready');
            resolve();
            return;
          }
          
          if (type === 'result') {
            const callback = this._workerCallbacks.get(id);
            if (callback) {
              this._workerCallbacks.delete(id);
              callback(payload);
            }
          }
        };
        
        this._worker.onerror = (err) => {
          console.error('[API] Worker error:', err);
          reject(err);
        };
        
        // Timeout for worker initialization
        setTimeout(() => {
          if (!this._workerReady) {
            console.warn('[API] Worker init timeout, falling back to server');
            resolve();
          }
        }, 5000);
        
      } catch (err) {
        console.warn('[API] Worker creation failed, using server fallback:', err);
        resolve();
      }
    });
  },
  
  /**
   * Send a message to the worker
   */
  _workerRequest(type, payload) {
    return new Promise((resolve) => {
      const id = ++this._workerId;
      this._workerCallbacks.set(id, resolve);
      this._worker.postMessage({ id, type, payload });
    });
  },
  
  /**
   * Cancel any ongoing operation
   */
  cancel() {
    if (this._currentAbortController) {
      this._currentAbortController.abort();
      this._currentAbortController = null;
    }
    // Clear pending worker callbacks
    this._workerCallbacks.clear();
  },
  
  /**
   * Check if an operation was cancelled
   */
  _checkCancelled() {
    if (this._currentAbortController?.signal.aborted) {
      throw new Error('Operation cancelled');
    }
  },
  
  /**
   * Make a fetch request with error handling and cancellation support
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[API] ${options.method || 'GET'} ${url}`);
    
    // Create new abort controller for this request
    this._currentAbortController = new AbortController();
    
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      signal: this._currentAbortController.signal,
      ...options
    };
    
    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }
    
    try {
      const response = await fetch(url, config);
      const data = await response.json();
      
      console.log(`[API] Response from ${endpoint}:`, { 
        ok: response.ok, 
        status: response.status,
        success: data.success,
        hasCode: !!data.code,
        hasFinalCode: !!data.finalCode,
        resultsCount: data.results?.length 
      });
      
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Operation cancelled');
      }
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    } finally {
      this._currentAbortController = null;
    }
  },
  
  // ==================== Transform API ====================
  
  /**
   * Check if code is too deeply nested (would cause stack overflow)
   */
  checkNestingDepth(code, maxDepth = 300) {
    let maxNesting = 0, currentNesting = 0;
    const len = Math.min(code.length, 100000);
    for (let i = 0; i < len; i++) {
      const c = code[i];
      if (c === '[' || c === '(' || c === '{') {
        currentNesting++;
        if (currentNesting > maxNesting) maxNesting = currentNesting;
        if (maxNesting > maxDepth) return maxNesting; // Early exit
      } else if (c === ']' || c === ')' || c === '}') {
        currentNesting--;
      }
    }
    return maxNesting;
  },
  
  /**
   * Parse code to AST
   */
  async parse(code) {
    // Check nesting depth to prevent stack overflow
    const nesting = this.checkNestingDepth(code);
    if (nesting > 300) {
      throw new Error(`Code is too deeply nested (${nesting} levels). This will cause a stack overflow. For JSFuck-style code, try running it in browser console first: console.log(eval(code))`);
    }
    
    return this.request('/transform/parse', {
      method: 'POST',
      body: { code }
    });
  },
  
  /**
   * Generate code from AST
   */
  async generate(ast) {
    return this.request('/transform/generate', {
      method: 'POST',
      body: { ast }
    });
  },
  
  /**
   * Run a single transform
   */
  async runTransform(code, transform, config = {}) {
    return this.request('/transform/run', {
      method: 'POST',
      body: { code, transform, config }
    });
  },
  
  /**
   * Run a recipe chain
   */
  async runChain(code, recipe, stepMode = false) {
    return this.request('/transform/run-chain', {
      method: 'POST',
      body: { code, recipe, stepMode }
    });
  },
  
  /**
   * Format code
   */
  async format(code) {
    return this.request('/transform/format', {
      method: 'POST',
      body: { code }
    });
  },
  
  /**
   * Analyze scope
   */
  async analyzeScope(code) {
    return this.request('/transform/analyze-scope', {
      method: 'POST',
      body: { code }
    });
  },
  
  /**
   * Get built-in transforms
   */
  async getBuiltins() {
    return this.request('/transform/builtins');
  },
  
  /**
   * Get source code of a built-in transform
   */
  async getBuiltinSource(id) {
    return this.request(`/transform/builtin-source/${id}`);
  },
  
  // ==================== Plugins API ====================
  
  /**
   * Get all plugins
   */
  async getPlugins() {
    return this.request('/plugins');
  },
  
  /**
   * Get single plugin
   */
  async getPlugin(id) {
    return this.request(`/plugins/${id}`);
  },
  
  /**
   * Create plugin
   */
  async createPlugin(plugin) {
    return this.request('/plugins', {
      method: 'POST',
      body: plugin
    });
  },
  
  /**
   * Update plugin
   */
  async updatePlugin(id, updates) {
    return this.request(`/plugins/${id}`, {
      method: 'PUT',
      body: updates
    });
  },
  
  /**
   * Delete plugin
   */
  async deletePlugin(id) {
    return this.request(`/plugins/${id}`, {
      method: 'DELETE'
    });
  },
  
  /**
   * Validate plugin code
   */
  async validatePlugin(code) {
    return this.request('/plugins/validate', {
      method: 'POST',
      body: { code }
    });
  },
  
  /**
   * Import plugin
   */
  async importPlugin(plugin) {
    return this.request('/plugins/import', {
      method: 'POST',
      body: { plugin }
    });
  },
  
  /**
   * Export plugin
   */
  async exportPlugin(id) {
    return this.request(`/plugins/${id}/export`);
  },
  
  // ==================== Scripts API ====================
  
  /**
   * Get all scripts
   */
  async getScripts() {
    return this.request('/scripts');
  },
  
  /**
   * Get single script
   */
  async getScript(id) {
    return this.request(`/scripts/${id}`);
  },
  
  /**
   * Create script
   */
  async createScript(script) {
    return this.request('/scripts', {
      method: 'POST',
      body: script
    });
  },
  
  /**
   * Update script
   */
  async updateScript(id, updates) {
    return this.request(`/scripts/${id}`, {
      method: 'PUT',
      body: updates
    });
  },
  
  /**
   * Delete script
   */
  async deleteScript(id) {
    return this.request(`/scripts/${id}`, {
      method: 'DELETE'
    });
  },
  
  // ==================== Projects API ====================
  
  /**
   * Get all projects
   */
  async getProjects() {
    return this.request('/projects');
  },
  
  /**
   * Get single project
   */
  async getProject(id) {
    return this.request(`/projects/${id}`);
  },
  
  /**
   * Create project
   */
  async createProject(project) {
    return this.request('/projects', {
      method: 'POST',
      body: project
    });
  },
  
  /**
   * Update project
   */
  async updateProject(id, updates) {
    return this.request(`/projects/${id}`, {
      method: 'PUT',
      body: updates
    });
  },
  
  /**
   * Delete project
   */
  async deleteProject(id) {
    return this.request(`/projects/${id}`, {
      method: 'DELETE'
    });
  },
  
  /**
   * Duplicate project
   */
  async duplicateProject(id) {
    return this.request(`/projects/${id}/duplicate`, {
      method: 'POST'
    });
  },
  
  /**
   * Export project
   */
  async exportProject(id) {
    return this.request(`/projects/${id}/export`);
  },
  
  /**
   * Import project
   */
  async importProject(project) {
    return this.request('/projects/import', {
      method: 'POST',
      body: { project }
    });
  }
};

// Export for use in other modules
window.API = API;
