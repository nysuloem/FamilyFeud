#!/usr/bin/env python3
"""Extract tonal Dawson effects from the original broadcast clips.

Requires Python/numpy/scipy and ffmpeg. Run from any directory. Original assets
stay intact; output is used in both game eras. No generated oscillator audio.
"""
from pathlib import Path
import subprocess
import numpy as np
from scipy import signal

ASSETS = Path(__file__).resolve().parents[1] / 'public' / 'assets'
RATE = 24000
# Time bounds exclude applause/clicks and blank padding outside each actual cue.
# Frequencies were measured across the sustained portion of each recording.
EFFECTS = {
    'answer-ding': dict(start=.095, end=.685, tones=[1481, 2170, 2938, 4700], width=24, rms=.145),
    'strike-buzzer': dict(start=.165, end=.775, tones=[*range(120, 2401, 120), 1500, 1620, 1740, 3360], width=8, rms=.17),
    'faceoff-buzzer': dict(start=.555, end=1.195, tones=[565, 702, 1122, 1398, 1682, 2100, 2238, 2795, 3492, 4180, 4898], width=22, rms=.16),
}


def extract(name, settings):
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(ASSETS / f'{name}.mp3'),
                                   '-f', 'f32le', '-ac', '1', '-ar', str(RATE), '-'])
    original = np.frombuffer(raw, dtype='<f4')
    frequencies, times, spectrum = signal.stft(original, RATE, nperseg=2048, noverlap=1920, nfft=8192)
    # Smooth, narrow passbands retain the recording's phase, pitch drift and
    # amplitude envelope. Most applause/speech occupies the rejected bins.
    mask = np.zeros(len(frequencies))
    for tone in settings['tones']:
        distance = np.abs(frequencies - tone)
        band = np.exp(-.5 * (distance / settings['width']) ** 4)
        mask = np.maximum(mask, band)
    _, filtered = signal.istft(spectrum * mask[:, None], RATE, nperseg=2048, noverlap=1920, nfft=8192)
    start, end = [round(settings[k] * RATE) for k in ('start', 'end')]
    clean = filtered[start:end].copy()
    # Short fades remove edge clicks, without fading the entire buzzer away.
    attack, release = round(.004 * RATE), round(.025 * RATE)
    clean[:attack] *= np.sin(np.linspace(0, np.pi / 2, attack)) ** 2
    clean[-release:] *= np.cos(np.linspace(0, np.pi / 2, release)) ** 2
    gain = min(settings['rms'] / np.sqrt(np.mean(clean ** 2)), .88 / np.max(np.abs(clean)))
    clean *= gain
    output = ASSETS / f'dawson-{name}-clean.mp3'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1',
                    '-i', '-', '-ar', '48000', '-codec:a', 'libmp3lame', '-b:a', '128k', str(output)],
                   input=clean.astype('<f4').tobytes(), check=True)
    # This measures rejected spectral energy, not a claimed audience-only dB value.
    active = (times >= settings['start']) & (times <= settings['end'])
    before = np.sum(np.abs(spectrum[:, active]) ** 2)
    retained = np.sum(np.abs(spectrum[:, active] * mask[:, None]) ** 2)
    print(f'{output.name}: {len(clean)/RATE:.3f}s, peak {np.max(np.abs(clean)):.3f}, '
          f'retained {100*retained/before:.1f}% of original active-window spectral energy')


if __name__ == '__main__':
    for name, settings in EFFECTS.items():
        extract(name, settings)
