# Family Feud Home Game

A phone-controlled Family Feud game with Richard Dawson and Steve Harvey era presentations. It supports a shared-TV host display and fully remote play.

**Host on this screen** uses a 16:9 television frame. It scales uniformly to the available viewport (including 720p, 1080p, and 4K), with safe margins for captions and scene edges. Lobby, introductions, rounds, faceoffs, and Fast Money fit within that frame; scene images retain their original proportions. The modern Fast Money clock has reserved space below the board. Use **Full screen** on the host display to hide browser chrome. Only the shared display uses this layout; player phones and remote games keep their existing responsive layout.

Games support 2–10 players. If a one-player family reaches Fast Money, that player completes both timed halves.

## Solo Test Mode

Choose **Open Test Mode** on the home screen, select **Richard Dawson**, **Steve Harvey**, or **Surprise me**, then either **Test Introduction + Round 1** or **Test Fast Money**. No joining link, second device, or other player is required. The test creates two sample families, and you control the active contestant (including both faceoff buzzers and both Fast Money players).

The introduction test plays the normal opening sequence, runs one full round including strikes/steal/unrevealed answers, and stops there. Fast Money starts at player selection and includes both timed halves, both narrated reveals, and the payout. Use **Restart / switch test** at any time to return to the test setup, or **Exit test** to return to regular games.

Tests use fixed built-in surveys in separate rooms, without generating a new survey package or changing real games. The normal host audio, OpenAI judging, microphone input, and timers remain active. Optional: upload your own photo and explicitly consent to test the introduction souvenir too; otherwise sample avatars are used and no image edit is requested. API audio/judging/image usage still applies when configured. This is a solo rehearsal of the shared game flow, not a simulation of multiplayer network latency.

Fast Money automatically enables the active contestant's microphone (with browser permission) and keeps voice input enabled through that half, automatically restarting recognition after each host question. Recognition pauses during host speech so it cannot get stuck treating the player as part of the same utterance. Late transcripts from earlier questions are ignored. Players review the transcript and press **Submit**, or type instead; the mic can be muted or retried. The 45/60-second clock starts after the first question finishes, then continues through later questions. Questions are read without numbers. Both eras use filtered versions of the original correct-answer ding, strike buzzer, and faceoff buzzer to reduce broadcast audience noise. Each reveal rereads the question, shows the answer as “You said…” starts, then waits until “Survey says…” finishes before showing points with a ding for positive scores or the normal strike buzzer for zero.

Richard Dawson family introductions show one family at a time behind a gold oval name panel with surrounding bulbs. After the announcer says the family name, the panel slides aside to show the contestant photos and their names are announced before the next family appears.

Contestant names appear as oval badges over the chest area of their photos in the lobby, family introductions, main rounds, faceoffs, and Fast Money. Dawson badges are pale cream with dark lettering; Harvey badges are blue with gold trim and lettering. Names fit inside the badge without truncation, including after fonts load or the screen resizes. Badges are display overlays, so uploaded photos remain intact. Second-player Fast Money reveals still devote both columns to answers, without contestant portraits or badges.

## Prepared surveys and repeat protection

`data/survey-seeds.json` contains 240 original synthetic surveys (24 complete games: the original 12 plus 12 additional games), separate from the deliberately repeated test fixtures. Scores simulate survey counts for this home game; they are not collected survey results. The source prompts and ranked answers (short display label first, followed by accepted alternatives) are in `data/survey-seeds.txt`.

Board labels use compact wording of at most 18 characters in bundled and newly generated packs. Longer original answers and alternate wording stay in aliases for judging: for example, `SUN` accepts “gets too warm.” Startup also upgrades labels in existing available packs on `/data`, preserving their IDs, scores, questions, and used-question history. Both boards fit label text after reveals, font loading, and window resizing.

At startup the app imports each seed pack only once into `survey-bank.json`. The expansion uses new IDs (`starter-13` through `starter-24`), so existing `/data` volumes receive the additional packs while preserving every used pack and question history. Packs that overlap any previously generated survey history are skipped rather than recycled. Starting a regular game reserves one unused pack and persists its full question history **before** returning it. No live survey-generation request blocks the introduction. Optional souvenir generation also runs without holding up the start. History survives service restarts when the directory is on a persistent volume. All ten questions in a reserved pack are consumed, even if the game ends early or skips Sudden Death.

