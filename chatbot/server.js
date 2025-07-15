const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios');
const { getJson } = require('serpapi');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function queryAirtable() {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`
    }
  });
  return response.data.records;
}

async function searchWeb(query) {
  return new Promise((resolve, reject) => {
    getJson({
      engine: "google",
      q: query,
      api_key: process.env.SERPAPI_KEY,
    }, (data) => {
      if (data && data.organic_results) {
        const results = data.organic_results.slice(0, 3)
          .map(r => `${r.title}: ${r.snippet}`)
          .join('\n');
        resolve(results);
      } else {
        resolve("Aucune information trouvée sur le web.");
      }
    });
  });
}

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;

  try {
    const topicCheck = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: "Réponds uniquement par 'oui' ou 'non'. Cette question concerne-t-elle un festival ou une activité à faire autour ?"
        },
        { role: 'user', content: userMessage }
      ]
    });

    const answer = topicCheck.choices[0].message.content.toLowerCase();
    if (!answer.includes("oui")) {
      return res.json({ reply: "Je suis un assistant spécialisé dans les festivals. Je ne peux pas répondre à cette question." });
    }

    const records = await queryAirtable();
    const formattedData = records.map(record => {
      const fields = record.fields;
      return `Nom : ${fields.Nom}, Lieu : ${fields.Lieu}, Date : ${fields.Date}, Activités : ${fields.Activites || 'non renseignées'}`;
    }).join("\n");

    const webResults = await searchWeb(userMessage);

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant expert en festivals. Tu réponds uniquement avec :
1. Les données suivantes extraites d'une base Airtable :
${formattedData}

2. Et les recherches web récentes :
${webResults}

Formule une réponse claire et concise à la question de l'utilisateur.`
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    res.json({ reply: completion.choices[0].message.content });

  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
