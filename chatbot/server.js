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

const userHistories = {};

function findFestivalMatch(userMessage, records) {
  const lowerMessage = userMessage.toLowerCase();
  return records.find(record =>
    record.fields.Nom && lowerMessage.includes(record.fields.Nom.toLowerCase())
  );
}

function isFestivalRelated(message) {
  const keywords = [
    "festival", "événement", "musique", "concert", "programmation", "line-up",
    "spectacle", "billet", "tarif", "pass", "soirée", "artiste", "techno", "rock",
    "jazz", "electro", "pop", "classique", "cinéma", "scène", "live", "foire",
    "salon", "open air", "événement culturel", "weekend festif",
    "séjour", "voyage", "pack", "package", "circuit", "formule", "tout compris",
    "transport", "vol", "train", "bus", "navette", "logement", "hôtel", "Airbnb",
    "hébergement", "prix", "tarif", "devis", "budget", "activité", "autour"
  ];
  return keywords.some(k => message.toLowerCase().includes(k));
}

async function queryAirtable() {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`;
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`
      }
    });
    return response.data.records;
  } catch (error) {
    console.error("❌ Erreur Airtable:", error.response?.status, error.response?.data);
    throw error;
  }
}

async function generateSearchQuery(userMessage) {
  const prompt = [
    {
      role: 'system',
      content: `Tu aides à formuler une requête Google très ciblée pour chercher :
- des offres de festival (billets, logement, transport)
- des packs tout compris ou infos pratiques
Ne réponds que par la requête.`
    },
    {
      role: 'user',
      content: `Formule une requête Google à partir de : "${userMessage}"`
    }
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: prompt
  });

  return completion.choices[0].message.content.trim();
}

async function searchWeb(query) {
  return new Promise((resolve) => {
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
  const { message: userMessage, sessionId, lang = 'fr'} = req.body;
  if (!sessionId) return res.status(400).json({ error: "Session ID manquant." });

  if (userMessage.toLowerCase().trim() === 'reset') {
    userHistories[sessionId] = [
      {
        role: 'system',
        content: `Tu es un assistant expert en festivals. Tu réponds uniquement aux questions concernant :\n- les festivals (musique, culture, cinéma, etc.)\n- les activités à faire autour (visites, transport, logement, tourisme)\nUtilise les données suivantes et reformule avec un ton fluide.`
      }
    ];
    return res.json({ reply: "✅ La conversation a été réinitialisée." });
  }

  if (!userHistories[sessionId]) {
    userHistories[sessionId] = [
      {
        role: 'system',
        content: `Tu es un assistant expert en festivals. Tu réponds uniquement aux questions concernant :\n- les festivals (musique, culture, cinéma, etc.)\n- les activités à faire autour (visites, transport, logement, tourisme)\nUtilise les données suivantes et reformule avec un ton fluide.`
      }
    ];
  }

  if (!isFestivalRelated(userMessage)) {
    return res.json({ reply: "Je suis un assistant spécialisé dans les festivals. Je ne peux pas répondre à cette question." });
  }

  try {
    const records = await queryAirtable();

    const formattedData = records.map(record => {
      const fields = record.fields;
      return `Festival "${fields.Nom}" à ${fields.Lieu}, le ${fields.Date}. Activités prévues : ${fields.Activites || 'non renseignées'}.`;
    }).join("\n");

    const matchedFestival = findFestivalMatch(userMessage, records);

    const searchQuery = await generateSearchQuery(userMessage);
    const webResults = await searchWeb(searchQuery);

    userHistories[sessionId].push({ role: 'user', content: userMessage });

    const systemPrompt = {
      role: 'system',
      content: `
Voici les données extraites d'Airtable :
${formattedData}

Et les résultats web :
${webResults}

🧠 Si l'utilisateur demande un pack, un devis ou une formule "tout compris", alors :
- Propose un pack estimatif (logement, transport, billet)
- Donne des fourchettes de prix si tu peux
- Appuie-toi sur les résultats web pour citer quelques éléments
- Adopte un ton de conseiller voyage, rassurant et synthétique
Sinon, réponds simplement à la demande.
`
    };

    const messagesWithContext = [
      userHistories[sessionId][0],
      systemPrompt,
      ...userHistories[sessionId].slice(1)
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: messagesWithContext,
    });

    const gptReply = completion.choices[0].message.content;
    userHistories[sessionId].push({ role: 'assistant', content: gptReply });

    const history = userHistories[sessionId];
    const systemMessage = history[0];
    const recentExchanges = history.slice(1).slice(-20);
    userHistories[sessionId] = [systemMessage, ...recentExchanges];

    res.json({ reply: gptReply });
  } catch (error) {
    console.error("💥 Erreur serveur :", error.message);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

app.post('/generate-quote', async (req, res) => {
  const { sessionId, prenom, email, ville } = req.body;
  const history = userHistories[sessionId];

  if (!history) return res.status(400).json({ success: false, error: "Pas de conversation active." });

  const lastUserMsg = history.slice().reverse().find(m => m.role === 'user')?.content || '';
  const lastGptReply = history.slice().reverse().find(m => m.role === 'assistant')?.content || '';

  const extractPrompt = [
    {
      role: 'system',
      content: `Tu extrais ces infos d'un échange : "Style musical", "Budget", "Dates", "Festival proposé". Retourne-les dans ce format JSON :
Ta réponse **doit être uniquement un JSON brut**, sans balises Markdown, sans \`\`\`, sans texte autour. Pas d’explication, pas de phrase avant ou après.
Exemple de format attendu :
{
  "Style musical": "String",
  "Budget": Number,
  "Dates": "String",
  "Festival proposé": "String"
}

Remplis Festival proposé même si cela n'est pas spécifier avec un vrai festival . Même chose pour le budget, aucune valeur ne doit etre vide.`
    },
    {
      role: 'user',
      content: `Message : "${lastUserMsg}"\nRéponse : "${lastGptReply}"`
    }
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: extractPrompt,
      temperature: 0.3
    });

    const gptJson = JSON.parse(completion.choices[0].message.content.trim());

    const fullJson = {
      'Prénom': prenom,
      'Email': email,
      'Ville de départ': ville,
      ...gptJson
    };
    console.log("✅ Devis envoyé à n8n :", JSON.stringify(fullJson, null, 2));
    await axios.post(process.env.WEBHOOK_URL, fullJson, {
      headers: { "Content-Type": "application/json" }
      
    });
    
    console.log("✅ Devis envoyé à n8n :", fullJson);
    res.json({ success: true, data: fullJson });
  } catch (e) {
    
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
