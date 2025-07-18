# 🎵 Assistant Festival - Chatbot intelligent pour festivals

Assistant Festival est un chatbot web interactif qui aide les utilisateurs à trouver des festivals en fonction de leurs préférences musicales, de leur budget et de leur localisation. Il s’appuie sur **GPT-4**, **SerpAPI** pour les recherches, et **n8n + Airtable** pour générer des devis automatiques.

---

## 🚀 Fonctionnalités

- 🎤 Chat multi-langue (FR/EN)
- 🤖 Génération de réponses par GPT
- 🔎 Requêtes web dynamiques via SerpAPI
- 🧠 Génération intelligente de devis
- 📤 Envoi automatique des devis à n8n / Airtable
- 💎 Interface moderne en **glassmorphism**
- 📱 Responsive mobile

---

## 📦 Technologies

| Technologie       | Usage                         |
|-------------------|-------------------------------|
| Node.js / Express | Backend serveur               |
| OpenAI GPT        | Réponses et sous-questions     |
| SerpAPI           | Recherche d'infos festival     |
| n8n + Airtable    | Collecte des devis             |
| HTML/CSS/JS       | Frontend responsive            |
| Render            | Déploiement cloud              |

---

## 🛠️ Installation

```bash
git clone https://github.com/ton-utilisateur/assistant-festival.git
cd assistant-festival
npm install


OPENAI_API_KEY=your_openai_key
SERPAPI_KEY=your_serpapi_key
WEBHOOK_URL=https://your-n8n-webhook-url.com


node server.js
http://localhost:3000
