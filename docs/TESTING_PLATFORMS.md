# Testing Nutq on other systems

Nutq is tested on Linux with Chrome and Firefox. macOS, Windows and Safari are untested. If you run it on one of those,
this checklist takes about ten minutes and tells us what works. You need a microphone and a ZeroClaw gateway you can
pair with (see the README).

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

Open an issue at https://github.com/SHIZA-OS/nutq/issues with your results. Include anything odd even if every step worked,
such as a voice that sounded wrong or a long delay.
