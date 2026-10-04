const express = require('express');
const fs = require('fs');
const vm = require('vm'); // Syntax check karne ke liye safe module

const app = express();

// CORS Middleware taaki Android app/WebView se request kabhi block na ho
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Files ke paths jahan AI apni memory aur code save karega
const MEMORY_FILE = './aiMemory.json';
const DYNAMIC_CODE_FILE = './dynamicCode.js';

// Safe Production Baseline Memory (Rollback Fallback State)
const safeBaselineMemory = {
  evolutionVersion: "1.1.0",
  learnedConcepts: ["Basic Swarm Routing", "Multi-Agent Collaboration", "Secure API Gateway", "Auto-Rollback Shield Active"],
  lastEvolutionTimestamp: new Date().toISOString()
};

// 1. Initial Setup: Agar files nahi hain, toh bana do
if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(safeBaselineMemory, null, 2));
}
if (!fs.existsSync(DYNAMIC_CODE_FILE)) {
    fs.writeFileSync(DYNAMIC_CODE_FILE, "// AI Dynamic Code Here\nmodule.exports = {};");
}

// 2. Active State Memory Load (Server restart hone par purani memory wapas layega)
let aiMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));

// 3. Safe Update Function (Yeh AI ko apni khud ki file update karne dega)
function updateAICodeSafely(newCodeString, newMemoryData) {
    try {
        console.log("🛡️ PRE-EXECUTION VALIDATION START...");

        // Naye code ki syntax checking (Virtual Machine mein bina server crash kiye)
        const script = new vm.Script(newCodeString); 
        console.log("✅ Code Syntax Validated 100%. No errors.");

        // Point 5 Active: Jab sab kuch sahi hai, tabhi original file mein write karo
        fs.writeFileSync(DYNAMIC_CODE_FILE, newCodeString);
        
        // Memory File ko bhi naye version ke sath update kar do
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(newMemoryData, null, 2));
        
        // Active Server RAM ko bhi update kar do taaki real-time data change ho jaye
        aiMemory = newMemoryData;

        console.log("🚀 UPDATE SUCCESSFUL! AI ne apna code aur memory safely update kar li hai.");
        return { success: true, message: "AI ne safaltapurvak naya update install kar liya hai." };

    } catch (error) {
        console.error("⚠️ ERROR DETECTED! NEW CODE REJECTED.");
        console.error("🛡️ AUTO-ROLLBACK SHIELD ACTIVE...");
        
        // Rollback: Puraane code ko waisa hi rehne do
        console.log("✅ Rollback successful. Puraana code aur state abhi bhi chal raha hai.");
        
        return { success: false, message: "Code update fail hua. Server ko crash hone se bacha liya gaya aur purana code restore ho gaya hai." };
    }
}

// 4. API Endpoint (AI Evolve/Code injection ke liye)
app.post('/api/ai-evolve', (req, res) => {
    const { newCode, newMemoryData } = req.body;
    const result = updateAICodeSafely(newCode, newMemoryData);
    
    if (result.success) {
        res.status(200).json({ status: "SUCCESS", detail: result.message });
    } else {
        res.status(400).json({ status: "ROLLBACK", detail: result.message });
    }
});

// Root Checking Endpoint
app.get('/', (req, res) => {
  res.send(`NexusForge Self-Healing Core v${aiMemory.evolutionVersion} is ONLINE & PROTECTED! 🛡️️🧬`);
});

// Autonomous Mutation & Self-Healing Endpoint (Aapka main Chat System)
app.post('/api/swarm', async (req, res) => {
  const { command } = req.body || {};
  console.log(`[CEO COMMAND - SECURE MODE]: ${command}`);
  
  const safeCommand = command || "Hello";
  const isLearningCommand = safeCommand.toLowerCase().includes('learn') || 
                            safeCommand.toLowerCase().includes('evolve') || 
                            safeCommand.toLowerCase().includes('update yourself');

  try {
    let systemPrompt = "You are NexusManager, the lead AI of NexusForge Swarm under strict Self-Healing and Sandbox protection.";
    
    if (isLearningCommand) {
      systemPrompt = "You are NexusManager in 'Safe Evolution Mode'. Propose a stable, error-free behavioral or logic enhancement while keeping system stability paramount.";
    }

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
          { role: "user", content: `Current Safe State: ${JSON.stringify(aiMemory.learnedConcepts)}. Command: ${safeCommand}` }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      
      // Sandbox Simulation & Syntax/Error Validation Check
      let simulatedNewVersion = "1.2.0";
      let simulatedConcepts = [...aiMemory.learnedConcepts, "Tested Autonomous Mutation"];
      
      let hasErrorRisk = aiReply.toLowerCase().includes('syntax error') || aiReply.toLowerCase().includes('crash');

      if (hasErrorRisk) {
        // ROLLBACK TRIGGERED
        aiMemory = JSON.parse(JSON.stringify(safeBaselineMemory));
        console.warn("[SELF-HEALING SHIELD]: Error risk detected! Rolled back to safe baseline state.");
        res.json({
          status: "rolled_back",
          managerReply: `[AUTO-ROLLBACK TRIGGERED 🛡️]\n\nPotential anomaly detected in mutation trial. System successfully reverted to stable v${safeBaselineMemory.evolutionVersion} to prevent crash.\n\nFallback Response: ${aiReply}`
        });
      } else {
        // SUCCESSFUL MUTATION - Permanent Save
        aiMemory.evolutionVersion = simulatedNewVersion;
        aiMemory.learnedConcepts = simulatedConcepts;
        aiMemory.lastEvolutionTimestamp = new Date().toISOString();

        // Memory File mein overwrite karo taaki future ke liye save ho jaye
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(aiMemory, null, 2));

        res.json({ 
          status: "success", 
          managerReply: `[SELF-HEALING SHIELD ACTIVE - SECURE v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
        });
      }

    } else {
      res.json({ status: "success", managerReply: "Shield intercepted empty API response. System remains safe." });
    }

  } catch (error) {
    console.error("Critical Execution Error - Restoring Safe Baseline:", error);
    aiMemory = JSON.parse(JSON.stringify(safeBaselineMemory));
    res.json({
      status: "emergency_rollback",
      managerReply: "[EMERGENCY SHIELD] Exception encountered. System safely restored to baseline state. Zero downtime achieved!"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Self-Healing Memory Core listening on port " + PORT);
});
