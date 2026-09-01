# Family Feud Home Game

A phone-controlled Family Feud game inspired by the Richard Dawson era. It supports a shared-TV host display and fully remote play.

Games support 2–10 players. If a one-player family reaches Fast Money, that player completes both timed halves.

## Solo Test Mode

Choose **Open Test Mode** on the home screen, then either **Test Introduction + Round 1** or **Test Fast Money**. No joining link, second device, or other player is required. The test creates two sample families, and you control the active contestant (including both faceoff buzzers and both Fast Money players).

The introduction test plays the normal opening sequence, runs one full round including strikes/steal/unrevealed answers, and stops there. Fast Money starts at player selection and includes both timed halves, both narrated reveals, and the payout. Use **Restart / switch test** at any time to return to the test setup, or **Exit test** to return to regular games.

Tests use fixed built-in surveys in separate rooms, without generating a new survey package or changing real games. The normal host audio, OpenAI judging, microphone input, and timers remain active. Optional: upload your own photo and explicitly consent to test the introduction souvenir too; otherwise sample avatars are used and no image edit is requested. API audio/judging/image usage still applies when configured. This is a solo rehearsal of the shared game flow, not a simulation of multiplayer network latency.

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
- `OPENAI_IMAGE_MODEL`: optional personalized greeting-image model; defaults to `gpt-image-2`. One consenting adult is randomly selected, with one image-edit request per game. If unavailable, the normal host introduction continues.
- `PUBLIC_URL`: the public Railway URL, if Railway's forwarded host is unavailable.

With `OPENAI_API_KEY` configured, OpenAI generates and validates every game package, makes the final decision on every main-game and Fast Money answer, announces the families, and voices the host prompts and survey reveals. Players can either type or use the microphone button; voice recognition is performed by the browser and the resulting transcript is still judged by OpenAI.

After four rounds, a game below 300 points proceeds to a one-answer Sudden Death face-off. The winning family’s leader selects the Fast Money players. Invitations finish before faceoff buzzing opens, but the question may be interrupted by an early buzz. The first buzz cancels speech on all devices. If that answer is not number one, the other contestant hears the entire question before their clock starts. Every main-game answer has a server-enforced five-second deadline, including timeout strikes. Host speech gates all other turns, and unused answers reveal individually with the supplied ding.

The set uses the supplied Dawson-era stage reference with an interactive eight-slot flip board and dot-score displays. Fast Money uses the split black answer panels, contestant portrait, combined score, and lower timer from the TV reference. Questions are spoken, not shown during play; each response and score is revealed individually. Two hundred combined points wins $10,000, while a lower score wins $5 per point. Its questions are pre-generated once for both contestants to reduce speech-loading delays.

The stage background now uses an AI-enhanced 1464 × 1075 reconstruction of the reference. Richard’s introduction portrait has the old background removed and replaced with a clean maroon backdrop (not true transparency). Image prompts and asset paths are recorded in `assets/IMAGE_EDIT_NOTES.md`; original assets are preserved.

Faceoffs show the dedicated Dawson podium scene and live contestant photos. In TV host mode the display never shows a buzzer; the faceoff contestants buzz on their phones. Remote mode and solo tests show the scene and buzzer controls together. Successful answers briefly cut to the board for their reveal. If both initial contestants miss, the game advances to the next member of the first-buzzing family, then the next opposing member if needed. It continues down both family rosters (wrapping smaller families) without re-buzzing, retaining five-second limits and the full-question handoff. Question text stays out of visible status banners.

The optional greeting souvenir requires explicit adult/self-photo consent at join time. The historical scene and selected selfie are sent to OpenAI for one image edit, held in room memory, and labelled as a fictional AI edit. No consent means no image request. It is skipped on error; generated images expire with the room.

`npm test` runs real Socket.IO state-flow regression tests (including a real five-second timeout) and offline client/audio cancellation tests. Tests disable API calls; production image fidelity and real-device audio timing still require a live playthrough.

## Game package requirements

The generator creates four main-game surveys containing 7, 6, 5, and 4 answers. Rounds 1–2 score single points, round 3 double, and round 4 triple. It also creates five short Fast Money surveys. Every accepted answer contains explicit aliases; the server additionally applies conservative normalization and fuzzy matching.

This project is an unofficial, private home-game homage and is not affiliated with or endorsed by Family Feud or its owners.
