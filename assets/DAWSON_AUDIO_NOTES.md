# Dawson sound-effect cleanup

The three `public/assets/dawson-*-clean.mp3` files are filtered extractions from
the existing user-supplied broadcast recordings. Both eras now use these cleaned clips,
including correct answers, strikes/zero-point reveals, duplicate-answer retries,
and the faceoff button. The original unfiltered assets are retained only
as source material for future adjustments. The other effects (round, reveal,
Fast Money cue, and win) are synthesized tones and contain no recorded audience.

| Source | Clean output | Source interval |
| --- | --- | --- |
| answer-ding.mp3 | dawson-answer-ding-clean.mp3 | 0.095–0.685 s |
| strike-buzzer.mp3 | dawson-strike-buzzer-clean.mp3 | 0.165–0.775 s |
| faceoff-buzzer.mp3 | dawson-faceoff-buzzer-clean.mp3 | 0.555–1.195 s |

`python scripts/clean-dawson-effects.py` reproduces the files using numpy, scipy
and ffmpeg. It retains narrow frequency bands around the original effect's
measured tones and harmonics, retaining their recorded phase and pitch drift.
Noise outside those bands is rejected. Trimming removes applause/clicks before
the actual cue, and brief fades avoid abrupt edges. The faceoff recording's
leading delay and the ding's two seconds of blank padding are removed.

Outputs are mono MP3 at 48 kHz/128 kbps, with matched effect levels and ample
peak headroom. No oscillator replacement, voice enhancement, or speech model
was used. Perfect source separation is not claimed: crowd energy coinciding
with a retained frequency can remain, and narrow filtering changes some timbre.
Checks cover decoding, duration, finite samples, peak headroom, spectral plots,
era-specific playback routing and mute behavior. Subjective listening on the
actual TV/phone speakers remains the final sound-quality check.
