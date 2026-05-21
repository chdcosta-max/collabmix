# Mix//Sync Features Pipeline

Features identified during today's strategic session. Not committed to building all of these, but documented as roadmap candidates.

## Features Powered by Rekordbox Import

These require the Rekordbox import feature (Phase 3) to be built first.

### Smart Cue Suggestions
Analyze user's cue points across library → identify patterns → suggest mix-in points based on user's personal style. Personalized.

### Harmonic Compatibility (Camelot Wheel)
Use key data to highlight compatible tracks for next mix. Color-coded warnings for incompatible keys.

### Phrase-Aware Sync
Auto-align drops between two decks during B2B sync. Snap mix transitions to phrase boundaries.

### Mix Prediction Overlay
Show optimal mix points based on both tracks' phrase structures.

### Energy/Mood Visualization
Heat map overlay on waveform showing energy intensity throughout track.

## Features Powered by Signal Processing (Already Built)

The Phase 1-3 analyzer code (Bass continuity, Chroma novelty, SSM novelty) is dormant in the codebase. Available for these uses:

### Per-Track Confidence Scoring
Signal agreement → user-facing "high/medium/low confidence" indicator on each track. Helps users know when to verify analyzer output.

### Structural Waveform Visualization
SSM novelty already detects phrase boundaries. Overlay colored sections in waveform: intro, build, drop, break, outro. Pro-level visual context.

### Key Detection Improvement
Chroma analysis can extract harmonic content. Could improve existing key detection accuracy.

### Mix Point Suggestions
Phrase boundary detection from SSM enables: "Next compatible mix point: bar 65 (start of break)."

### Genre/Style Classification (long-term)
14-dim feature vectors per beat could feed ML classifier. Detect track style automatically.

## B2B-Specific Differentiation Features

Things no other DJ tool can do — this is Mix//Sync's strategic moat.

### Collaborative Cue Points
See each other's hot cues in real-time. Sync cue point creation across partners.

### Mix Prediction Overlay (Collaborative)
Show optimal mix points based on both DJs' current tracks. Visual hint for both decks.

### Phrase-Aware B2B Sync
Auto-align drops between decks, not just beats. Match phrases automatically.

### Harmonic Compatibility Warnings
Alert when next track would clash with current key. Cross-deck.

### Collaborative Set Planning
Build playlists together before/during sessions. Shared planning interface.

### Mix History Recording
Save B2B sessions for replay/share. Listen back to your performances.

### Latency Compensation
Make remote B2B feel like same room. Sub-100ms perceived latency.

## Visual Upgrade Features

### Multi-Band Frequency Waveforms
Blue/Cyan: Lows 20-250Hz. Orange/Red: Mids 250-2500Hz. White/Yellow: Highs 2500-20000Hz. Bar height = energy. Color proportions = frequency distribution.

### Section/Phrase Markers
Visible intro/drop/break sections on waveform. Color-coded.

### Cue Point Markers
Colored, labeled, beautiful markers from Rekordbox import.

### Beat Grid Hierarchy
Thin lines for beats, medium for bars, thick for 16-bar phrases.

### Subtle Breathing Animation
Waveform reacts subtly while playing. Alive but not distracting.
