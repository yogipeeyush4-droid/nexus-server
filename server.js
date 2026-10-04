const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Memory system for Self-Learning
let aiMemory = {
  evolutionVersion: "1.0.0",
  learnedConcepts: ["Basic Swarm Routing", "Multi-Agent Collaboration", "Secure API Gateway"],
  lastEvolutionTimestamp: new Date().toISOString()
};

app.get('/', (req, res) => {
  res.send(`NexusForge Evolution Core v${aiMemory.evolutionVersion} is ONLINE! 🧬🚀`);
});

app.post('/api/swarm', async (req, res) => {
  const { command } = req.body;
  console.log(`[CEO COMMAND]: ${command}`);
  
  // Check if command is for self-learning / evolution
  let isLearningCommand = command.toLowerCase().includes('learn') || command.toLowerCase().includes('evolve') || command.toLowerCase().includes('update yourself');

  try {
    let systemPrompt = "You are NexusManager, the lead AI of NexusForge Swarm. Coordinate with your specialized agents (@Research_AI, @Coder_DB_AI, @Tester_AI) to handle the CEO's command in a futuristic, professional tone.";
    
    if (isLearningCommand) {
      systemPrompt = "You are NexusManager in 'Evolution Mode'. Analyze the CEO's request for self-learning. Propose a new logic concept, simulate self-mutation, and confirm how the AI system is upgrading its internal knowledge base.";
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
          { role: "user", content: `Current Learned Memory: ${JSON.stringify(aiMemory.learnedConcepts)}. Command: ${command}` }
        ]
      })
    });

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const aiReply = data.choices[0].message.content;
      
      // If it's a learning command, update internal state dynamically
      if (isLearningCommand) {
        aiMemory.evolutionVersion = "1.1.0";
        aiMemory.learnedConcepts.push("Autonomous Self-Analysis & Prompt Mutation");
        aiMemory.lastEvolutionTimestamp = new Date().toISOString();
      }

      res.json({ 
        status: "success", 
        managerReply: `[EVOLUTION ENGINE ACTIVE v${aiMemory.evolutionVersion}]\n\n${aiReply}` 
      });
    } else {
      res.json({ status: "error", managerReply: "Evolution Error: " + (data.error?.message || "Invalid response") });
    }

  } catch (error) {
    console.error("Evolution Error:", error);
    res.json({
      status: "error",
      managerReply: "AI Evolution Core interrupted. System offline!"
    });
  }
});

const listener = app.listen(process.env.PORT || 3000, () => {
  console.log("Evolution Core listening on port " + listener.address().port);
});
