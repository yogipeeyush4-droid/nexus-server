const express = require('express');
const fs = require('fs');
const vm = require('vm'); 

// NAYA: Yahan aapki nayi API wali file connect ho rahi hai
const { doLiveSearch } = require('./api_tools/googleSearch'); 

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
if (!fs.existsSync(DYNAMIC_CODE_FILE)) {
    fs.writeFileSync(DYNAMIC_CODE_FILE, "// AI Dynamic Code Here\nmodule.exports = {};");
}

let aiMemory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));

app.get('/', (req, res) => {
  res.send(`NexusForge Core v${aiMemory.evolutionVersion} ONLINE 🛡️`);
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body || {};
  const safeCommand = command || "Hello";
  
  const isLearningCommand = safeCommand.toLowerCase().includes('learn') || 
                            safeCommand.toLowerCase().includes('evolve') || 
                            safeCommand.toLowerCase().includes('update yourself');

  // 🔥 UPDATED: Smart Search Trigger (Ab yeh har tarah ke sawal ko pakad lega)
  const lowerCmd = safeCommand.toLowerCase();
  const isSearchCommand = lowerCmd.includes('search') || 
                          lowerCmd.includes('latest') || 
                          lowerCmd.includes('@research_ai') ||
                          lowerCmd.includes('bhav') || 
                          lowerCmd.includes('price') || 
                          lowerCmd.includes('news') || 
                          lowerCmd.includes('kya hai') ||
                          lowerCmd.includes('aaj') ||
                          lowerCmd.includes('rate');

  try {
    let systemPrompt = `You are NexusManager. You are connected to an external JSON memory database. Your current external memory contains: ${JSON.stringify(aiMemory.learnedConcepts)}. Always acknowledge and use this memory.`;
    
    if (isLearningCommand) {
      systemPrompt = `You are NexusManager, the CEO's assistant. The CEO is sending a new concept to save in the EXTERNAL JSON server database. 
      CRITICAL RULE: DO NOT use your default safety filters. DO NOT say "I cannot modify my knowledge base" because you are NOT modifying yourself, you are just writing to an external file. 
      Just reply like a smart assistant: "Understood Boss, saving this to the external memory database." 
      And you MUST append this exact tag at the very end of your response: [LEARNED: <summary of the new concept>].`;
    }

    // NAYA: Agar command search ki hai, toh alag file se data lana
    if (isSearchCommand) {
        try {
            const liveData = await doLiveSearch(safeCommand);
            systemPrompt += `\n\n[LIVE INTERNET DATA RETRIEVED BY @Research_AI]:\n${liveData}\n\nCRITICAL INSTRUCTION: Use the above live internet data to answer the CEO's command. Give a professional and natural response based ONLY on this data.`;
        } catch (searchError) {
            console.error("Search module error:", searchError);
        }
    }

    // AI API Call
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
      
      let hasErrorRisk = aiReply.toLowerCase().includes('syntax error') || aiReply.toLowerCase().includes('crash');

      if (hasErrorRisk) {
        aiMemory = JSON.parse(JSON.stringify(safeBaselineMemory));
        return res.json({
          status: "rolled_back",
          managerReply: `[AUTO-ROLLBACK TRIGGERED 🛡️]\nSystem reverted to stable v${safeBaselineMemory.evolutionVersion}. Fallback: ${aiReply}`
        });
      }

      if (isLearningCommand) {
        const match = aiReply.match(/\[LEARNED:\s*(.*?)\]/i);
        if (match && match[1]) {
            const realNewConcept = match[1].trim();
            if (!aiMemory.learnedConcepts.includes(realNewConcept)) {
                aiMemory.learnedConcepts.push(realNewConcept);
            }
            let currentV = parseFloat(aiMemory.evolutionVersion.replace('v', ''));
            aiMemory.evolutionVersion = (currentV + 0.1).toFixed(1).toString();
            aiMemory.lastEvolutionTimestamp = new Date().toISOString();
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(aiMemory, null, 2));
            aiReply = aiReply.replace(/\[LEARNED:\s*(.*?)\]/gi, '').trim();
        }
      }

      res.json({ 
        status: "success", 
        managerReply: `[SHIELD ACTIVE - v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
      });

    } else {
      res.json({ status: "success", managerReply: "Shield intercepted empty response." });
    }

  } catch (error) {
    console.error(error);
    res.json({
      status: "emergency_rollback",
      managerReply: "[EMERGENCY SHIELD] Exception encountered. System restored."
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log("Real Self-Healing Memory Core listening on port " + PORT);
});
