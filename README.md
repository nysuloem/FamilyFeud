# Family Feud Home Game

A phone-controlled Family Feud game inspired by the Richard Dawson era. It supports a shared-TV host display and fully remote play.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. For phones on the same Wi-Fi, set `PUBLIC_URL` to the computer's LAN address (for example `http://192.168.1.20:3000`).

## Railway

Connect this repository to Railway. Optional variables:

- `OPENAI_API_KEY`: generates a new, validated game package for each game. Without it, the game uses built-in boards.
- `OPENAI_MODEL`: defaults to `gpt-5-mini`.
- `OPENAI_JUDGE_MODEL`: optional judging-model override; otherwise uses `OPENAI_MODEL` or `gpt-5-mini`.

With `OPENAI_API_KEY` configured, OpenAI generates and validates every game package, makes the final decision on every main-game and Fast Money answer, announces the families, and voices the host prompts and survey reveals. Players can either type or use the microphone button; voice recognition is performed by the browser and the resulting transcript is still judged by OpenAI.
- `PUBLIC_URL`: the public Railway URL, if Railway's forwarded host is unavailable.

## Game package requirements

The generator creates four main-game surveys containing 7, 6, 5, and 4 answers. Rounds 1–2 score single points, round 3 double, and round 4 triple. It also creates five short Fast Money surveys. Every accepted answer contains explicit aliases; the server additionally applies conservative normalization and fuzzy matching.

This project is an unofficial, private home-game homage and is not affiliated with or endorsed by Family Feud or its owners.
