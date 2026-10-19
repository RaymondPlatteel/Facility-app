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

## Weight

The video cannot read the plates by itself yet, so the weight is judged from several independent signals:

- **Bar speed.** Near a true max the bar moves slowly (about 0.2 m/s on a deadlift). A new best lifted fast suggests
  lighter plates. Speed is measured against the athlete's own body in the same frame (shin or arm length), so a drifting
  handheld camera does not change it, and only when the whole rep is on camera. It can raise a question but never fail
  a lift on its own.
- **Fatigue.** In a hard set the reps slow down; reps that stay fast to the end suggest a light load.
- **Progress, body weight and balance** (above).
- **The plates.** Three stills (start, middle, end) under every video, and the coach's one-tap "looks right" or
  "doubtful" label. Those labels are the training data for a plate-reading model later.

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
3. **Plates.** A small object detector trained on the stills the coach has labelled reads the plate colours and sizes.
4. **Auto-approval** comes last: only for tests where the model's held-out agreement with the coach is very high, only
   for confident "likely valid" calls, and never automatic rejection.