With an API key, the bank refills toward 12 ready packs after consumption and every five minutes. Generation receives the complete used/reserved question list; exact and strongly similar wording is rejected locally as well. Invalid output, repeated questions, or API failures stop that refill run without substituting the sample game. Exhaustion returns a clear message rather than replaying an old pack. Semantic novelty is also requested in the generator prompt; wording checks cannot prove that every possible paraphrase is unique. Previously generated questions from before this change have no stored history to recover.

Do not delete or reset the bank file to refill it: that would remove repeat protection. Malformed history fails explicitly instead of silently resetting. Back up the persistent volume.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. For phones on the same Wi-Fi, set `PUBLIC_URL` to the computer's LAN address (for example `http://192.168.1.20:3000`).

## Railway

Connect this repository to Railway. Optional variables:

- `OPENAI_API_KEY`: replenishes the prepared survey bank in the background. Without it, the 24 bundled games remain available once each; the app never recycles them when the bank is empty.
- `DATA_DIR`: survey-bank directory; defaults to the Railway volume mount path, then `/data` on Railway, or `.data` locally. Attach a persistent volume at `/data` on the FamilyFeud service. Without persistent storage, deployment/restart can erase usage history and reseed played packs. Use one server replica with this file-backed bank.
- `OPENAI_MODEL`: defaults to `gpt-5-mini`.
- `OPENAI_JUDGE_MODEL`: optional judging-model override; otherwise uses `OPENAI_MODEL` or `gpt-5-mini`.
- `OPENAI_IMAGE_MODEL`: optional personalized greeting-image model; defaults to `gpt-image-2`. One consenting adult is randomly selected, with one image-edit request per game. If unavailable, the normal host introduction continues.
- `PUBLIC_URL`: the public Railway URL, if Railway's forwarded host is unavailable.

With `OPENAI_API_KEY` configured, OpenAI replenishes and validates new game packages in the background, judges main-game and Fast Money answers (exact second-player matches and aliases are checked immediately), announces the families, and voices the host prompts and survey reveals. Players can either type or use the microphone button; voice recognition is performed by the browser and the resulting transcript is still judged by OpenAI.

After four rounds, a game below 300 points proceeds to a one-answer Sudden Death face-off. The winning family’s leader selects the Fast Money players. Invitations finish before faceoff buzzing opens, but the question may be interrupted by an early buzz. The first buzz cancels speech on all devices. If that answer is not number one, the other contestant hears the entire question before their clock starts. Faceoff and ordinary family answers have a server-enforced 15-second deadline. After strike two, the opposing family is told to get ready to steal. A steal begins with the host rereading the question and saying “Shout out some possible answers,” allows 30 seconds of discussion, then the host says “I need an answer” before a final three-second deadline. Answers remain accepted during that prompt. Typed answers survive the warning. Non-answering teammates can send a “Good Answer!” reaction once per turn; it appears at the top of every screen. All X effects use the supplied TV buzzer, trimmed to remove leading and trailing silence. Host speech gates all other turns, and unused answers reveal individually with the supplied ding.

The set uses the supplied Dawson-era stage reference with an interactive eight-slot flip board and dot-score displays. Fast Money uses a black board with pale yellow lettering and covered tile rows. Richard and the active contestant appear together below the board during timed play. Richard uses the supplied question-card-reading pose, restored and isolated from the broadcast overlays. The first reveal pairs the answer column with Richard’s arm-around-the-contestant composition; the second reveal uses both columns for answers with no portraits. The clock only appears during preparation and timed play, never during either reveal or the final result. Questions are spoken, not shown during play; each response and score is revealed individually. Two hundred combined points wins $10,000, while a lower score wins $5 per point. Its questions are pre-generated once for both contestants to reduce speech-loading delays.

The stage background now uses an AI-enhanced 1464 × 1075 reconstruction of the reference. Richard’s introduction portrait has the old background removed and replaced with a clean maroon backdrop (not true transparency). Image prompts and asset paths are recorded in `assets/IMAGE_EDIT_NOTES.md`; original assets are preserved.

