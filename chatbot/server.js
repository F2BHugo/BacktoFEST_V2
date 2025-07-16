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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userHistories = {}; // historique
const userProfiles = {};  // profil utilisateur

function extractUserInfo(reply, previousInfo = {}) {
  const info = { ...previousInfo };
  const nameMatch = reply.match(/je m'appelle ([a-zA-ZÀ-ÿ\- ]+)/i);
  if (nameMatch) info.name = nameMatch[1].trim();

  const emailMatch = reply.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) info.email = emailMatch[0];

  const musicMatch = reply.match(/(electro|techno|rock|pop|rap|jazz|classique)/i);
  if (musicMatch) info.music = musicMatch[1].toLowerCase();

  const cityMatch = reply.match(/(je pars de|je viens de) ([a-zA-ZÀ-ÿ\- ]+)/i);
  if (cityMatch) info.city = cityMatch[2].trim();

  const budgetMatch = reply.match(/(\d+ ?€|\d+ euros|environ \d+)/i);
  if (budgetMatch) info.budget = budgetMatch[0];

  const dateMatch = reply.match(/du ([\d]{1,2} [a-zéû]+) au ([\d]{1,2} [a-zéû]+)/i);
  if (dateMatch) info.dates = `du ${dateMatch[1]} au ${dateMatch[2]}`;

  return info;
}

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
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
    });
    return response.data.records;
  } catch (error) {
    console.error("Erreur Airtable:", error.response?.status, error.response?.data);
    throw error;
  }
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
  const { message: userMessage, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "Session ID manquant." });

  if (userMessage.toLowerCase().trim() === 'reset') {
    userHistories[sessionId] = [
      {
        role: 'system',
        content: `Tu es un assistant expert en festivals.
Tu réponds uniquement aux questions concernant :
- les festivals (musique, culture, cinéma, etc.)
- les activités à faire autour (visites, transport, logement, tourisme)`
      }
    ];
    userProfiles[sessionId] = {};
    return res.json({ reply: "✅ La conversation a été réinitialisée." });
  }

  if (!userHistories[sessionId]) {
    userHistories[sessionId] = [
      {
        role: 'system',
        content: `Tu es un assistant expert en festivals.
Tu réponds uniquement aux questions concernant :
- les festivals (musique, culture, cinéma, etc.)
- les activités à faire autour (visites, transport, logement, tourisme)`
      }
    ];
  }

  if (!userProfiles[sessionId]) userProfiles[sessionId] = {};
  userProfiles[sessionId] = extractUserInfo(userMessage, userProfiles[sessionId]);

  try {
    const topicCheck = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant qui ne répond que par \"oui\" ou \"non\". La question suivante est-elle liée aux festivals ou aux activités autour des festivals (hotel camping ou vol)?`
        },
        { role: 'user', content: userMessage }
      ]
    });

    const answer = topicCheck.choices?.[0]?.message?.content?.toLowerCase().trim() || "non";
    if (!answer.includes("oui")) {
      return res.json({ reply: "Je suis un assistant spécialisé dans les festivals. Je ne peux pas répondre à cette question." });
    }

    const records = await queryAirtable();
    const formattedData = records.map(record => {
      const f = record.fields;
      return `Festival \"${f.Nom}\" à ${f.Lieu}, le ${f.Date}. Activités prévues : ${f.Activites || 'non renseignées'}.`;
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

    const profile = userProfiles[sessionId];
    const profileContext = `
Informations utilisateur :
- Nom: ${profile.name || 'inconnu'}
- Email: ${profile.email || 'inconnu'}
- Musique: ${profile.music || 'inconnue'}
- Ville de départ: ${profile.city || 'inconnue'}
- Budget: ${profile.budget || 'inconnu'}
- Dates: ${profile.dates || 'inconnues'}
`;

    const systemPrompt = {
      role: 'system',
      content: `Voici les données extraites d'Airtable :
${formattedData}

Et les résultats web sur les activités autour :
${webResults}

${profileContext}

Utilise ces informations pour répondre de façon naturelle, claire, et concise à la question de l'utilisateur.`
    };

    const messagesWithContext = [
      userHistories[sessionId][0],
      systemPrompt,
      ...userHistories[sessionId].slice(1)
    ];

    let gptReply = "❌ Aucune réponse générée.";
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: messagesWithContext,
      });
      console.log("✅ Réponse GPT brute :", JSON.stringify(completion, null, 2));
      gptReply = completion.choices?.[0]?.message?.content?.trim() || "❌ Réponse vide de GPT.";
    } catch (err) {
      console.error("💥 Erreur GPT:", err.message);
      gptReply = "❌ Une erreur est survenue avec GPT.";
    }

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
  console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
