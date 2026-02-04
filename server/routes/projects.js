const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Get base path (supports packaged exe)
const getBasePath = () => global.DATA_BASE_PATH || path.join(__dirname, '../..');
const getProjectsDir = () => path.join(getBasePath(), 'data/projects');

// Get all projects
router.get('/', async (req, res) => {
  try {
    const files = await fs.readdir(getProjectsDir()).catch(() => []);
    const projects = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(getProjectsDir(), file), 'utf-8');
        const project = JSON.parse(content);
        // Return lightweight list (no code content)
        projects.push({
          id: project.id,
          name: project.name,
          description: project.description,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          recipeCount: project.recipe?.length || 0
        });
      }
    }
    
    // Sort by updated date, newest first
    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    
    res.json({ success: true, projects });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get single project
router.get('/:id', async (req, res) => {
  try {
    const projectPath = path.join(getProjectsDir(), `${req.params.id}.json`);
    const content = await fs.readFile(projectPath, 'utf-8');
    const project = JSON.parse(content);
    res.json({ success: true, project });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Create new project
router.post('/', async (req, res) => {
  try {
    const { name, description, inputCode, outputCode, recipe, history } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    
    const id = uuidv4();
    const project = {
      id,
      name,
      description: description || '',
      inputCode: inputCode || '',
      outputCode: outputCode || '',
      recipe: recipe || [],
      history: history || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getProjectsDir(), `${id}.json`),
      JSON.stringify(project, null, 2)
    );
    
    res.json({ success: true, project });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update project
router.put('/:id', async (req, res) => {
  try {
    const projectPath = path.join(getProjectsDir(), `${req.params.id}.json`);
    
    // Check if exists
    const existingContent = await fs.readFile(projectPath, 'utf-8');
    const existing = JSON.parse(existingContent);
    
    const { name, description, inputCode, outputCode, recipe, history } = req.body;
    
    const updated = {
      ...existing,
      name: name || existing.name,
      description: description !== undefined ? description : existing.description,
      inputCode: inputCode !== undefined ? inputCode : existing.inputCode,
      outputCode: outputCode !== undefined ? outputCode : existing.outputCode,
      recipe: recipe !== undefined ? recipe : existing.recipe,
      history: history !== undefined ? history : existing.history,
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(projectPath, JSON.stringify(updated, null, 2));
    
    res.json({ success: true, project: updated });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Delete project
router.delete('/:id', async (req, res) => {
  try {
    const projectPath = path.join(getProjectsDir(), `${req.params.id}.json`);
    await fs.unlink(projectPath);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Duplicate project
router.post('/:id/duplicate', async (req, res) => {
  try {
    const projectPath = path.join(getProjectsDir(), `${req.params.id}.json`);
    const content = await fs.readFile(projectPath, 'utf-8');
    const original = JSON.parse(content);
    
    const id = uuidv4();
    const duplicate = {
      ...original,
      id,
      name: `${original.name} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getProjectsDir(), `${id}.json`),
      JSON.stringify(duplicate, null, 2)
    );
    
    res.json({ success: true, project: duplicate });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Export project
router.get('/:id/export', async (req, res) => {
  try {
    const projectPath = path.join(getProjectsDir(), `${req.params.id}.json`);
    const content = await fs.readFile(projectPath, 'utf-8');
    const project = JSON.parse(content);
    
    // Remove internal IDs for clean export
    const exportData = {
      name: project.name,
      description: project.description,
      inputCode: project.inputCode,
      recipe: project.recipe.map(item => ({
        id: item.id,
        type: item.type,
        name: item.name,
        code: item.code,
        config: item.config,
        enabled: item.enabled
      }))
    };
    
    res.json({ success: true, project: exportData });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'Project not found' });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Import project
router.post('/import', async (req, res) => {
  try {
    const { project } = req.body;
    
    if (!project || !project.name) {
      return res.status(400).json({ success: false, error: 'Invalid project format' });
    }
    
    const id = uuidv4();
    const newProject = {
      id,
      name: project.name,
      description: project.description || '',
      inputCode: project.inputCode || '',
      outputCode: '',
      recipe: project.recipe || [],
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(getProjectsDir(), `${id}.json`),
      JSON.stringify(newProject, null, 2)
    );
    
    res.json({ success: true, project: newProject });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
