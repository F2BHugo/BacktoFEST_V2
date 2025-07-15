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

function findFestivalMatch(userMessage, records) {
  const lowerMessage = userMessage.toLowerCase();
  return records.find(record =>
    record.fields.Nom && lowerMessage.includes(record.fields.Nom.toLowerCase())
  );
}

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;

  try {
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
  - tout ce qui touche aux événements culturels et ou autre activités sportives

  Ne réponds que par "oui" ou "non".`        },
        { role: 'user', content: userMessage }
      ]
    });

    const answer = topicCheck.choices[0].message.content.toLowerCase().trim();
      if (!answer.startsWith("oui")) {
      return res.json({ reply: "Je suis un assistant spécialisé dans les festivals. Je ne peux pas répondre à cette question." });
    }

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

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant expert en festivals.

Voici des données extraites d'une base Airtable :
${formattedData}

Et voici des résultats de recherche web liés à la question :
${webResults}

Ta mission :
- Identifier les festivals mentionnés dans la question
- Utiliser leurs infos (nom, lieu, date, activités prévues)
- Compléter avec les suggestions d'activités autour du lieu et de la date
- Répondre de manière fluide, utile et conviviale
- Ne donne pas toute la liste brute si ce n'est pas utile

Sois synthétique, agréable et pertinent.`
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    res.json({ reply: completion.choices[0].message.content });

  } catch (error) {
    console.error("Erreur serveur :", error.message);
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
