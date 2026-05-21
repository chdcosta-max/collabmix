# Mix//Sync Library Import Strategy

## Critical UX Principle

Users should NEVER hunt folders or upload files one by one. Friction here means abandoned product.

## Priority 1: Rekordbox Import

Highest value. Most pro/intermediate DJs use Rekordbox. Importing their existing library = immediate value.

### Technical Foundation (Already Proven)
- pyrekordbox library reads Rekordbox database
- Can extract: beat grids, BPM, cue points, hot cues, phrase markers
- Tested on user's 272 analyzed tracks during analyzer development

### Implementation Options to Investigate

**Option A: Tauri-wrapped desktop version**
- Pros: Full filesystem access, native feel, runs anywhere
- Cons: Distribution complexity, users need to install
- Effort estimate: medium-high

**Option B: File System Access API**
- Modern Chrome/Edge browser feature
- User grants permission to read Rekordbox folder
- Pros: No installation needed, web-native
- Cons: Chrome/Edge only (Safari/Firefox not supported)
- Effort estimate: medium

**Option C: Native Mac/Windows companion app**
- Small app that reads Rekordbox DB, sends to Mix//Sync web app
- Pros: Web-native UX, helper handles native access
- Cons: Two-app complexity
- Effort estimate: medium-high

**Option D: Drag entire Rekordbox folder into browser**
- User drags ~/Library/Pioneer/rekordbox folder onto Mix//Sync
- Browser reads files from drag-drop API
- Pros: Simple UX, works in all browsers
- Cons: User has to know where folder is, one-time setup
- Effort estimate: low-medium

### Recommended Investigation
Test Option B (File System Access API) first — most modern, web-native approach. Fall back to Option D if browser support too limited.

### What Gets Imported
- File paths (music stays where it is)
- Beat grids (BPM, downbeat positions)
- Cue points (memory cues + hot cues 1-8)
- Phrase markers (intro/build/drop/break)
- Track metadata (key, rating, color tags, comments)
- Play counts, dates added

## Priority 2: iTunes/Apple Music Import

More mainstream users have iTunes libraries.

- iTunes Library.xml format well-documented
- Easier to access than Rekordbox (XML vs SQLCipher-encrypted SQLite)
- No beat grids/cues but full metadata
- Implementation: similar to Rekordbox but simpler

Effort estimate: low (5-7 hours)

## Priority 3: Drag-Folder Fallback

For users without Rekordbox or iTunes.

- Drag music folder into browser
- Mix//Sync scans, analyzes, builds library
- Smart organization (by artist, BPM, etc.)
- Uses our analyzer for beat grids/BPM
- Slower (analysis takes time per track)

Effort estimate: medium

## User Experience Flow

### Ideal first-time experience:
1. User opens Mix//Sync
2. "Connect your library" screen
3. Three options visible: Rekordbox / iTunes / Drag folder
4. User selects → grants permission → library appears
5. Progress with personality: "Importing 247 tracks..."
6. Each track appears with subtle animation
7. Done state clear: "Ready to mix"

### Persistence
- Library connection remembered across sessions
- Auto-detect changes to Rekordbox library (new tracks, updated grids)
- Sync on demand or automatically
