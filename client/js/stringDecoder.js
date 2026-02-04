/**
 * String Decoder Module - Decodes various string encoding formats
 */

const StringDecoder = {
  /**
   * Initialize string decoder
   */
  init() {
    this.setupEventListeners();
    this.setupEditorLineClick();
  },
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Decode button
    document.getElementById('btn-decode')?.addEventListener('click', () => {
      this.decode();
    });
    
    // Apply to selection button
    document.getElementById('btn-apply-decode')?.addEventListener('click', () => {
      this.applyToSelection();
    });
    
    // Copy output button
    document.getElementById('btn-copy-output')?.addEventListener('click', () => {
      this.copyOutput();
    });
    
    // Auto-decode on input change
    document.getElementById('decoder-input')?.addEventListener('input', () => {
      this.decode();
    });
    
    // Custom script change triggers decode
    document.getElementById('decoder-custom-script')?.addEventListener('input', () => {
      if (this.getDecodeType() === 'custom') {
        this.decode();
      }
    });
    
    // Decode type change
    document.querySelectorAll('input[name="decode-type"]').forEach(radio => {
      radio.addEventListener('change', () => {
        this.toggleCustomScript();
        this.decode();
      });
    });
  },
  
  /**
   * Setup click handler on editor lines to copy to decoder input
   */
  setupEditorLineClick() {
    // Listen for editor line clicks via Monaco
    // We'll use a custom event that EditorManager dispatches
    window.addEventListener('editor-line-clicked', (e) => {
      const { line, content, source } = e.detail;
      this.setInput(content);
    });
  },
  
  /**
   * Toggle custom script visibility
   */
  toggleCustomScript() {
    const type = this.getDecodeType();
    const customContainer = document.getElementById('decoder-custom-container');
    if (customContainer) {
      customContainer.style.display = type === 'custom' ? 'block' : 'none';
    }
  },
  
  /**
   * Get selected decode type
   */
  getDecodeType() {
    const selected = document.querySelector('input[name="decode-type"]:checked');
    return selected ? selected.value : 'hex';
  },
  
  /**
   * Decode the input
   */
  decode() {
    const input = document.getElementById('decoder-input')?.value || '';
    const output = document.getElementById('decoder-output');
    const type = this.getDecodeType();
    
    if (!input.trim()) {
      if (output) output.value = '';
      return;
    }
    
    try {
      let decoded;
      
      switch (type) {
        case 'hex':
          decoded = this.decodeHex(input);
          break;
        case 'unicode':
          decoded = this.decodeUnicode(input);
          break;
        case 'base64':
          decoded = this.decodeBase64(input);
          break;
        case 'url':
          decoded = this.decodeUrl(input);
          break;
        case 'rot13':
          decoded = this.decodeRot13(input);
          break;
        case 'eval':
          decoded = this.decodeEval(input);
          break;
        case 'custom':
          decoded = this.decodeCustom(input);
          break;
        default:
          decoded = input;
      }
      
      if (output) {
        output.value = decoded;
        output.style.color = '';
      }
    } catch (error) {
      if (output) {
        output.value = `Error: ${error.message}`;
        output.style.color = 'var(--accent-error)';
      }
    }
  },
  
  /**
   * Decode by evaluating as JavaScript expression
   */
  decodeEval(input) {
    try {
      // Safely evaluate the expression
      const result = eval(input);
      return String(result);
    } catch (e) {
      throw new Error(`Eval failed: ${e.message}`);
    }
  },
  
  /**
   * Decode using custom script
   */
  decodeCustom(input) {
    const script = document.getElementById('decoder-custom-script')?.value || '';
    
    if (!script.trim()) {
      return input;
    }
    
    try {
      // Create a function with 'input' as parameter
      const fn = new Function('input', script);
      const result = fn(input);
      return result !== undefined ? String(result) : '';
    } catch (e) {
      throw new Error(`Custom script error: ${e.message}`);
    }
  },
  
  /**
   * Copy output to clipboard
   */
  copyOutput() {
    const output = document.getElementById('decoder-output')?.value || '';
    if (output && !output.startsWith('Error:')) {
      navigator.clipboard.writeText(output).then(() => {
        App.log('Copied decoded output to clipboard', 'success');
      }).catch(err => {
        App.log('Failed to copy: ' + err.message, 'error');
      });
    }
  },
  
  /**
   * Decode hex escape sequences (\x41 -> A)
   */
  decodeHex(input) {
    // Handle \xNN format
    let result = input.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Handle 0xNN format (space separated)
    result = result.replace(/0x([0-9A-Fa-f]{2})\s*/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Handle plain hex without prefix (if it looks like hex)
    if (/^[0-9A-Fa-f\s]+$/.test(input)) {
      const hexOnly = input.replace(/\s/g, '');
      if (hexOnly.length % 2 === 0) {
        let decoded = '';
        for (let i = 0; i < hexOnly.length; i += 2) {
          decoded += String.fromCharCode(parseInt(hexOnly.substr(i, 2), 16));
        }
        return decoded;
      }
    }
    
    return result;
  },
  
  /**
   * Decode unicode escape sequences (\u0041 -> A)
   */
  decodeUnicode(input) {
    // Handle \uNNNN format
    let result = input.replace(/\\u([0-9A-Fa-f]{4})/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
    
    // Handle \u{NNNN} format (ES6)
    result = result.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (match, hex) => {
      return String.fromCodePoint(parseInt(hex, 16));
    });
    
    // Handle U+NNNN format
    result = result.replace(/U\+([0-9A-Fa-f]{4,6})/gi, (match, hex) => {
      return String.fromCodePoint(parseInt(hex, 16));
    });
    
    return result;
  },
  
  /**
   * Decode base64
   */
  decodeBase64(input) {
    try {
      // Remove whitespace
      const clean = input.replace(/\s/g, '');
      return atob(clean);
    } catch (e) {
      // Try URL-safe base64
      const urlSafe = input.replace(/-/g, '+').replace(/_/g, '/');
      const padded = urlSafe + '==='.slice(0, (4 - urlSafe.length % 4) % 4);
      return atob(padded);
    }
  },
  
  /**
   * Decode URL encoding (%41 -> A)
   */
  decodeUrl(input) {
    try {
      return decodeURIComponent(input);
    } catch (e) {
      // Try to decode what we can
      return input.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
      });
    }
  },
  
  /**
   * Decode ROT13
   */
  decodeRot13(input) {
    return input.replace(/[a-zA-Z]/g, (char) => {
      const base = char <= 'Z' ? 65 : 97;
      return String.fromCharCode((char.charCodeAt(0) - base + 13) % 26 + base);
    });
  },
  
  /**
   * Decode octal escape sequences (\101 -> A)
   */
  decodeOctal(input) {
    return input.replace(/\\([0-7]{1,3})/g, (match, octal) => {
      return String.fromCharCode(parseInt(octal, 8));
    });
  },
  
  /**
   * Apply decoded text to editor selection
   */
  applyToSelection() {
    const decoded = document.getElementById('decoder-output')?.value || '';
    if (decoded && !decoded.startsWith('Error:')) {
      EditorManager.replaceSelection(decoded, 'input');
    }
  },
  
  /**
   * Decode string and return result (API for other modules)
   */
  decodeString(input, type = 'auto') {
    if (type === 'auto') {
      type = this.detectEncoding(input);
    }
    
    switch (type) {
      case 'hex':
        return this.decodeHex(input);
      case 'unicode':
        return this.decodeUnicode(input);
      case 'base64':
        return this.decodeBase64(input);
      case 'url':
        return this.decodeUrl(input);
      case 'rot13':
        return this.decodeRot13(input);
      case 'octal':
        return this.decodeOctal(input);
      default:
        return input;
    }
  },
  
  /**
   * Detect encoding type
   */
  detectEncoding(input) {
    // Check for hex escapes
    if (/\\x[0-9A-Fa-f]{2}/.test(input)) {
      return 'hex';
    }
    
    // Check for unicode escapes
    if (/\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]+\}/.test(input)) {
      return 'unicode';
    }
    
    // Check for URL encoding
    if (/%[0-9A-Fa-f]{2}/.test(input)) {
      return 'url';
    }
    
    // Check for octal escapes
    if (/\\[0-7]{1,3}/.test(input)) {
      return 'octal';
    }
    
    // Check for base64
    if (/^[A-Za-z0-9+/=]+$/.test(input.replace(/\s/g, '')) && input.length > 10) {
      return 'base64';
    }
    
    // Default to hex for pure hex strings
    if (/^[0-9A-Fa-f\s]+$/.test(input)) {
      return 'hex';
    }
    
    return 'unknown';
  },
  
  /**
   * Batch decode strings in code
   */
  async batchDecode(code) {
    // Find all string literals with escape sequences
    const stringPattern = /(['"`])(?:\\.|[^\\])*?\1/g;
    let match;
    const replacements = [];
    
    while ((match = stringPattern.exec(code)) !== null) {
      const original = match[0];
      const inner = original.slice(1, -1);
      const quote = original[0];
      
      // Check if it has escape sequences
      if (/\\x|\\u|\\[0-7]/.test(inner)) {
        let decoded = this.decodeString(inner, 'auto');
        // Escape for string literal
        decoded = decoded.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), '\\' + quote);
        replacements.push({
          start: match.index,
          end: match.index + original.length,
          original,
          replacement: quote + decoded + quote
        });
      }
    }
    
    // Apply replacements from end to start
    let result = code;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
    }
    
    return {
      code: result,
      count: replacements.length
    };
  },
  
  /**
   * Set input from external source
   */
  setInput(text) {
    const input = document.getElementById('decoder-input');
    if (input) {
      input.value = text;
      this.decode();
    }
  },
  
  /**
   * Get decoded output
   */
  getOutput() {
    return document.getElementById('decoder-output')?.value || '';
  },
  
  /**
   * Clear decoder
   */
  clear() {
    const input = document.getElementById('decoder-input');
    const output = document.getElementById('decoder-output');
    if (input) input.value = '';
    if (output) output.value = '';
  }
};

// Export
window.StringDecoder = StringDecoder;
