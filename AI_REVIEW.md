# AI Review of video proof

The coach app watches every video an athlete sends with a score, checks it against the rules for that test, and shows
what it found under the video on the Pending page. It never decides anything an athlete sees: the coach approves or
rejects every submission, and each decision is stored next to the AI's review so the AI can learn from it.

## Where it runs

`AiReviewService` starts with the coach app. While any copy of the coach app is open (the Mac or the iPad) it works
through the queue on its own:

1. every video on a submission that is waiting for the coach, oldest first;
2. then the videos on submissions the coach has already decided, to learn from.

Two open copies do not review the same video: a review in progress holds a heartbeat, and one silent for 90 seconds is
taken over.

## What it checks

The pose model is Google's MediaPipe Pose Landmarker (`src/assets/ai/pose_landmarker_full.task`), run in the browser.
It finds 33 body landmarks in about ten frames a second. Everything after that is arithmetic in `src/app/ai/analyze.ts`.

| Test | Checks |
| --- | --- |
| Deadlift | reps (from the hip angle), hips and knees locked out, bar starts from the floor, bar speed |
| Squat | reps (knee angle), hip crease below the knee, standing fully upright, bar speed |
| Bench press | reps (elbow angle), bar to the chest, arms locked out, hips stay on the bench, bar speed |
| Push-ups | reps, elbows to 90 degrees, lockout, straight body, no pauses |
| Pull-ups | reps, full hang, chin over the bar, no kipping, no pauses |
| Long jump | take-off and landing seen, two feet, distance measured against the claim |
| 100 m and 400 m | the video is at least as long as the time claimed, running seen |
| Pike, backbend | the position held for five seconds, the reach the claimed score needs |

Every video is also checked for: the athlete being in frame, cuts (a frame that changes far more than its neighbours),
the same footage sent before (a fingerprint of five frames compared with every earlier video), progress far faster than
training usually allows since the last verified result, lifts beyond elite for body weight, and lifts out of line with
the athlete's other lifts.

Reps are read from joint angles, not from where the hands or the bar are, so a rack upright or a plate hiding the hands
does not matter, and neither does the camera's distance.

## Weight (checked first)

On every lift the first check is the weight: what the video suggests the bar held, against what was claimed, with a
range, shown at the top of the panel. Everything is this app's own code and data, and nothing is sent to any outside
service.

1. **Bar speed.** The plates are followed through the video (their colours, red, yellow and blue), so the bar's own rise
   gives its speed. Near a true max the bar moves slowly, which against the athlete's best verified result gives a
   weight. This can **doubt** a claim (a claim far above the estimate fails the check) but cannot **confirm** one: a
   slow, controlled pull looks like a heavy one. So a match on speed alone is reported as "can't confirm", not a pass.
2. **A learned correction.** Under every video the coach can enter the real weight on the bar; approving a lift also
   counts. Once there are 8 confirmed weights, a ridge regression on the bar speed and what the plates looked like
   (their colours and how much of the frame they fill) is trained on the lifts submitted here, from every gym and every
   brand of plate (`aiModels/weight`). It is used only when it beats the plain speed estimate on held-out lifts, and the
   AI Review page shows both errors.

Reading the plates directly, so a 365 lb bar cannot be claimed as 475, needs a model trained on a lot of confirmed
lifts: plates differ by brand and country (kilograms or pounds, colour codes, stamped numbers), so no fixed list works.
Every lift the coach confirms adds to that training set. Until it is large enough the weight check is a hint and the
coach's eyes on the plates are the check.

The other signals (fatigue across reps, progress, body weight, balance with the athlete's other lifts, cuts, reused
footage) follow as separate checks. A rep counts only if the bar went up with the lifter, so setting the bar down and
standing up again is not a second rep.

## Learning

Each review stores a fixed vector of what it measured (`LEARN_FEATURES`). Whenever the coach decides a submission, a
logistic regression is retrained on every decided review (`src/app/ai/learn.ts`) and saved in `aiModels/global`, with
its held-out accuracy and the accuracy of the rules alone on the same reviews. The model starts shaping verdicts only
once it has 20 decisions, at least 5 approved and 5 rejected, and beats the rules. The AI Review page shows all of it.

## Data

- `aiReviews/{submissionId}_{slot}`: one per video: the checks, measurements, estimates, verdict, stills, fingerprints,
  and the coach's decision once made.
- `aiHashes/{same id}`: just the fingerprints, for the duplicate search.
- `aiModels/global`: the current learned model.

## At scale

Running in an open coach app suits the first few thousand videos. For millions:

1. **On the phone.** The same analysis runs on the athlete's phone as the video is recorded (MediaPipe runs natively on
   iOS), and only the measurements are uploaded. The server re-checks a sample.
2. **On a server.** The same `analyze.ts` runs in a Cloud Run or Cloud Function job triggered by each new submission,
   with the pose model on a GPU worker.
3. **Plates.** Train a small plate detector and reader on the confirmed lifts (the stills and their weights) once there are thousands.
4. **Auto-approval** comes last: only for tests where the model's held-out agreement with the coach is very high, only
   for confident "likely valid" calls, and never automatic rejection.
