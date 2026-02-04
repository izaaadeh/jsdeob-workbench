/**
 * Editor Module - Monaco Editor wrapper
 */

const EditorManager = {
  inputEditor: null,
  outputEditor: null,
  inlineEditor: null,
  pluginEditor: null,
  diffEditor: null,
  isDiffMode: false,
  diffType: 'initial', // 'initial' (input vs output) or 'step' (previous step vs current)
  diffStepIndex: 0, // Current step index for step-by-step diff (0 = input vs step 1, 1 = step 1 vs step 2, etc.)
  isEditMode: false,
  isLargeFileMode: false,
  isSimpleMode: false, // Use plain textarea instead of Monaco
  simpleInputEl: null,
  simpleOutputEl: null,
  _cachedOutput: '',
  history: [],
  historyIndex: -1,
  maxHistory: 50,
  inputLocked: false, // Input editor lock state
  outputLocked: true, // Output editor lock state (locked by default)
  
  // Large file thresholds
  LARGE_FILE_SIZE: 500 * 1024, // 500KB - enable perf mode
  SIMPLE_MODE_SIZE: 800 * 1024, // 800KB - switch to textarea
  LARGE_FILE_LINES: 10000,
  
  /**
   * Initialize Monaco Editor
   */
  async init() {
    return new Promise((resolve) => {
      require.config({ 
        paths: { 
          vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' 
        }
      });
      
      require(['vs/editor/editor.main'], () => {
        // Define custom theme
        monaco.editor.defineTheme('deob-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '6a6a6a', fontStyle: 'italic' },
            { token: 'keyword', foreground: '00d4aa' },
            { token: 'string', foreground: 'ffaa00' },
            { token: 'number', foreground: '0099ff' },
            { token: 'regexp', foreground: 'ff6b6b' },
            { token: 'type', foreground: '4ec9b0' },
            { token: 'function', foreground: 'dcdcaa' },
            { token: 'variable', foreground: '9cdcfe' },
            { token: 'constant', foreground: '4fc1ff' }
          ],
          colors: {
            'editor.background': '#0d0d0d',
            'editor.foreground': '#e4e4e4',
            'editor.lineHighlightBackground': '#1e1e1e',
            'editor.selectionBackground': '#264f78',
            'editor.inactiveSelectionBackground': '#3a3d41',
            'editorLineNumber.foreground': '#4a4a4a',
            'editorLineNumber.activeForeground': '#a0a0a0',
            'editorCursor.foreground': '#00d4aa',
            'editor.findMatchBackground': '#515c6a',
            'editor.findMatchHighlightBackground': '#3a3d41',
            'editorBracketMatch.background': '#0d0d0d',
            'editorBracketMatch.border': '#00d4aa',
            'editorGutter.background': '#0d0d0d',
            'scrollbarSlider.background': '#25252580',
            'scrollbarSlider.hoverBackground': '#333333',
            'scrollbarSlider.activeBackground': '#3d3d3d'
          }
        });
        
        // Register Babel API completions
        this.registerBabelCompletions();
        
        // Add JavaScript/TypeScript library type definitions
        this.addTypeDefinitions();
        
        // Create input editor
        this.inputEditor = monaco.editor.create(
          document.getElementById('input-editor'),
          this.getEditorOptions()
        );
        
        // Create output editor
        this.outputEditor = monaco.editor.create(
          document.getElementById('output-editor'),
          {
            ...this.getEditorOptions(),
            readOnly: true
          }
        );
        
        // Handle resize
        window.addEventListener('resize', () => this.layout());
        
        // Handle input changes
        this.inputEditor.onDidChangeModelContent(() => {
          window.dispatchEvent(new CustomEvent('input-changed', {
            detail: { code: this.inputEditor.getValue() }
          }));
        });
        
        // Handle cursor position for AST sync
        this.inputEditor.onDidChangeCursorPosition((e) => {
          window.dispatchEvent(new CustomEvent('cursor-changed', {
            detail: { 
              position: e.position,
              editor: 'input'
            }
          }));
        });
        
        // Handle focus for auto-switching AST tab
        this.inputEditor.onDidFocusEditorText(() => {
          window.dispatchEvent(new CustomEvent('editor-focused', {
            detail: { editor: 'input' }
          }));
        });
        
        // Handle cursor position for output AST sync
        this.outputEditor.onDidChangeCursorPosition((e) => {
          window.dispatchEvent(new CustomEvent('cursor-changed', {
            detail: { 
              position: e.position,
              editor: 'output'
            }
          }));
        });
        
        // Handle focus for auto-switching AST tab
        this.outputEditor.onDidFocusEditorText(() => {
          window.dispatchEvent(new CustomEvent('editor-focused', {
            detail: { editor: 'output' }
          }));
        });
        
        // Add editor actions/keybindings
        this.inputEditor.addAction({
          id: 'run-transforms',
          label: 'Run All Transforms',
          keybindings: [monaco.KeyCode.F5],
          run: () => {
            window.dispatchEvent(new CustomEvent('run-transforms'));
          }
        });
        
        this.inputEditor.addAction({
          id: 'run-step',
          label: 'Run Step',
          keybindings: [monaco.KeyCode.F6],
          run: () => {
            window.dispatchEvent(new CustomEvent('run-step'));
          }
        });
        
        this.inputEditor.addAction({
          id: 'apply-output',
          label: 'Apply Output to Input',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
          run: () => {
            window.dispatchEvent(new CustomEvent('apply-output'));
          }
        });
        
        // Add line click handlers for String Decoder integration
        // Ctrl+Click on a line copies it to the String Decoder input
        this.inputEditor.onMouseDown((e) => {
          if (e.event.ctrlKey && e.target.position) {
            const lineNumber = e.target.position.lineNumber;
            const model = this.inputEditor.getModel();
            if (model) {
              const lineContent = model.getLineContent(lineNumber);
              window.dispatchEvent(new CustomEvent('editor-line-clicked', {
                detail: { line: lineNumber, content: lineContent, source: 'input' }
              }));
            }
          }
        });
        
        this.outputEditor.onMouseDown((e) => {
          if (e.event.ctrlKey && e.target.position) {
            const lineNumber = e.target.position.lineNumber;
            const model = this.outputEditor.getModel();
            if (model) {
              const lineContent = model.getLineContent(lineNumber);
              window.dispatchEvent(new CustomEvent('editor-line-clicked', {
                detail: { line: lineNumber, content: lineContent, source: 'output' }
              }));
            }
          }
        });
        
        resolve();
      });
    });
  },
  
  /**
   * Enable simple textarea mode for very large files
   */
  enableSimpleMode(enabled) {
    if (this.isSimpleMode === enabled) return;
    
    this.isSimpleMode = enabled;
    
    const inputContainer = document.getElementById('input-editor');
    const outputContainer = document.getElementById('output-editor');
    
    if (enabled) {
      // Save current content
      const inputCode = this.getInput();
      const outputCode = this.getOutput();
      
      // Hide Monaco editors completely
      if (this.inputEditor) {
        const inputDom = this.inputEditor.getDomNode();
        if (inputDom) {
          inputDom.style.display = 'none';
          inputDom.style.visibility = 'hidden';
          inputDom.style.pointerEvents = 'none';
        }
      }
      if (this.outputEditor) {
        const outputDom = this.outputEditor.getDomNode();
        if (outputDom) {
          outputDom.style.display = 'none';
          outputDom.style.visibility = 'hidden';
          outputDom.style.pointerEvents = 'none';
        }
      }
      
      // Create simple textareas if not exist
      if (!this.simpleInputEl) {
        this.simpleInputEl = document.createElement('textarea');
        this.simpleInputEl.className = 'simple-editor';
        this.simpleInputEl.id = 'simple-input-editor';
        this.simpleInputEl.spellcheck = false;
        this.simpleInputEl.autocomplete = 'off';
        this.simpleInputEl.autocapitalize = 'off';
        this.simpleInputEl.placeholder = 'Paste large code here...';
        inputContainer.appendChild(this.simpleInputEl);
        
        // Dispatch input-changed events with debounce for large files
        let inputTimeout;
        this.simpleInputEl.addEventListener('input', () => {
          clearTimeout(inputTimeout);
          const code = this.simpleInputEl.value;
          const delay = code.length > 100000 ? 1000 : 300; // Longer delay for huge files
          inputTimeout = setTimeout(() => {
            window.dispatchEvent(new CustomEvent('input-changed', {
              detail: { code, isLarge: code.length > 100000 }
            }));
          }, delay);
        });
        
        // Cursor tracking for AST/Scope sync
        this.simpleInputEl.addEventListener('click', () => this.dispatchSimpleCursorChange('input'));
        this.simpleInputEl.addEventListener('keyup', (e) => {
          // Only on arrow keys and similar navigation
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            this.dispatchSimpleCursorChange('input');
          }
        });
        this.simpleInputEl.addEventListener('focus', () => {
          window.dispatchEvent(new CustomEvent('editor-focused', { detail: { editor: 'input' } }));
        });
      }
      
      if (!this.simpleOutputEl) {
        this.simpleOutputEl = document.createElement('textarea');
        this.simpleOutputEl.className = 'simple-editor';
        this.simpleOutputEl.id = 'simple-output-editor';
        this.simpleOutputEl.spellcheck = false;
        this.simpleOutputEl.readOnly = true;
        this.simpleOutputEl.placeholder = 'Output will appear here...';
        outputContainer.appendChild(this.simpleOutputEl);
        
        // Cursor tracking for AST/Scope sync
        this.simpleOutputEl.addEventListener('click', () => this.dispatchSimpleCursorChange('output'));
        this.simpleOutputEl.addEventListener('keyup', (e) => {
          if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            this.dispatchSimpleCursorChange('output');
          }
        });
        this.simpleOutputEl.addEventListener('focus', () => {
          window.dispatchEvent(new CustomEvent('editor-focused', { detail: { editor: 'output' } }));
        });
      }
      
      // Show textareas
      this.simpleInputEl.style.display = 'block';
      this.simpleOutputEl.style.display = 'block';
      
      // Set content
      this.simpleInputEl.value = inputCode;
      this.simpleOutputEl.value = outputCode;
      
      // Focus the simple input
      setTimeout(() => this.simpleInputEl.focus(), 50);
      
    } else {
      // Save textarea content
      const inputCode = this.simpleInputEl?.value || '';
      const outputCode = this.simpleOutputEl?.value || '';
      
      // Hide textareas
      if (this.simpleInputEl) this.simpleInputEl.style.display = 'none';
      if (this.simpleOutputEl) this.simpleOutputEl.style.display = 'none';
      
      // Show Monaco editors
      if (this.inputEditor) {
        const inputDom = this.inputEditor.getDomNode();
        if (inputDom) {
          inputDom.style.display = 'block';
          inputDom.style.visibility = 'visible';
          inputDom.style.pointerEvents = 'auto';
        }
        this.inputEditor.setValue(inputCode);
      }
      if (this.outputEditor) {
        const outputDom = this.outputEditor.getDomNode();
        if (outputDom) {
          outputDom.style.display = 'block';
          outputDom.style.visibility = 'visible';
          outputDom.style.pointerEvents = 'auto';
        }
        this.outputEditor.setValue(outputCode);
      }
      
      this.layout();
    }
    
    // Update UI toggle
    const checkbox = document.getElementById('simple-mode-checkbox');
    if (checkbox) checkbox.checked = enabled;
    
    // Dispatch event
    window.dispatchEvent(new CustomEvent('simple-mode', { detail: { enabled } }));
  },
  
  /**
   * Register Babel API completion provider
   */
  registerBabelCompletions() {
    monaco.languages.registerCompletionItemProvider('javascript', {
      triggerCharacters: ['.'],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };
        
        // Get text before cursor to detect context
        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.substring(0, position.column - 1);
        
        // Context: after "path."
        if (/\bpath\.$/.test(textBeforeCursor)) {
          return { suggestions: this.getPathDotCompletions(range) };
        }
        
        // Context: after "t." or "types."
        if (/\b(t|types)\.$/.test(textBeforeCursor)) {
          return { suggestions: this.getTDotCompletions(range) };
        }
        
        // Context: after ".scope."
        if (/\.scope\.$/.test(textBeforeCursor)) {
          return { suggestions: this.getScopeDotCompletions(range) };
        }
        
        // Context: after ".node."
        if (/\.node\.$/.test(textBeforeCursor)) {
          return { suggestions: this.getNodeDotCompletions(range) };
        }
        
        // Default: all suggestions
        const suggestions = [
          // Global functions
          {
            label: 'traverse',
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: 'traverse({\n\t${1:NodeType}(path) {\n\t\t$0\n\t}\n});',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Traverse the AST with a visitor object',
            range
          },
          
          // t (Babel types) methods
          ...this.getBabelTypeCompletions(range),
          
          // Common visitor node types
          ...this.getVisitorCompletions(range),
          
          // Path methods
          ...this.getPathCompletions(range),
          
          // Stats and console
          {
            label: 'stats',
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: 'stats',
            documentation: 'Object to store transform statistics',
            range
          },
          {
            label: 'config',
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: 'config',
            documentation: 'Configuration object passed to the transform',
            range
          },
          {
            label: 'ast',
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: 'ast',
            documentation: 'The parsed AST',
            range
          },
          {
            label: 't',
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: 't',
            documentation: 'Babel types - use t.isX() to check and t.x() to build nodes',
            range
          },
          {
            label: 'types',
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: 'types',
            documentation: 'Babel types (alias for t)',
            range
          },
          {
            label: 'console.log',
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: 'console.log(${1:message});',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Log a message to the console',
            range
          }
        ];
        
        return { suggestions };
      }
    });
  },
  
  /**
   * Completions for path.*
   */
  getPathDotCompletions(range) {
    return [
      { label: 'node', kind: monaco.languages.CompletionItemKind.Property, insertText: 'node', detail: 'The AST node', range },
      { label: 'parent', kind: monaco.languages.CompletionItemKind.Property, insertText: 'parent', detail: 'Parent AST node', range },
      { label: 'parentPath', kind: monaco.languages.CompletionItemKind.Property, insertText: 'parentPath', detail: 'Parent NodePath', range },
      { label: 'scope', kind: monaco.languages.CompletionItemKind.Property, insertText: 'scope', detail: 'Scope at this path', range },
      { label: 'type', kind: monaco.languages.CompletionItemKind.Property, insertText: 'type', detail: 'Node type string', range },
      { label: 'replaceWith', kind: monaco.languages.CompletionItemKind.Method, insertText: 'replaceWith(${1:node})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Replace with a node', range },
      { label: 'replaceWithMultiple', kind: monaco.languages.CompletionItemKind.Method, insertText: 'replaceWithMultiple([${1}])', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Replace with multiple nodes', range },
      { label: 'remove', kind: monaco.languages.CompletionItemKind.Method, insertText: 'remove()', detail: 'Remove this node', range },
      { label: 'insertBefore', kind: monaco.languages.CompletionItemKind.Method, insertText: 'insertBefore(${1:node})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Insert node before', range },
      { label: 'insertAfter', kind: monaco.languages.CompletionItemKind.Method, insertText: 'insertAfter(${1:node})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Insert node after', range },
      { label: 'get', kind: monaco.languages.CompletionItemKind.Method, insertText: "get('${1:key}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Get child path', range },
      { label: 'skip', kind: monaco.languages.CompletionItemKind.Method, insertText: 'skip()', detail: 'Skip children', range },
      { label: 'stop', kind: monaco.languages.CompletionItemKind.Method, insertText: 'stop()', detail: 'Stop traversal', range },
      { label: 'traverse', kind: monaco.languages.CompletionItemKind.Method, insertText: 'traverse({\n\t${1:Visitor}(p) {\n\t\t$0\n\t}\n})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Traverse children', range },
      { label: 'evaluate', kind: monaco.languages.CompletionItemKind.Method, insertText: 'evaluate()', detail: 'Evaluate if constant', range },
      { label: 'isIdentifier', kind: monaco.languages.CompletionItemKind.Method, insertText: 'isIdentifier()', detail: 'Check if Identifier', range },
      { label: 'isStringLiteral', kind: monaco.languages.CompletionItemKind.Method, insertText: 'isStringLiteral()', detail: 'Check if StringLiteral', range },
      { label: 'isNumericLiteral', kind: monaco.languages.CompletionItemKind.Method, insertText: 'isNumericLiteral()', detail: 'Check if NumericLiteral', range },
      { label: 'isMemberExpression', kind: monaco.languages.CompletionItemKind.Method, insertText: 'isMemberExpression()', detail: 'Check if MemberExpression', range },
      { label: 'isCallExpression', kind: monaco.languages.CompletionItemKind.Method, insertText: 'isCallExpression()', detail: 'Check if CallExpression', range },
    ];
  },
  
  /**
   * Completions for t.* or types.*
   */
  getTDotCompletions(range) {
    const validators = ['isIdentifier', 'isStringLiteral', 'isNumericLiteral', 'isBooleanLiteral', 'isNullLiteral', 'isLiteral', 'isMemberExpression', 'isCallExpression', 'isBinaryExpression', 'isUnaryExpression', 'isVariableDeclaration', 'isFunctionDeclaration', 'isIfStatement', 'isBlockStatement', 'isArrayExpression', 'isObjectExpression', 'isExpression', 'isStatement'];
    const builders = [
      { n: 'identifier', p: "('${1:name}')" },
      { n: 'stringLiteral', p: "('${1:value}')" },
      { n: 'numericLiteral', p: '(${1:value})' },
      { n: 'booleanLiteral', p: '(${1:true})' },
      { n: 'nullLiteral', p: '()' },
      { n: 'arrayExpression', p: '([${1}])' },
      { n: 'objectExpression', p: '([${1}])' },
      { n: 'memberExpression', p: '(${1:object}, ${2:property})' },
      { n: 'callExpression', p: '(${1:callee}, [${2:args}])' },
      { n: 'binaryExpression', p: "('${1:+}', ${2:left}, ${3:right})" },
      { n: 'variableDeclaration', p: "('${1:const}', [${2}])" },
      { n: 'variableDeclarator', p: '(${1:id}, ${2:init})' },
      { n: 'expressionStatement', p: '(${1:expr})' },
      { n: 'blockStatement', p: '([${1}])' },
      { n: 'returnStatement', p: '(${1})' },
      { n: 'cloneNode', p: '(${1:node})' },
    ];
    
    const suggestions = validators.map(v => ({
      label: v, kind: monaco.languages.CompletionItemKind.Method,
      insertText: `${v}(\${1:node})`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: `Check if node is ${v.slice(2)}`, range
    }));
    
    builders.forEach(b => suggestions.push({
      label: b.n, kind: monaco.languages.CompletionItemKind.Function,
      insertText: b.n + b.p, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: `Create ${b.n.charAt(0).toUpperCase() + b.n.slice(1)}`, range
    }));
    
    return suggestions;
  },
  
  /**
   * Completions for scope.*
   */
  getScopeDotCompletions(range) {
    return [
      { label: 'bindings', kind: monaco.languages.CompletionItemKind.Property, insertText: 'bindings', detail: 'All bindings', range },
      { label: 'hasBinding', kind: monaco.languages.CompletionItemKind.Method, insertText: "hasBinding('${1:name}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Check if binding exists', range },
      { label: 'getBinding', kind: monaco.languages.CompletionItemKind.Method, insertText: "getBinding('${1:name}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Get binding by name', range },
      { label: 'rename', kind: monaco.languages.CompletionItemKind.Method, insertText: "rename('${1:old}', '${2:new}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Rename binding', range },
      { label: 'generateUid', kind: monaco.languages.CompletionItemKind.Method, insertText: "generateUid('${1:name}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Generate unique name', range },
      { label: 'generateUidIdentifier', kind: monaco.languages.CompletionItemKind.Method, insertText: "generateUidIdentifier('${1:name}')", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: 'Generate unique Identifier', range },
    ];
  },
  
  /**
   * Completions for node properties (path.node.*)
   */
  getNodeDotCompletions(range) {
    const props = ['type', 'name', 'value', 'raw', 'operator', 'left', 'right', 'argument', 'arguments', 'callee', 'object', 'property', 'computed', 'body', 'params', 'init', 'id', 'declarations', 'kind', 'test', 'consequent', 'alternate', 'elements', 'properties', 'key', 'loc', 'start', 'end'];
    return props.map(p => ({
      label: p, kind: monaco.languages.CompletionItemKind.Property, insertText: p, range
    }));
  },
  
  /**
   * Get Babel types (t.*) completions
   */
  getBabelTypeCompletions(range) {
    const types = [
      // Checkers
      { name: 'isIdentifier', desc: 'Check if node is an Identifier', snippet: 't.isIdentifier(${1:node})' },
      { name: 'isStringLiteral', desc: 'Check if node is a StringLiteral', snippet: 't.isStringLiteral(${1:node})' },
      { name: 'isNumericLiteral', desc: 'Check if node is a NumericLiteral', snippet: 't.isNumericLiteral(${1:node})' },
      { name: 'isBooleanLiteral', desc: 'Check if node is a BooleanLiteral', snippet: 't.isBooleanLiteral(${1:node})' },
      { name: 'isNullLiteral', desc: 'Check if node is a NullLiteral', snippet: 't.isNullLiteral(${1:node})' },
      { name: 'isLiteral', desc: 'Check if node is any Literal', snippet: 't.isLiteral(${1:node})' },
      { name: 'isMemberExpression', desc: 'Check if node is a MemberExpression', snippet: 't.isMemberExpression(${1:node})' },
      { name: 'isCallExpression', desc: 'Check if node is a CallExpression', snippet: 't.isCallExpression(${1:node})' },
      { name: 'isBinaryExpression', desc: 'Check if node is a BinaryExpression', snippet: 't.isBinaryExpression(${1:node})' },
      { name: 'isUnaryExpression', desc: 'Check if node is a UnaryExpression', snippet: 't.isUnaryExpression(${1:node})' },
      { name: 'isVariableDeclaration', desc: 'Check if node is a VariableDeclaration', snippet: 't.isVariableDeclaration(${1:node})' },
      { name: 'isFunctionDeclaration', desc: 'Check if node is a FunctionDeclaration', snippet: 't.isFunctionDeclaration(${1:node})' },
      { name: 'isIfStatement', desc: 'Check if node is an IfStatement', snippet: 't.isIfStatement(${1:node})' },
      { name: 'isBlockStatement', desc: 'Check if node is a BlockStatement', snippet: 't.isBlockStatement(${1:node})' },
      { name: 'isArrayExpression', desc: 'Check if node is an ArrayExpression', snippet: 't.isArrayExpression(${1:node})' },
      { name: 'isObjectExpression', desc: 'Check if node is an ObjectExpression', snippet: 't.isObjectExpression(${1:node})' },
      
      // Builders
      { name: 'identifier', desc: 'Create an Identifier node', snippet: 't.identifier(${1:name})' },
      { name: 'stringLiteral', desc: 'Create a StringLiteral node', snippet: 't.stringLiteral(${1:value})' },
      { name: 'numericLiteral', desc: 'Create a NumericLiteral node', snippet: 't.numericLiteral(${1:value})' },
      { name: 'booleanLiteral', desc: 'Create a BooleanLiteral node', snippet: 't.booleanLiteral(${1:value})' },
      { name: 'nullLiteral', desc: 'Create a NullLiteral node', snippet: 't.nullLiteral()' },
      { name: 'arrayExpression', desc: 'Create an ArrayExpression node', snippet: 't.arrayExpression([${1:elements}])' },
      { name: 'objectExpression', desc: 'Create an ObjectExpression node', snippet: 't.objectExpression([${1:properties}])' },
      { name: 'callExpression', desc: 'Create a CallExpression node', snippet: 't.callExpression(${1:callee}, [${2:args}])' },
      { name: 'memberExpression', desc: 'Create a MemberExpression node', snippet: 't.memberExpression(${1:object}, ${2:property})' },
      { name: 'expressionStatement', desc: 'Create an ExpressionStatement node', snippet: 't.expressionStatement(${1:expression})' },
      { name: 'variableDeclaration', desc: 'Create a VariableDeclaration node', snippet: 't.variableDeclaration(${1|"const","let","var"|}, [${2:declarators}])' },
      { name: 'variableDeclarator', desc: 'Create a VariableDeclarator node', snippet: 't.variableDeclarator(${1:id}, ${2:init})' },
      { name: 'cloneNode', desc: 'Clone an AST node', snippet: 't.cloneNode(${1:node})' },
    ];
    
    return types.map(t => ({
      label: `t.${t.name}`,
      kind: monaco.languages.CompletionItemKind.Method,
      insertText: t.snippet,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: t.desc,
      range
    }));
  },
  
  /**
   * Get visitor node type completions
   */
  getVisitorCompletions(range) {
    const visitors = [
      'Identifier', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
      'RegExpLiteral', 'TemplateLiteral', 'MemberExpression', 'CallExpression',
      'NewExpression', 'BinaryExpression', 'UnaryExpression', 'LogicalExpression',
      'ConditionalExpression', 'AssignmentExpression', 'UpdateExpression',
      'VariableDeclaration', 'VariableDeclarator', 'FunctionDeclaration',
      'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration',
      'IfStatement', 'SwitchStatement', 'ForStatement', 'WhileStatement',
      'DoWhileStatement', 'ForInStatement', 'ForOfStatement', 'BlockStatement',
      'ReturnStatement', 'ThrowStatement', 'TryStatement', 'CatchClause',
      'ArrayExpression', 'ObjectExpression', 'ObjectProperty', 'ObjectMethod',
      'SpreadElement', 'SequenceExpression', 'Program', 'ExpressionStatement'
    ];
    
    return visitors.map(v => ({
      label: v,
      kind: monaco.languages.CompletionItemKind.Class,
      insertText: `${v}(path) {\n\t$0\n}`,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: `Visitor for ${v} nodes`,
      range
    }));
  },
  
  /**
   * Get path method completions
   */
  getPathCompletions(range) {
    const methods = [
      { name: 'path.node', desc: 'The AST node', snippet: 'path.node' },
      { name: 'path.parent', desc: 'The parent node', snippet: 'path.parent' },
      { name: 'path.parentPath', desc: 'The parent path', snippet: 'path.parentPath' },
      { name: 'path.scope', desc: 'The scope of this path', snippet: 'path.scope' },
      { name: 'path.replaceWith', desc: 'Replace this node with another', snippet: 'path.replaceWith(${1:node})' },
      { name: 'path.replaceWithMultiple', desc: 'Replace with multiple nodes', snippet: 'path.replaceWithMultiple([${1:nodes}])' },
      { name: 'path.remove', desc: 'Remove this node', snippet: 'path.remove()' },
      { name: 'path.insertBefore', desc: 'Insert nodes before this one', snippet: 'path.insertBefore(${1:node})' },
      { name: 'path.insertAfter', desc: 'Insert nodes after this one', snippet: 'path.insertAfter(${1:node})' },
      { name: 'path.skip', desc: 'Skip traversing children', snippet: 'path.skip()' },
      { name: 'path.stop', desc: 'Stop traversal entirely', snippet: 'path.stop()' },
      { name: 'path.traverse', desc: 'Traverse children with visitor', snippet: 'path.traverse(${1:visitor})' },
      { name: 'path.get', desc: 'Get a child path', snippet: "path.get('${1:key}')" },
      { name: 'path.isIdentifier', desc: 'Check if path is Identifier', snippet: 'path.isIdentifier()' },
      { name: 'path.isStringLiteral', desc: 'Check if path is StringLiteral', snippet: 'path.isStringLiteral()' },
      { name: 'path.evaluate', desc: 'Evaluate the node if possible', snippet: 'path.evaluate()' },
      { name: 'path.scope.getBinding', desc: 'Get a binding by name', snippet: "path.scope.getBinding('${1:name}')" },
      { name: 'path.scope.rename', desc: 'Rename a binding', snippet: "path.scope.rename('${1:oldName}', '${2:newName}')" },
    ];
    
    return methods.map(m => ({
      label: m.name,
      kind: monaco.languages.CompletionItemKind.Method,
      insertText: m.snippet,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: m.desc,
      range
    }));
  },
  
  /**
   * Add TypeScript definitions for better IntelliSense
   */
  addTypeDefinitions() {
    // Add extra JavaScript libraries for IntelliSense
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      noEmit: true,
      allowJs: true,
      checkJs: false
    });
    
    // Add Babel types definitions
    const babelTypeDefs = `
      declare function traverse(visitor: object): void;
      declare const ast: object;
      declare const config: object;
      declare const stats: { [key: string]: any };
      
      declare namespace t {
        function isIdentifier(node: any, opts?: object): boolean;
        function isStringLiteral(node: any, opts?: object): boolean;
        function isNumericLiteral(node: any, opts?: object): boolean;
        function isBooleanLiteral(node: any, opts?: object): boolean;
        function isNullLiteral(node: any): boolean;
        function isLiteral(node: any): boolean;
        function isMemberExpression(node: any, opts?: object): boolean;
        function isCallExpression(node: any, opts?: object): boolean;
        function isBinaryExpression(node: any, opts?: object): boolean;
        function isUnaryExpression(node: any, opts?: object): boolean;
        function isVariableDeclaration(node: any, opts?: object): boolean;
        function isVariableDeclarator(node: any, opts?: object): boolean;
        function isFunctionDeclaration(node: any, opts?: object): boolean;
        function isIfStatement(node: any, opts?: object): boolean;
        function isBlockStatement(node: any, opts?: object): boolean;
        function isArrayExpression(node: any, opts?: object): boolean;
        function isObjectExpression(node: any, opts?: object): boolean;
        
        function identifier(name: string): object;
        function stringLiteral(value: string): object;
        function numericLiteral(value: number): object;
        function booleanLiteral(value: boolean): object;
        function nullLiteral(): object;
        function arrayExpression(elements?: any[]): object;
        function objectExpression(properties?: any[]): object;
        function callExpression(callee: object, args: any[]): object;
        function memberExpression(object: object, property: object, computed?: boolean): object;
        function expressionStatement(expression: object): object;
        function variableDeclaration(kind: "var" | "let" | "const", declarations: any[]): object;
        function variableDeclarator(id: object, init?: object): object;
        function cloneNode(node: object, deep?: boolean): object;
      }
      
      declare const types: typeof t;
    `;
    
    monaco.languages.typescript.javascriptDefaults.addExtraLib(babelTypeDefs, 'babel-types.d.ts');
  },
  
  /**
   * Get default editor options
   */
  getEditorOptions() {
    return {
      language: 'javascript',
      theme: 'deob-dark',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontLigatures: true,
      minimap: { enabled: true, maxColumn: 80 },
      scrollBeyondLastLine: false,
      automaticLayout: false,
      tabSize: 2,
      wordWrap: 'on',
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      selectOnLineNumbers: true,
      roundedSelection: false,
      cursorStyle: 'line',
      cursorBlinking: 'smooth',
      smoothScrolling: true,
      mouseWheelZoom: true,
      bracketPairColorization: { enabled: true },
      guides: {
        bracketPairs: true,
        indentation: true
      },
      folding: true,
      foldingStrategy: 'indentation',
      showFoldingControls: 'mouseover',
      matchBrackets: 'always',
      renderWhitespace: 'selection',
      // Enable autocomplete
      quickSuggestions: {
        other: true,
        comments: false,
        strings: true
      },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      tabCompletion: 'on',
      wordBasedSuggestions: 'currentDocument',
      parameterHints: { enabled: true },
      suggest: {
        showKeywords: true,
        showSnippets: true,
        showClasses: true,
        showFunctions: true,
        showVariables: true,
        showModules: true,
        showProperties: true,
        showMethods: true,
        showConstants: true,
        insertMode: 'insert',
        filterGraceful: true,
        snippetsPreventQuickSuggestions: false
      }
    };
  },
  
  /**
   * Get input code
   */
  getInput() {
    if (this.isSimpleMode && this.simpleInputEl) {
      return this.simpleInputEl.value || '';
    }
    return this.inputEditor?.getValue() || '';
  },
  
  /**
   * Set input code - optimized for large content
   */
  setInput(code) {
    // Check file size first
    const fileSize = new Blob([code]).size;
    
    // Auto-switch to simple mode for very large files
    if (fileSize > this.SIMPLE_MODE_SIZE && !this.isSimpleMode) {
      console.log('Very large file detected - switching to simple editor mode');
      this.enableSimpleMode(true);
    }
    
    if (this.isSimpleMode && this.simpleInputEl) {
      this.simpleInputEl.value = code;
      return;
    }
    
    if (this.inputEditor) {
      // Check if this is a large file for perf mode
      const isLarge = this.isLargeFile(code);
      const isExtremeLarge = fileSize > 1024 * 1024; // > 1MB
      
      if (isExtremeLarge && !this.isLargeFileMode) {
        this.enableLargeFileMode(true, true); // Enable with syntax disabled
        console.log('Extremely large file detected - disabling syntax highlighting');
      } else if (isLarge && !this.isLargeFileMode) {
        this.enableLargeFileMode(true, false);
        console.log('Large file detected - enabling performance mode');
      }
      
      // For large files, use batch edit operation for better performance
      const model = this.inputEditor.getModel();
      if (model && code.length > 100000) {
        // Use pushEditOperations for large files - more efficient than setValue
        model.pushEditOperations(
          [],
          [{
            range: model.getFullModelRange(),
            text: code
          }],
          () => null
        );
      } else {
        this.inputEditor.setValue(code);
      }
    }
  },
  
  /**
   * Check if code qualifies as a large file
   */
  isLargeFile(code) {
    if (!code) return false;
    const size = new Blob([code]).size;
    const lines = code.split('\n').length;
    return size > this.LARGE_FILE_SIZE || lines > this.LARGE_FILE_LINES;
  },
  
  /**
   * Enable/disable large file mode for performance
   */
  enableLargeFileMode(enabled, disableSyntax = false) {
    this.isLargeFileMode = enabled;
    
    const performanceOptions = enabled ? {
      // Disable expensive features
      minimap: { enabled: false },
      folding: false,
      foldingStrategy: 'manual',
      showFoldingControls: 'never',
      renderLineHighlight: 'none',
      matchBrackets: 'never',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      renderWhitespace: 'none',
      guides: { indentation: false, bracketPairs: false },
      bracketPairColorization: { enabled: false },
      colorDecorators: false,
      links: false,
      hover: { enabled: false },
      quickSuggestions: false,
      parameterHints: { enabled: false },
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
    } : {
      // Restore normal options
      minimap: { enabled: true, maxColumn: 80 },
      folding: true,
      foldingStrategy: 'indentation',
      showFoldingControls: 'mouseover',
      renderLineHighlight: 'line',
      matchBrackets: 'always',
      occurrencesHighlight: 'singleFile',
      selectionHighlight: true,
      renderWhitespace: 'selection',
      guides: { indentation: true, bracketPairs: true },
      bracketPairColorization: { enabled: true },
      colorDecorators: true,
      links: true,
      hover: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      parameterHints: { enabled: true },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'currentDocument',
    };
    
    if (this.inputEditor) {
      this.inputEditor.updateOptions(performanceOptions);
      
      // Completely disable syntax highlighting for extreme cases
      if (enabled && disableSyntax) {
        monaco.editor.setModelLanguage(this.inputEditor.getModel(), 'plaintext');
      } else if (!enabled) {
        monaco.editor.setModelLanguage(this.inputEditor.getModel(), 'javascript');
      }
    }
    if (this.outputEditor) {
      this.outputEditor.updateOptions(performanceOptions);
      
      if (enabled && disableSyntax) {
        monaco.editor.setModelLanguage(this.outputEditor.getModel(), 'plaintext');
      } else if (!enabled) {
        monaco.editor.setModelLanguage(this.outputEditor.getModel(), 'javascript');
      }
    }
    
    // Dispatch event for logging (internal use)
    window.dispatchEvent(new CustomEvent('large-file-mode', { detail: { enabled, disableSyntax } }));
  },
  
  /**
   * Focus the input editor
   */
  focusInput() {
    if (this.isSimpleMode && this.simpleInputEl) {
      this.simpleInputEl.focus();
      return true;
    }
    
    if (this.inputEditor) {
      this.inputEditor.focus();
      return true;
    }
    return false;
  },
  
  /**
   * Focus the output editor
   */
  focusOutput() {
    if (this.isSimpleMode && this.simpleOutputEl) {
      this.simpleOutputEl.focus();
      return true;
    }
    if (this.outputEditor && !this.isDiffMode) {
      this.outputEditor.focus();
      return true;
    }
    return false;
  },
  
  /**
   * Dispatch cursor change event from simple textarea
   * Converts character position to line/column for AST/Scope sync
   */
  dispatchSimpleCursorChange(editor) {
    const textarea = editor === 'input' ? this.simpleInputEl : this.simpleOutputEl;
    if (!textarea) return;
    
    const text = textarea.value;
    const cursorPos = textarea.selectionStart;
    
    // Convert character position to line/column
    const textUpToCursor = text.substring(0, cursorPos);
    const lines = textUpToCursor.split('\n');
    const lineNumber = lines.length;
    const column = lines[lines.length - 1].length + 1; // Monaco uses 1-based columns
    
    window.dispatchEvent(new CustomEvent('cursor-changed', {
      detail: {
        position: { lineNumber, column },
        editor
      }
    }));
  },
  
  /**
   * Get output code
   */
  getOutput() {
    // If in diff mode, return cached output
    if (this.isDiffMode) {
      return this._cachedOutput || '';
    }
    if (this.isSimpleMode && this.simpleOutputEl) {
      return this.simpleOutputEl.value || '';
    }
    return this.outputEditor?.getValue() || '';
  },
  
  /**
   * Set output code - optimized for large content
   */
  setOutput(code) {
    // Always cache the output
    this._cachedOutput = code;
    
    if (this.isSimpleMode && this.simpleOutputEl) {
      this.simpleOutputEl.value = code;
      return;
    }
    
    if (this.isDiffMode && this.diffEditor) {
      // Update the diff view with new output
      const inputCode = this.getInput();
      this.diffEditor.setModel({
        original: monaco.editor.createModel(inputCode, 'javascript'),
        modified: monaco.editor.createModel(code, 'javascript')
      });
    } else if (this.outputEditor) {
      // For large files, use batch edit operation for better performance
      const model = this.outputEditor.getModel();
      if (model && code.length > 100000) {
        // Use pushEditOperations for large files - more efficient than setValue
        model.pushEditOperations(
          [],
          [{
            range: model.getFullModelRange(),
            text: code
          }],
          () => null
        );
      } else {
        this.outputEditor.setValue(code);
      }
    }
    
    // Dispatch output changed event for project tracking
    window.dispatchEvent(new CustomEvent('output-changed', {
      detail: { code }
    }));
  },
  
  /**
   * Clear input
   */
  clearInput() {
    this.setInput('');
    // Also clear AST viewer
    if (window.ASTViewer) {
      ASTViewer.clear();
    }
  },
  
  /**
   * Clear output
   */
  clearOutput() {
    this._cachedOutput = '';
    this.setOutput('');
  },
  
  /**
   * Use output as input
   */
  useOutputAsInput() {
    const output = this.getOutput();
    if (output) {
      this.pushHistory(); // Save current state
      this.setInput(output);
      this.clearOutput();
    }
  },
  
  /**
   * Swap input and output
   */
  swapInputOutput() {
    const input = this.getInput();
    const output = this.getOutput();
    if (input || output) {
      this.pushHistory();
      this.setInput(output);
      this.setOutput(input);
    }
  },
  
  /**
   * Toggle edit mode (legacy - now just toggles output lock)
   */
  toggleEditMode() {
    // Edit mode is now handled by the lock button
    // This function is kept for backwards compatibility
    return this.toggleOutputLock();
  },
  
  /**
   * Push current state to history
   */
  pushHistory() {
    const state = {
      input: this.getInput(),
      output: this.getOutput(),
      timestamp: Date.now()
    };
    
    // Remove any forward history if we're not at the end
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }
    
    this.history.push(state);
    
    // Limit history size
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  },
  
  /**
   * Undo to previous state
   */
  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const state = this.history[this.historyIndex];
      this.setInput(state.input);
      this.setOutput(state.output);
      this.updateHistoryButtons();
      return true;
    }
    return false;
  },
  
  /**
   * Redo to next state
   */
  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      const state = this.history[this.historyIndex];
      this.setInput(state.input);
      this.setOutput(state.output);
      this.updateHistoryButtons();
      return true;
    }
    return false;
  },
  
  /**
   * Update history button states
   */
  updateHistoryButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    
    if (undoBtn) {
      undoBtn.disabled = this.historyIndex <= 0;
      undoBtn.classList.toggle('disabled', this.historyIndex <= 0);
    }
    if (redoBtn) {
      redoBtn.disabled = this.historyIndex >= this.history.length - 1;
      redoBtn.classList.toggle('disabled', this.historyIndex >= this.history.length - 1);
    }
  },
  
  /**
   * Toggle diff view
   * @param {string} type - 'initial' (input vs output) or 'step' (previous step vs current)
   */
  toggleDiff(type = 'initial') {
    const container = document.getElementById('output-editor');
    
    if (this.isDiffMode) {
      // If clicking the same diff type, turn off. If different type, switch to that type.
      if (this.diffType === type) {
        // Switch back to normal editor - restore cached output
        if (this.diffEditor) {
          this.diffEditor.dispose();
          this.diffEditor = null;
        }
        container.innerHTML = '';
        this.outputEditor = monaco.editor.create(container, {
          ...this.getEditorOptions(),
          readOnly: !this.isEditMode,
          value: this._cachedOutput || ''
        });
        this.isDiffMode = false;
        this.diffType = 'initial';
        this.diffStepIndex = 0;
        
        // Hide step navigation
        const stepNav = document.getElementById('diff-step-nav');
        if (stepNav) stepNav.style.display = 'none';
        
        // Notify AST viewer to exit diff mode
        if (typeof ASTViewer !== 'undefined') {
          ASTViewer.setDiffMode(false);
        }
        
        // Update diff button states
        document.getElementById('btn-toggle-diff')?.classList.remove('active');
        document.getElementById('btn-diff-step')?.classList.remove('active');
        
        this.layout();
        return;
      } else {
        // Switch to different diff type - just update the model
        this.diffType = type;
        // Reset step index when switching to step mode
        if (type === 'step') {
          this.diffStepIndex = 0;
        }
        this._updateDiffContent();
        
        // Update button states
        document.getElementById('btn-toggle-diff')?.classList.toggle('active', type === 'initial');
        document.getElementById('btn-diff-step')?.classList.toggle('active', type === 'step');
        return;
      }
    }
    
    // Switch to diff view - cache output first
    const outputCode = this.getOutput();
    this._cachedOutput = outputCode; // Cache before disposing
    
    this.outputEditor.dispose();
    container.innerHTML = '';
    
    // Get diff mode from settings (default: side-by-side)
    const diffMode = localStorage.getItem('diffMode') || 'sideBySide';
    
    this.diffEditor = monaco.editor.createDiffEditor(container, {
      ...this.getEditorOptions(),
      readOnly: true,
      enableSplitViewResizing: true,
      renderSideBySide: diffMode === 'sideBySide',
      useInlineViewWhenSpaceIsLimited: false
    });
    
    this.isDiffMode = true;
    this.diffType = type;
    // Reset step index when entering step mode
    if (type === 'step') {
      this.diffStepIndex = 0;
    }
    this._updateDiffContent();
    
    // Update diff button states
    document.getElementById('btn-toggle-diff')?.classList.toggle('active', type === 'initial');
    document.getElementById('btn-diff-step')?.classList.toggle('active', type === 'step');
    
    this.layout();
  },

  /**
   * Update the diff editor content based on current diff type
   */
  _updateDiffContent() {
    if (!this.diffEditor) return;
    
    // Simple diff: formatted input vs final output
    const originalCode = RecipeManager.formattedInputCode || this.getInput();
    const modifiedCode = this.getOutput();
    
    this.diffEditor.setModel({
      original: monaco.editor.createModel(originalCode, 'javascript'),
      modified: monaco.editor.createModel(modifiedCode, 'javascript')
    });
    
    // Notify AST viewer to enter diff mode with both codes
    if (typeof ASTViewer !== 'undefined') {
      ASTViewer.setDiffMode(true, originalCode, modifiedCode);
    }
  },
  
  /**
   * Update the step diff navigation UI
   */
  _updateStepDiffUI(totalSteps) {
    const stepNav = document.getElementById('diff-step-nav');
    if (!stepNav) return;
    
    if (this.diffType !== 'step' || totalSteps <= 1) {
      stepNav.style.display = 'none';
      return;
    }
    
    stepNav.style.display = 'flex';
    
    const prevBtn = document.getElementById('diff-step-prev');
    const nextBtn = document.getElementById('diff-step-next');
    const label = document.getElementById('diff-step-label');
    
    if (prevBtn) prevBtn.disabled = this.diffStepIndex <= 0;
    if (nextBtn) nextBtn.disabled = this.diffStepIndex >= totalSteps - 1;
    if (label) label.textContent = `Step ${this.diffStepIndex + 1} / ${totalSteps}`;
  },
  
  /**
   * Navigate to previous step diff
   */
  prevStepDiff() {
    console.log('[Diff Nav] prevStepDiff called, current index:', this.diffStepIndex);
    if (this.diffStepIndex > 0) {
      this.diffStepIndex--;
      console.log('[Diff Nav] New index:', this.diffStepIndex);
      this._updateDiffContent();
    }
  },
  
  /**
   * Navigate to next step diff
   */
  nextStepDiff() {
    const steps = RecipeManager.intermediateSteps || [];
    const totalSteps = steps.length;
    console.log('[Diff Nav] nextStepDiff called, current index:', this.diffStepIndex, 'totalSteps:', totalSteps);
    if (this.diffStepIndex < totalSteps - 1) {
      this.diffStepIndex++;
      console.log('[Diff Nav] New index:', this.diffStepIndex);
      this._updateDiffContent();
    }
  },
  
  /**
   * Update diff view if active
   */
  updateDiff() {
    if (this.isDiffMode && this.diffEditor) {
      this._updateDiffContent();
    }
  },
  
  /**
   * Create Quick Script editor (for temporary one-time transforms)
   */
  createQuickScriptEditor(containerId) {
    if (this.quickScriptEditor) {
      this.quickScriptEditor.dispose();
    }
    
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    this.quickScriptEditor = monaco.editor.create(container, {
      ...this.getEditorOptions(),
      language: 'javascript',
      value: this.getQuickScriptTemplate(),
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true
    });
    
    return this.quickScriptEditor;
  },
  
  /**
   * Get Quick Script editor value
   */
  getQuickScriptCode() {
    return this.quickScriptEditor?.getValue() || '';
  },
  
  /**
   * Get a minimal template for quick scripts (no config header)
   */
  getQuickScriptTemplate() {
    return `// Quick Script - One-time use, not saved
// Use traverse(visitor) to modify the AST
// Access 't' for Babel types, 'config' for options
//
// CONFIG PARAMETERS:
// - removeConsole: Remove console calls - Boolean (default: true)

const removeConsole = config.removeConsole !== false;

traverse({
  // Example: Remove all console.log calls
  CallExpression(path) {
    if (!removeConsole) return;
    const callee = path.node.callee;
    if (t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object, { name: 'console' })) {
      path.remove();
    }
  }
});
`;
  },
  
  /**
   * Create inline editor for transforms
   */
  createInlineEditor(containerId) {
    if (this.inlineEditor) {
      this.inlineEditor.dispose();
    }
    
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    this.inlineEditor = monaco.editor.create(container, {
      ...this.getEditorOptions(),
      language: 'javascript',
      value: this.getDefaultTransformCode(),
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true
    });
    
    return this.inlineEditor;
  },
  
  /**
   * Get inline editor value
   */
  getInlineCode() {
    return this.inlineEditor?.getValue() || '';
  },
  
  /**
   * Set inline editor value
   */
  setInlineCode(code) {
    if (this.inlineEditor) {
      this.inlineEditor.setValue(code);
    }
  },
  
  /**
   * Create plugin editor for editing plugins
   */
  createPluginEditor(containerId) {
    if (this.pluginEditor) {
      this.pluginEditor.dispose();
    }
    
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    this.pluginEditor = monaco.editor.create(container, {
      ...this.getEditorOptions(),
      language: 'javascript',
      value: this.getDefaultTransformCode(),
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true
    });
    
    return this.pluginEditor;
  },
  
  /**
   * Get plugin editor value
   */
  getPluginCode() {
    return this.pluginEditor?.getValue() || '';
  },
  
  /**
   * Set plugin editor value
   */
  setPluginCode(code) {
    if (this.pluginEditor) {
      this.pluginEditor.setValue(code);
    }
  },
  
  /**
   * Set plugin editor read-only state
   */
  setPluginEditorReadOnly(readOnly) {
    if (this.pluginEditor) {
      this.pluginEditor.updateOptions({ readOnly });
    }
  },
  
  /**
   * Get default transform code template
   */
  getDefaultTransformCode() {
    return `/**
 * Transform Template
 * 
 * CONFIG PARAMETERS:
 * - threshold: Example threshold value - Number (default: 10)
 * - verbose: Enable verbose logging - Boolean (default: false)
 * - mode: Processing mode fast or safe - String (default: safe)
 * 
 * Available globals:
 *   ast      - The Babel AST to transform
 *   traverse - Babel traverse (both traverse(ast, {...}) and traverse({...}) work)
 *   t        - Babel types (t.identifier, t.stringLiteral, etc.)
 *   types    - Alias for t
 *   config   - User configuration from CONFIG PARAMETERS above
 *   stats    - Object to store statistics (shown in results)
 *   console  - console.log/warn/error (output shown in logs)
 */

// Access config values (with defaults)
const threshold = config.threshold ?? 10;
const verbose = config.verbose ?? false;

traverse(ast, {
  // Example: Replace all 'var' with 'let'
  VariableDeclaration(path) {
    if (path.node.kind === 'var') {
      path.node.kind = 'let';
      stats.replaced = (stats.replaced || 0) + 1;
    }
  }
});

// Log results
if (verbose) {
  console.log('Replaced:', stats.replaced || 0, 'var declarations');
}
`;
  },
  
  /**
   * Highlight line in input editor
   */
  highlightLine(lineNumber, className = 'highlight-line') {
    if (!this.inputEditor) return;
    
    const decorations = this.inputEditor.deltaDecorations([], [
      {
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: className,
          glyphMarginClassName: 'highlight-glyph'
        }
      }
    ]);
    
    // Remove highlight after 2 seconds
    setTimeout(() => {
      this.inputEditor.deltaDecorations(decorations, []);
    }, 2000);
  },
  
  /**
   * Jump to position in editor
   */
  jumpToPosition(editor, line, column) {
    const ed = editor === 'input' ? this.inputEditor : this.outputEditor;
    if (!ed) return;
    
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: column });
    // Use setTimeout to avoid Monaco's getModifierState error when focus is called 
    // synchronously from a click handler
    setTimeout(() => ed.focus(), 0);
  },
  
  /**
   * Get selection
   */
  getSelection(editor = 'input') {
    const ed = editor === 'input' ? this.inputEditor : this.outputEditor;
    if (!ed) return null;
    
    const selection = ed.getSelection();
    if (!selection) return null;
    
    return ed.getModel().getValueInRange(selection);
  },
  
  /**
   * Replace selection
   */
  replaceSelection(text, editor = 'input') {
    const ed = editor === 'input' ? this.inputEditor : this.outputEditor;
    if (!ed) return;
    
    const selection = ed.getSelection();
    if (selection) {
      ed.executeEdits('replace', [{
        range: selection,
        text: text
      }]);
    }
  },
  
  /**
   * Layout editors (call after resize)
   */
  layout() {
    this.inputEditor?.layout();
    this.outputEditor?.layout();
    this.diffEditor?.layout();
    this.inlineEditor?.layout();
    this.pluginEditor?.layout();
  },
  
  /**
   * Dispose all editors
   */
  dispose() {
    this.inputEditor?.dispose();
    this.outputEditor?.dispose();
    this.diffEditor?.dispose();
    this.inlineEditor?.dispose();
    this.pluginEditor?.dispose();
  },
  
  /**
   * Toggle input editor lock state
   */
  toggleInputLock() {
    this.inputLocked = !this.inputLocked;
    this.updateInputReadOnly();
    
    const btn = document.getElementById('btn-lock-input');
    if (btn) {
      btn.classList.toggle('active', this.inputLocked);
      btn.title = this.inputLocked ? 'Input Locked - Click to unlock' : 'Lock Input';
      // Update icon
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.innerHTML = this.inputLocked
          ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'
          : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>';
      }
    }
    
    if (typeof App !== 'undefined' && App.log) {
      App.log(this.inputLocked ? 'Input editor locked' : 'Input editor unlocked', 'info');
    }
    
    return this.inputLocked;
  },
  
  /**
   * Toggle output editor lock state
   */
  toggleOutputLock() {
    this.outputLocked = !this.outputLocked;
    this.updateOutputReadOnly();
    
    // Update lock button in output header
    const btn = document.getElementById('btn-lock-output');
    if (btn) {
      btn.classList.toggle('active', this.outputLocked);
      btn.title = this.outputLocked ? 'Output Locked - Click to unlock' : 'Lock Output';
      // Update icon
      const svg = btn.querySelector('svg');
      if (svg) {
        svg.innerHTML = this.outputLocked
          ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'
          : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>';
      }
    }
    
    // Also update the edit-mode button in action bar (keep in sync)
    const editModeBtn = document.getElementById('edit-mode-btn');
    if (editModeBtn) {
      // Note: edit mode is opposite of locked (edit=unlocked)
      editModeBtn.classList.toggle('active', !this.outputLocked);
      editModeBtn.title = this.outputLocked ? 'View Mode (output read-only)' : 'Edit Mode (output editable)';
    }
    
    // Update output panel styling
    const outputPanel = document.getElementById('output-panel');
    if (outputPanel) {
      outputPanel.classList.toggle('edit-mode', !this.outputLocked);
    }
    
    if (typeof App !== 'undefined' && App.log) {
      App.log(this.outputLocked ? 'Output editor locked' : 'Output editor unlocked', 'info');
    }
    
    return this.outputLocked;
  },
  
  /**
   * Update input editor read-only state based on lock
   */
  updateInputReadOnly() {
    if (this.inputEditor) {
      this.inputEditor.updateOptions({ readOnly: this.inputLocked });
    }
    if (this.simpleInputEl) {
      this.simpleInputEl.readOnly = this.inputLocked;
    }
  },
  
  /**
   * Update output editor read-only state based on lock
   */
  updateOutputReadOnly() {
    // Output is editable only if NOT locked
    if (this.outputEditor) {
      this.outputEditor.updateOptions({ readOnly: this.outputLocked });
    }
    if (this.simpleOutputEl) {
      this.simpleOutputEl.readOnly = this.outputLocked;
    }
  },
  
  // ==================== Script Panel Editor ====================
  
  /**
   * Create Script Panel editor (persistent side panel)
   */
  createScriptPanelEditor(containerId) {
    if (this.scriptPanelEditor) {
      this.scriptPanelEditor.dispose();
    }
    
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    this.scriptPanelEditor = monaco.editor.create(container, {
      ...this.getEditorOptions(),
      language: 'javascript',
      value: this.getScriptPanelTemplate(),
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: true,
      fontSize: 13,
      wordWrap: 'on',
      automaticLayout: true
    });
    
    return this.scriptPanelEditor;
  },
  
  /**
   * Toggle word wrap on Script Panel editor
   */
  toggleScriptPanelWordWrap() {
    if (this.scriptPanelEditor) {
      const currentWrap = this.scriptPanelEditor.getOption(monaco.editor.EditorOption.wordWrap);
      const newWrap = currentWrap === 'on' ? 'off' : 'on';
      this.scriptPanelEditor.updateOptions({ wordWrap: newWrap });
      return newWrap === 'on';
    }
    return true;
  },

  /**
   * Toggle word wrap on Input editor
   */
  toggleInputWordWrap() {
    if (this.inputEditor) {
      const currentWrap = this.inputEditor.getOption(monaco.editor.EditorOption.wordWrap);
      const newWrap = currentWrap === 'on' ? 'off' : 'on';
      this.inputEditor.updateOptions({ wordWrap: newWrap });
      return newWrap === 'on';
    }
    return false;
  },

  /**
   * Toggle word wrap on Output editor
   */
  toggleOutputWordWrap() {
    if (this.outputEditor) {
      const currentWrap = this.outputEditor.getOption(monaco.editor.EditorOption.wordWrap);
      const newWrap = currentWrap === 'on' ? 'off' : 'on';
      this.outputEditor.updateOptions({ wordWrap: newWrap });
      return newWrap === 'on';
    }
    return false;
  },

  /**
   * Get Script Panel editor value
   */
  getScriptPanelCode() {
    return this.scriptPanelEditor?.getValue() || '';
  },
  
  /**
   * Set Script Panel editor value
   */
  setScriptPanelCode(code) {
    if (this.scriptPanelEditor) {
      this.scriptPanelEditor.setValue(code);
    }
  },
  
  // ==================== Eval Panel Editor ====================
  
  /**
   * Create Eval Panel editor
   */
  createEvalPanelEditor() {
    if (this.evalPanelEditor) {
      this.evalPanelEditor.dispose();
    }
    
    const container = document.getElementById('eval-panel-editor');
    if (!container) return null;
    
    this.evalPanelEditor = monaco.editor.create(container, {
      ...this.getEditorOptions(),
      language: 'javascript',
      value: '',
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: false,
      folding: false,
      fontSize: 13,
      wordWrap: 'on',
      automaticLayout: true
    });
    
    // Add Ctrl+Enter shortcut to run
    this.evalPanelEditor.addAction({
      id: 'run-eval',
      label: 'Run Eval',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        window.App?.runEvalPanel();
      }
    });
    
    return this.evalPanelEditor;
  },
  
  /**
   * Get Eval Panel editor value
   */
  getEvalPanelCode() {
    return this.evalPanelEditor?.getValue() || '';
  },
  
  /**
   * Set Eval Panel editor value
   */
  setEvalPanelCode(code) {
    if (this.evalPanelEditor) {
      this.evalPanelEditor.setValue(code);
    }
  },
  
  /**
   * Get default template for script panel
   */
  getScriptPanelTemplate() {
    return `// Script Transform Template
// Ctrl+Enter to run | Ctrl+E to close panel
//
// CONFIG PARAMETERS:
// - targetValue: String value to search for - String (default: debug)
// - removeMatches: Remove matching nodes - Boolean (default: true)

/**
 * AVAILABLE GLOBALS:
 *   ast      - The parsed AST (Babel)
 *   traverse - Walk/modify the AST: traverse({ Visitor(path) {...} })
 *   t        - Babel types for node creation/checking
 *   config   - User configuration from recipe card
 *   stats    - Object to track changes (shown in summary)
 *   console  - Log messages (log/warn/error/info)
 *   parser   - Parse code strings: parser.parse(code)
 *   generate - Generate code from AST nodes: generate(node).code
 *   run      - Evaluate code: run("1+1") => 2
 */

// Config with defaults (auto-detected when saving as plugin)
const targetValue = config.targetValue || 'debug';
const removeMatches = config.removeMatches !== false;

traverse({
  StringLiteral(path) {
    if (path.node.value === targetValue) {
      if (removeMatches) {
        path.remove();
        stats.removed = (stats.removed || 0) + 1;
      }
    }
  }
});

// More examples:
// 
// Rename identifiers:
//   traverse({
//     Identifier(path) {
//       if (path.node.name === '_0xabc') {
//         path.node.name = 'decoded';
//       }
//     }
//   });
//
// Create new nodes with t:
//   const newNode = t.stringLiteral('hello');
//   path.replaceWith(newNode);
//
// Access program body:
//   ast.program.body.unshift(t.expressionStatement(...));
//
// Evaluate obfuscated expressions:
//   const result = run('[][\"flat\"] + []'); // => "function flat() { [native code] }"

console.log('Removed ' + (stats.removed || 0) + ' matches');
`;
  }
};

// Export
window.EditorManager = EditorManager;