Faceoffs show the dedicated Dawson podium scene and live contestant photos. In TV host mode the display never shows a buzzer; the faceoff contestants buzz on their phones. Remote mode and solo tests show the scene and buzzer controls together. Successful answers briefly cut to the board for their reveal. If both initial contestants miss, the game advances to the next member of the first-buzzing family, then the next opposing member if needed. It continues down both family rosters (wrapping smaller families) without re-buzzing, retaining 15-second limits and the full-question handoff. Question text stays out of visible status banners.

The optional greeting souvenir requires explicit adult/self-photo consent at join time. The historical scene and selected selfie are sent to OpenAI for one image edit, held in room memory, and labelled as a fictional AI edit. No consent means no image request. It is skipped on error; generated images expire with the room.

`npm test` runs real Socket.IO state-flow regression tests (including a real 15-second timeout) and offline client/audio cancellation tests. Tests disable API calls; production image fidelity and real-device audio timing still require a live playthrough.

## Game package requirements

The generator creates four main-game surveys containing 7, 6, 5, and 4 answers. Rounds 1–2 score single points, round 3 double, and round 4 triple. It also creates five short Fast Money surveys. Every accepted answer contains explicit aliases; the server additionally applies conservative normalization and fuzzy matching.

This project is an unofficial, private home-game homage and is not affiliated with or endorsed by Family Feud or its owners.

## Automatic flow and Fast Money retries

After the host finishes revealing a round, the game pauses for three seconds and advances automatically. This includes entering Sudden Death when required and moving into Fast Money. The team leader still chooses the two Fast Money players. Both Fast Money reveals automatically advance after three seconds, bringing in the second player or showing the final result. The introduction-only rehearsal still ends after round one.

Second-player Fast Money duplicates play the X buzzer and prompt “Try again!” without advancing the question or restarting the clock. Exact repeats and aliases are checked immediately; ambiguous wording has a 1.5-second AI check with the local matcher as fallback. Each retry starts a fresh answer/microphone window so stale transcripts and duplicate packets cannot be accepted. Nonduplicate answers submitted before time runs out still count if judging completes after the buzzer.

The playing family sees its current strike count on their phones during normal family play. It is hidden from opponents, the TV display, steals, and later stages. Each era’s supplied faceoff walkup recording plays softly under the host’s contestant invitation and stops before the question begins.


Host speech requests ask for a much more enthusiastic studio performance: audible smiles, bright projection, lively intonation, celebratory emphasis, and punchier reveals. Fast Money retains brisk, clear reading and short pauses. This direction applies to newly generated host audio; browser speech synthesis remains the fallback when API speech is unavailable.


## Two eras

Each regular room makes one unbiased 50/50 server-side choice between Richard Dawson and Steve Harvey. The choice is shared with every display and phone and remains fixed through reconnects, all rounds, and Fast Money. Test rooms can explicitly choose either era; existing test requests default to Dawson. Both eras draw from the same persistent survey bank, so switching eras cannot replay a used pack.

Harvey opens with the supplied recording (with its final half-second trimmed) and the supplied smiling Steve portrait, lets that recording introduce Steve once, then introduces each family. Family lineups use the modern blue set instead of Dawson's sliding gold oval. The main board uses blue/chrome answer panels and white numerals; faceoffs use the supplied modern podium reference with only the first-buzzing side illuminated. Fast Money uses black answer cells on a blue board, a contestant portrait for the first reveal, and both answer columns for the second. Timers remain hidden during reveals. The modern strike overlay uses large red beveled frames.

This update changes presentation and introduction order. Both eras currently retain the home's established rules, including 15-second round answers, the 30-second steal discussion plus host warning, 45/60-second Fast Money, and the $10,000 prize. AI host speech and family/host announcements use **Onyx** for Dawson games and **Echo** for Harvey games, including preloaded Fast Money questions. Speech directions name the selected period without imitating the real host's voice. The optional Dawson greeting souvenir runs only in the Dawson era, even if a player previously opted in. The supplied Harvey intro is used only for the opening; Harvey faceoff invitations use the separately supplied modern walkup music.

Harvey assets and edit prompts are recorded in `assets/HARVEY_ASSET_NOTES.md`. Live TV/phone appearance and timing should be checked using the new Harvey test selector; automated tests validate era persistence, intro ordering, board secrecy, and the shared game flow.
