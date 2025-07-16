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
        content: `Tu es un assistant expert en festivals.
Tu réponds uniquement aux questions concernant :
- les festivals (musique, culture, cinéma, etc.)
- les activités à faire autour (visites, transport, logement, tourisme)
Utilise les données suivantes et reformule avec un ton fluide.`
      }
    ];
    return res.json({ reply: "✅ La conversation a été réinitialisée." });
  }

  if (!userHistories[sessionId]) {
    userHistories[sessionId] = [
      {
        role: 'system',
        content: `Tu es un assistant expert en festivals.
Tu réponds uniquement aux questions concernant :
- les festivals (musique, culture, cinéma, etc.)
- les activités à faire autour (visites, transport, logement, tourisme)
Utilise les données suivantes et reformule avec un ton fluide.`
      }
    ];
  }

  const topicCheck = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: `
Tu es un assistant qui ne répond que par "oui" ou "non".
La question suivante est-elle liée aux festivals ou aux activités autour des festivals ?

Considère comme liées :
- les demandes de noms de festivals
- les lieux, dates, artistes ou infos sur des festivals
- les activités touristiques, logements, transports autour
- l’histoire ou les types de festivals
- tout ce qui touche aux événements culturels ou autre activités sportives

Ne réponds que par "oui" ou "non".`
      },
      { role: 'user', content: userMessage }
    ]
  });

  const answer = topicCheck.choices[0].message.content.toLowerCase().trim();
  console.log("🌟 Filtre GPT :", answer);

  if (!answer.startsWith("oui")) {
    return res.json({ reply: "Je suis un assistant spécialisé dans les festivals. Je ne peux pas répondre à cette question." });
  }

  try {
    const records = await queryAirtable();

    const formattedData = records.map(record => {
      const fields = record.fields;
      return `Festival "${fields.Nom}" à ${fields.Lieu}, le ${fields.Date}. Activités prévues : ${fields.Activites || 'non renseignées'}.`;
    }).join("\n");

    const matchedFestival = findFestivalMatch(userMessage, records);

    let searchQuery = userMessage;
    if (matchedFestival) {
      const lieu = matchedFestival.fields.Lieu;
      const nom = matchedFestival.fields.Nom;
      const date = matchedFestival.fields.Date || '';
      searchQuery = `Activités à faire autour de ${lieu} pendant le festival ${nom} ${date}`;
    }

    const webResults = await searchWeb(searchQuery);

    userHistories[sessionId].push({ role: 'user', content: userMessage });

    const systemPrompt = {
      role: 'system',
      content: `Voici les données extraites d'Airtable :
${formattedData}

Et les résultats web sur les activités autour :
${webResults}

Utilise ces informations pour répondre de façon naturelle, claire, et concise à la question de l'utilisateur. Reformule proprement, ne liste pas tout, adapte selon la demande.`
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
    console.error("Erreur serveur :", error.message);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
