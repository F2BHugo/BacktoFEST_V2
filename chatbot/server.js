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

const userHistories = {}; // { sessionId: [ { role, content } ] }

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
    "agence de voyage", "séjour", "voyage", "pack", "package", "circuit", "tour",
    "excursion", "visite", "découverte", "activité touristique", "guide touristique",
    "site touristique", "monument", "culture locale", "destinations", "destination",
    "transport", "vol", "avion", "train", "bus", "navette", "aéroport", "transfert",
    "trajet", "itinéraire", "correspondance", "déplacement",
    "hébergement", "logement", "chambre", "hôtel", "auberge", "Airbnb", "location",
    "camping", "nuitée",
    "budget", "coût", "prix", "tarif", "devis", "frais", "paiement", "acompte",
    "assurance voyage", "taxe", "douane", "visa", "passeport",
    "ville", "lieu", "pays", "région", "environ", "autour", "proche de", "près de"
  ];
  const lowerMsg = message.toLowerCase();
  return keywords.some(keyword => lowerMsg.includes(keyword));
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
  const { message: userMessage, sessionId } = req.body;
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

    // ✨ GPT génère une requête web personnalisée
    const searchPrompt = [
      {
        role: 'system',
        content: "Tu es un assistant qui aide à formuler une requête Google pertinente en lien avec un festival. Réponds uniquement par la requête de recherche sans phrase autour."
      },
      {
        role: 'user',
        content: `Formule une requête web pour cette demande : "${userMessage}"`
      }
    ];

    const searchCompletion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: searchPrompt
    });

    const searchQuery = searchCompletion.choices[0].message.content.trim();
    console.log("🔍 Requête SerpAPI :", searchQuery);

    const webResults = await searchWeb(searchQuery);

    userHistories[sessionId].push({ role: 'user', content: userMessage });

    const systemPrompt = {
      role: 'system',
      content: `Voici les données extraites d'Airtable :\n${formattedData}\n\nEt les résultats web sur les activités autour :\n${webResults}\n\nUtilise ces informations pour répondre de façon naturelle, claire, et concise à la question de l'utilisateur. Reformule proprement, ne liste pas tout, adapte selon la demande.`
    };

    const messagesWithContext = [
      userHistories[sessionId][0],
      systemPrompt,
      ...userHistories[sessionId].slice(1)
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
