// Replays an end-of-turn policy on a recorded stream (one case at one phase, from replay-commits.mjs --streams) without
// running the model again. It mirrors the replay's own loop: after frame k - 1 has been processed (its events and
// commits applied, in the order they happened) the commits whose modelled model run has finished are handed to the policy,
// then the policy is asked about time k * 32 ms. It runs in a page, with the real TurnPolicy of src/turn-policy.ts passed
// in, so there is no second copy of the policy to drift.
//
// stream: { nFile, seq } where seq is nondecreasing in frame f and holds { k: "start" | "end" | "misfire", f } and
// { k: "commit", f, samples, skipped, text }. Returns { endMs, trigger, sentText }.
// - endMs: when the turn ended; "manual" means no auto-silence did, and the turn runs to the end of the file plus the
//   312 grace frames of the replay.
// - sentText: the text of the commits fired before the end (all of them for a manual stop). The flush that stop() does at
//   an earlier end is NOT modelled (it needs the model on the buffered audio), so a send that only exists because of that
//   flush is missed; the real replay confirms the candidates that matter.
export const FRAME_MS = 32;
export const GRACE_FRAMES = 312; // the replay feeds silence this long after the file, as run-wer.mjs waits

// mk() returns a fresh TurnPolicy; latencyMs(samples, scale) is the modelled model run time of a commit.
export function simulate(stream, mk, latencyMs, scale) {
  const { nFile, seq } = stream;
  const limit = nFile + GRACE_FRAMES;
  const policy = mk();
  const texts = [];
  const queue = [];
  let finish = 0;
  let inflight = 0;
  let i = 0;
  let k = 1;
  let ended = null;
  let endBoundary = limit;
  while (k <= limit) {
    // frame k - 1 has been processed
    while (i < seq.length && seq[i].f === k - 1) {
      const e = seq[i++];
      const at = e.f * FRAME_MS;
      if (e.k === "start") policy.speechStart(at);
      else if (e.k === "end") policy.speechEnd(at);
      else if (e.k === "misfire") policy.misfire(at);
      else if (!e.skipped) {
        finish = Math.max(finish, at) + latencyMs(e.samples, scale);
        queue.push({ arrive: finish, text: e.text });
        policy.setCommitsInFlight(++inflight, at);
      }
    }
    const now = k * FRAME_MS;
    while (queue.length && queue[0].arrive <= now) {
      const q = queue.shift();
      if (q.text) {
        texts.push(q.text);
        policy.transcript(texts.join(" "), q.arrive);
      }
      policy.setCommitsInFlight(--inflight, q.arrive);
    }
    ended = policy.tick(now);
    if (ended) {
      endBoundary = k;
      break;
    }
    // the next boundary where anything can change: an event, a delivery, or the deadline
    let next = limit + 1;
    if (i < seq.length) next = Math.min(next, seq[i].f + 1);
    if (queue.length) next = Math.min(next, Math.ceil(queue[0].arrive / FRAME_MS));
    const ea = policy.endsAt();
    if (ea !== null) next = Math.min(next, Math.ceil(ea / FRAME_MS));
    k = Math.max(k + 1, next);
  }
  const auto = ended !== null;
  const sent = seq.filter((e) => e.k === "commit" && !e.skipped && (auto ? e.f < endBoundary : true) && e.text).map((e) => e.text);
  return { endMs: auto ? ended.at : limit * FRAME_MS, trigger: auto ? "auto_silence" : "manual", sentText: sent.join(" ") };
}
