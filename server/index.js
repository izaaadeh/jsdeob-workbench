const express = require('express');
const path = require('path');
const fs = require('fs').promises;

// Routes
const transformRoutes = require('./routes/transform');
const pluginRoutes = require('./routes/plugins');
const projectRoutes = require('./routes/projects');
const scriptRoutes = require('./routes/scripts');

const app = express();
const PORT = process.env.PORT || 3000;

// Detect if running as packaged exe (pkg)
const isPkg = typeof process.pkg !== 'undefined';

// Get base path - when packaged, use the directory containing the exe
const getBasePath = () => isPkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
// Get snapshot path - when packaged, assets are inside the snapshot filesystem
const getSnapshotPath = () => isPkg ? path.join(path.dirname(process.execPath), 'snapshot', 'jsdeob-workbench') : path.join(__dirname, '..');

// Middleware
app.use(express.json({ limit: '50mb' }));

// Serve static files - in pkg, files are in /snapshot/jsdeob-workbench/
// Use __dirname which points to the correct location in the snapshot
const staticBasePath = isPkg ? path.join(__dirname, '..') : path.join(__dirname, '..');
app.use(express.static(path.join(staticBasePath, 'client')));

// Serve Monaco Editor from node_modules
app.use('/monaco', express.static(path.join(staticBasePath, 'node_modules/monaco-editor/min')));

// API Routes
app.use('/api/transform', transformRoutes);
app.use('/api/plugins', pluginRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/scripts', scriptRoutes);

// Ensure data directories exist (writable directories outside snapshot)
async function ensureDataDirs() {
  const basePath = getBasePath();
  const dirs = [
    path.join(basePath, 'data'),
    path.join(basePath, 'data/projects'),
    path.join(basePath, 'data/plugins'),
    path.join(basePath, 'data/scripts'),
    path.join(basePath, 'plugins'),
    path.join(basePath, 'plugins/examples')
  ];
  
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
  
  // Export base path for other modules
  global.DATA_BASE_PATH = basePath;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), packaged: isPkg });
});

// Start server
ensureDataDirs().then(() => {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   JS Deobfuscation Workbench                              ║
║   ─────────────────────────────                           ║
║   Server running at http://localhost:${PORT}                ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
