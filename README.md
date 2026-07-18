# 🛒 Should I Buy This? — AI Decision Assistant

Paste a **product link**, add your monthly budget and recent spending, and an LLM gives
an honest **Buy / Wait / Don't buy** with the trade-offs — reasoning over your real
numbers, not just a calculation.

Uses **Groq** (free, fast) for the reasoning. The API key lives on a small **Node
backend** (never in the browser), and the backend also **auto-detects the price** from
the product link you paste.

## Architecture

```
should-i-buy/
  server.js          # Express backend: /api/price + /api/decide (holds the API key)
  package.json
  .env               # your secrets (gitignored)  ← copy from .env.example
  public/            # the frontend (static)
    index.html       # redesigned UI — link in, verdict out
    manifest.json, sw.js, icons/
```

- **`POST /api/price`** — fetches the product page and extracts price + title + image
  (via JSON-LD, Open Graph meta tags, then a regex fallback). Best-effort; the user can
  always correct the price.
- **`POST /api/decide`** — sends the budget context to the **Groq** chat-completions
  API (OpenAI-compatible) using the server-held key and returns structured JSON
  (verdict, confidence, pros/cons, budget impact, reasoning, alternatives).

## Setup & run

```bash
cd should-i-buy
cp .env.example .env         # then edit .env and paste your GROQ_API_KEY
npm install
npm start                    # → http://localhost:8787
```

Open <http://localhost:8787>, paste a product link, tap **Detect**, fill in your
budget, and hit **Should I buy it?**

Get a **free** Groq API key (no card required) at <https://console.groq.com/keys>.

## Notes

- The browser never sees your API key — it only talks to your own backend.
- Price auto-detection depends on the retailer's markup. Some sites (e.g. Amazon)
  block bots, so if the price isn't found, just type it in.
- To deploy, host the Node app on any server that runs Node (Render, Railway, Fly,
  a VPS, etc.). Static-only hosts like GitHub Pages can't run the backend.
