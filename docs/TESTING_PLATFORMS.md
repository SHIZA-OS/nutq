# Testing Nutq on other systems

Nutq is tested on Linux (Chrome, Firefox) and Windows (Chrome, Edge, Firefox). Firefox on Linux only has system voices,
which sound robotic; Chrome is recommended there. macOS and Safari are untested. If you run it on a system marked untested
below, this checklist takes about ten minutes and tells us what works. You need a microphone and a ZeroClaw gateway you can
pair with (see the README).

## Results so far

Checked by hand by the maintainer. Browser voices come from the operating system or the browser vendor's online service, so
Firefox sounds good on Windows but robotic on Linux.

| System | Browser | Voice quality | Notes |
|---|---|---|---|
| Linux | Chrome | clear | |
| Linux | Firefox | robotic | espeak system voices; a plain voice was chosen; the hint was shown |
| Windows | Chrome | clear | |
| Windows | Edge | clear | |
| Windows | Firefox | clear | |
| macOS | Safari | untested | |
| macOS | Chrome, Firefox | untested | |

Only voice quality was recorded in this table; the other steps below were not.

## Checklist

Record the operating system and version, the browser and version, and for each step below: works, works with a problem
(say what), or fails (say what you saw, and any error from the browser console).

1. **Load.** `npm install`, `npm run dev`, open http://localhost:5173. The page appears with its fonts, and the browser
   console shows no errors.
2. **Pair.** Enter the gateway URL and agent alias, enter a 6-digit pairing code and click Pair. Either the status reads
   "paired", or a `curl` command appears (that is the expected fallback when the page and the gateway are on different
   origins); run it, paste the token, click Save token.
3. **Connect.** Click Connect. The speech model loads (about 63 MB; note how long it took). The connection status reads
   "connected" and the microphone button enables with the hint "Tap to start listening".
4. **Speak.** Allow the microphone when the browser asks. Tap the microphone and say a short question. Your words appear
   under "Live transcript", then under "STT (committed)". Tap again, or stop talking and wait a moment: the question is sent.
5. **Reply heard.** The agent's answer appears under "TTS (ZeroClaw response)" and is spoken aloud, sentence by sentence.
6. **Mic tap mutes.** Ask something that gets a long answer. While the answer is being spoken, tap the microphone: the
   speech stops at once.
7. **Hold and send.** Ask a long-answer question again. While the answer is still coming in, tap the microphone, ask a second
   question and finish it. The hint reads "Will send when the answer finishes", and the second question is sent when the
   first answer ends.

## Voice checklist

Do this once per browser (Chrome, Edge, Firefox, Safari), after step 5 above. Record the browser and operating system with it.

1. **Voice chosen.** Open the Logs panel. It lists the voices and says `Reply voice: <name> (ranked)`. Note the name and
   whether it sounds like a clear, natural voice or a robotic one when it speaks in step 5. If the log says `lang_only`, the
   browser listed no English voice; say so.
2. **Menu works.** Under the microphone, the Reply voice menu starts at "Automatic (best available)" and lists English
   voices only, as "name (lang)". Choose another voice, then reload the page: the menu still shows it, and the next reply uses
   it. Choose Automatic again: the saved choice is cleared. If the browser lists no voices at all, the menu is disabled and
   reads "Browser default".
3. **Test voice works.** Press Test voice: one short sentence is spoken with the chosen voice. Press the microphone while it
   speaks: it stops. Ask a question and press Test voice while the answer is still coming: nothing happens.
4. **Hint appears only where expected.** The line "This browser only has system voices, which can sound robotic. Chrome or
   Edge give a clearer voice." should show only when every English voice the browser lists is an espeak voice. Seen so far:
   the hint on Firefox on Linux. Not recorded for the other systems in the table. Report a hint where you have a good voice,
   or no hint where every voice is robotic.
5. **`?voice=`.** Add `?voice=<exact name>` (copy a name from the log): that voice speaks, and the menu is disabled while the
   name matches.

Open an issue at https://github.com/SHIZA-OS/nutq/issues with your results. Include anything odd even if every step worked,
such as a voice that sounded wrong or a long delay.
