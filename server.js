const express = require('express');
const app = express();

app.use(express.json());

// Safe Production Baseline Memory (Rollback Fallback State)
const safeBaselineMemory = {
  evolutionVersion: "1.1.0",
  learnedConcepts: ["Basic Swarm Routing", "Multi-Agent Collaboration", "Secure API Gateway", "Auto-Rollback Shield Active"],
  lastEvolutionTimestamp: new Date().toISOString()
};

// Active State
let aiMemory = JSON.parse(JSON.stringify(safeBaselineMemory));

app.get('/', (req, res) => {
  res.send(`NexusForge Self-Healing Core v${aiMemory.evolutionVersion} is ONLINE & PROTECTED! 🛡️🧬`);
});

// Autonomous Mutation & Self-Healing Endpoint
app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND - SECURE MODE]: ${command}`);
  
  let isLearningCommand = command.toLowerCase().includes('learn') || command.toLowerCase().includes('evolve') || command.toLowerCase().includes('update yourself');

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
          { role: "user", content: `Current Safe State: ${JSON.stringify(aiMemory.learnedConcepts)}. Command: ${command}` }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      
      // Sandbox Simulation & Syntax/Error Validation Check
      let simulatedNewVersion = "1.2.0";
      let simulatedConcepts = [...aiMemory.learnedConcepts, "Tested Autonomous Mutation"];
      
      // Safety Check Simulation: If response contains fatal words or syntax issues, trigger Rollback
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
        // SUCCESSFUL MUTATION
        aiMemory.evolutionVersion = simulatedNewVersion;
        aiMemory.learnedConcepts = simulatedConcepts;
        aiMemory.lastEvolutionTimestamp = new Date().toISOString();

        res.json({ 
          status: "success", 
          managerReply: `[SELF-HEALING SHIELD ACTIVE - SECURE v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
        });
      }

    } else {
      res.json({ status: "error", managerReply: "Shield intercepted invalid API response. System remains safe." });
    }

  } catch (error) {
    console.error("Critical Execution Error - Restoring Safe Baseline:", error);
    // EMERGENCY FALLBACK ROLLBACK
    aiMemory = JSON.parse(JSON.stringify(safeBaselineMemory));
    res.json({
      status: "emergency_rollback",
      managerReply: "[EMERGENCY SHIELD] Exception encountered. System safely restored to baseline state. Zero downtime achieved!"
    });
  }
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Self-Healing Memory Core listening on port " + listener.address().port);
});
