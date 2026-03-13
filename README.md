# Pitch Clinic 🎯

> Brutally honest AI feedback on your startup pitch — like a VC tearing it apart before they do.

An open-source, enhanced fork of [Pitch Destructor](https://pitch.answer42.io) by [answer42](https://answer42.io).

## What it does

Record or type your startup pitch. Get scored across 7 dimensions with a VC kill shot, a rewritten hook, and concrete next steps.

## Scoring dimensions

- Hook (first 15 seconds)
- Problem Clarity
- Solution
- Market Size
- Business Model
- Traction
- Founder-Market Fit

## Enhancements over original

- 7 dimensions (vs 5)
- Context fields: stage, sector, pitch type
- Hook rewrite suggestion
- 3 concrete next steps
- Momentum signal
- Improved prompt with no score anchoring bias

## Stack

- Frontend: React 18 + Tailwind CSS (single HTML file)
- Backend: Bun HTTP server
- STT: Deepgram Nova-2
- Analysis: Anthropic Claude Sonnet

## Run locally

```bash
# Requires: bun, 1Password CLI (op)
git clone https://github.com/reddinft/pitch-clinic
cd pitch-clinic
bun server.js
# → http://localhost:3000
```

## Deploy (Fly.io)

```bash
fly deploy --app pitch-clinic --remote-only
```

## Credits

- Original concept & design: [Pitch Destructor](https://pitch.answer42.io) by [answer42.io](https://answer42.io)
- Enhanced & open-sourced by [Redditech](https://reddi.tech)

## Licence

MIT
