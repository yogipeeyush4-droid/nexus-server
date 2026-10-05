const express = require('express');
const fs = require('fs');
const vm = require('vm'); 
const path = require('path');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const MEMORY_FILE = './aiMemory.json';
const DYNAMIC_CODE_FILE = './dynamicCode.js';

const safeBaselineMemory = {
  evolutionVersion: "1.1.0",
  learnedConcepts: ["Basic Swarm Routing", "Multi-Agent Collaboration", "Secure API Gateway", "Auto-Rollback Shield Active"],
  lastEvolutionTimestamp: new Date().toISOString()
};

if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(safeBaselineMemory, null, 2));
}

let aiMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));

app.get('/', (req, res) => {
  res.send(`NexusForge Core v${aiMemory.evolutionVersion} ONLINE 🛡️`);
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body || {};
  const safeCommand = command || "Hello";

  try {
    let systemPrompt = `You are NexusManager. Connected to external JSON memory: ${JSON.stringify(aiMemory.learnedConcepts)}.`;
      
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Command: ${safeCommand}` }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      let aiReply = data.choices[0].message.content;

      res.json({ 
        status: "success", 
        managerReply: `[SHIELD ACTIVE - v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
      });
    } else {
      res.json({ status: "success", managerReply: "Shield intercepted empty response." });
    }

  } catch (error) {
    res.json({
      status: "error",
      managerReply: "[ERROR] Kuch gadbad ho gayi hai: " + error.message
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Core listening on port " + PORT);
});
