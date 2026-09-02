# Steve Harvey era assets

These are AI-assisted edits of the supplied television references for the private home game. Dynamic contestants, answers, names and scores are rendered by the application.

- `public/assets/harvey-stage.png`: restored wide stage, Steve retained, broadcast contestants and static scores removed.
- `public/assets/harvey-faceoff.png`: Steve and the modern twin podiums, with both broadcast contestants removed. Used for faceoffs.
- `public/assets/harvey-intro.mp3`: audio extracted from the supplied Screen Recording 2026-09-02 062132.mov, starting at 0.55 seconds for 23.85 seconds to remove leading/trailing silence. The resulting intro was subsequently shortened by another 0.5 seconds at the end (23.35 seconds of decoded audio, plus MP3 framing). No video is shipped.
- Mode: built-in image editor, two independent reference edits. Original uploads remain unchanged.

## Stage prompt

Use case: precise-object-edit. Image 1 is the EDIT TARGET: a modern Steve Harvey Family Feud stage. Restore this exact stage cleanly at high resolution preserving framing, blue light architecture, central oval bulb board, chrome family podiums, reflective floor and Steve Harvey at center in his tan suit. Remove all contestants from both family podiums and fill their spaces with the original set behind them. Remove all family names and all answer text, cover numbers, and numerical scores from the board and podium displays, leaving clean blue display surfaces. Preserve Steve, his recognizable face and outfit and position. No new people, no new lettering. This will be a game background with real players and live score and answer elements overlaid separately. Wide landscape original composition, no modern redesign.

## Faceoff prompt

Use case: precise-object-edit. Image 1 is the EDIT TARGET, Steve Harvey at the modern Family Feud faceoff podium. Remove ONLY the two contestants on left and right and fill their spaces naturally with continuation of the blue lit studio backdrop. Preserve Steve Harvey centered in his black suit, exact face identity, moustache, downward gaze, both hands and question card, the wood-and-chrome twin podiums, both microphones and bulb panels, and the original framing and perspective. Enhance clarity for a large game display. Remove the small video UI symbols and channel watermark. Retain the Family Feud logo on Steve's card. No new people or software UI. Wide landscape image.


- `public/assets/harvey-intro-portrait.png`: the user-supplied smiling Steve Harvey photo, used directly and shown without cropping at both desktop and mobile sizes.
