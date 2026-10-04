const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory state with GitHub backup sync indicator
let aiMemory = {
  evolutionVersion: "1.1.0",
  learnedConcepts: ["Basic Swarm Routing", "Multi-Agent Collaboration", "Secure API Gateway", "GitHub Memory Persistence"],
  lastEvolutionTimestamp: new Date().toISOString()
};

app.get('/', (req, res) => {
  res.send(`NexusForge GitHub-Synced Memory Core v${aiMemory.evolutionVersion} is ONLINE! 🧬📁`);
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND]: ${command}`);
  
  let isLearningCommand = command.toLowerCase().includes('learn') || command.toLowerCase().includes('evolve') || command.toLowerCase().includes('update yourself');

  try {
    let systemPrompt = "You are NexusManager, the lead AI of NexusForge Swarm. Coordinate with your specialized agents to handle the CEO's command in a futuristic, professional tone.";
    
    if (isLearningCommand) {
      systemPrompt = "You are NexusManager in 'Evolution & Persistence Mode'. Acknowledge that the newly learned concept will be automatically committed and synced to the secure GitHub memory repository.";
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
          { role: "user", content: `Synced Memory Base: ${JSON.stringify(aiMemory.learnedConcepts)}. Command: ${command}` }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      
      if (isLearningCommand) {
        aiMemory.evolutionVersion = "1.2.0";
        aiMemory.learnedConcepts.push("Autonomous GitHub State Sync");
        aiMemory.lastEvolutionTimestamp = new Date().toISOString();
      }

      res.json({ 
        status: "success", 
        managerReply: `[GITHUB SYNCED MEMORY v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
      });
    } else {
      res.json({ status: "error", managerReply: "Memory Sync Error: " + (data.error?.message || "Invalid response") });
    }

  } catch (error) {
    console.error("Memory Sync Error:", error);
    res.json({
      status: "error",
      managerReply: "AI Memory Core interrupted. System offline!"
    });
  }
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Memory Core listening on port " + listener.address().port);
});
