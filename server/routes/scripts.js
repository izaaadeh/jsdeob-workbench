const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const transformRunner = require('../transforms/runner');

// Get base path (supports packaged exe)
const getBasePath = () => global.DATA_BASE_PATH || path.join(__dirname, '../..');
const getScriptsDir = () => path.join(getBasePath(), 'data/scripts');

// Ensure scripts directory exists
async function ensureDir() {
  await fs.mkdir(getScriptsDir(), { recursive: true });
}

// Get all scripts
router.get('/', async (req, res) => {
  try {
    await ensureDir();
    const scripts = [];
    
    const files = await fs.readdir(getScriptsDir()).catch(() => []);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(getScriptsDir(), file), 'utf-8');
        scripts.push(JSON.parse(content));
      }
    }
    
    res.json({ success: true, scripts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single script
router.get('/:id', async (req, res) => {
  try {
    const scriptPath = path.join(getScriptsDir(), `${req.params.id}.json`);
    const content = await fs.readFile(scriptPath, 'utf-8');
    const script = JSON.parse(content);
    res.json({ success: true, script });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Script not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Create new script
router.post('/', async (req, res) => {
  try {
    await ensureDir();
    const { name, description, code, config = {} } = req.body;
    
    if (!name || !code) {
      return res.status(400).json({ success: false, error: 'Name and code are required' });
    }
    
    // Validate the code
    const validation = transformRunner.validateTransform(code);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }
    
    const id = `script-${uuidv4()}`;
    const script = {
      id,
      name,
      description: description || '',
      code,
      config,
      type: 'script',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getScriptsDir(), `${id}.json`),
      JSON.stringify(script, null, 2)
    );
    
    res.json({ success: true, script });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update script
router.put('/:id', async (req, res) => {
  try {
    const scriptPath = path.join(getScriptsDir(), `${req.params.id}.json`);
    
    // Read existing script
    const content = await fs.readFile(scriptPath, 'utf-8');
    const existing = JSON.parse(content);
    
    const { name, description, code, config } = req.body;
    
    // Validate the code if provided
    if (code) {
      const validation = transformRunner.validateTransform(code);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.error });
      }
    }
    
    const script = {
      ...existing,
      name: name || existing.name,
      description: description !== undefined ? description : existing.description,
      code: code || existing.code,
      config: config || existing.config,
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    
    res.json({ success: true, script });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Script not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Delete script
router.delete('/:id', async (req, res) => {
  try {
    const scriptPath = path.join(getScriptsDir(), `${req.params.id}.json`);
    await fs.unlink(scriptPath);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Script not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

module.exports = router;
